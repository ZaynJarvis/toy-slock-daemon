import path from 'path';
import os from 'os';
import { mkdir, writeFile, access, rm } from 'fs/promises';
import type { Driver, AgentConfig } from '../../drivers/types.js';
import { getDriver } from '../../drivers/index.js';
import { logger } from '../../logger.js';
import { WorkspaceService } from '../workspace/WorkspaceService.js';
import { SkillsService } from '../skills/SkillsService.js';
import {
  AgentProcess,
  IdleAgentEntry,
  DATA_DIR,
  MAX_TRAJECTORY_TEXT,
  TRAJECTORY_COALESCE_MS,
  ACTIVITY_HEARTBEAT_MS,
  PROCESS_ALIVE_HEARTBEAT_MS,
  formatChannelLabel,
  formatIncomingMessage,
  buildUnreadSummary,
  formatCrashReason,
  summarizeCrash,
  isMissingResumeSession,
  getMessageDeliveryText,
  pushRecentStdout,
  pushRecentStderr,
} from './types.js';

/** Max consecutive crash retries before marking inactive */
const MAX_CRASH_RETRIES = 3;
/** Base delay (ms) for exponential backoff on crash retry */
const CRASH_RETRY_BASE_MS = 5_000;

export class AgentProcessManager {
  agents: Map<string, AgentProcess> = new Map();
  agentsStarting: Set<string> = new Set();
  startingInboxes: Map<string, any[]> = new Map();
  /** Cached configs for agents whose process exited normally — enables auto-restart on next message */
  idleAgentConfigs: Map<string, IdleAgentEntry> = new Map();
  /** Consecutive crash count per agent — reset on successful exit (code 0) */
  private crashRetries: Map<string, number> = new Map();

  private chatBridgePath: string;
  private sendToServer: (msg: any) => void;
  private daemonApiKey: string;
  private dataDir: string;
  private driverResolver: (runtimeId: string) => Driver;
  private workspaceService: WorkspaceService;
  private skillsService: SkillsService;

  constructor(
    chatBridgePath: string,
    sendToServer: (msg: any) => void,
    daemonApiKey: string,
    opts: { dataDir?: string; driverResolver?: (runtimeId: string) => Driver } = {},
  ) {
    this.chatBridgePath = chatBridgePath;
    this.sendToServer = sendToServer;
    this.daemonApiKey = daemonApiKey;
    this.dataDir = opts.dataDir || DATA_DIR;
    this.driverResolver = opts.driverResolver || getDriver;
    this.workspaceService = new WorkspaceService(this.dataDir);
    this.skillsService = new SkillsService(this.dataDir);
  }

  async startAgent(
    agentId: string,
    config: AgentConfig,
    wakeMessage?: any,
    unreadSummary?: Record<string, number>,
    resumePrompt?: string,
    launchId?: string,
  ): Promise<void> {
    if (this.agents.has(agentId)) {
      logger.info(`[Agent ${agentId}] Start ignored (already running)`);
      return;
    }
    if (this.agentsStarting.has(agentId)) {
      logger.info(`[Agent ${agentId}] Start ignored (startup in progress)`);
      return;
    }
    this.agentsStarting.add(agentId);
    try {
      const driver = this.driverResolver(config.runtime || 'claude');
      const agentDataDir = path.join(this.dataDir, agentId);
      await mkdir(agentDataDir, { recursive: true });

      const memoryMdPath = path.join(agentDataDir, 'MEMORY.md');
      try {
        await access(memoryMdPath);
      } catch {
        const agentName = config.displayName || config.name;
        const initialMemoryMd = `# ${agentName}\n\n## Role\n${config.description || 'No role defined yet.'}\n\n## Key Knowledge\n- No notes yet.\n\n## Active Context\n- First startup.\n`;
        await writeFile(memoryMdPath, initialMemoryMd);
      }

      await mkdir(path.join(agentDataDir, 'notes'), { recursive: true });

      const isResume = !!config.sessionId;
      let prompt: string;

      if (isResume && resumePrompt) {
        prompt = resumePrompt;
        if (driver.supportsStdinNotification) {
          prompt += `\n\nNote: While you are busy, you may receive [System notification: ...] messages. Finish your current step, then call check_messages to check for messages.`;
        }
      } else if (wakeMessage) {
        const channelLabel = formatChannelLabel(wakeMessage);
        prompt = `New message received:\n\n${formatIncomingMessage(wakeMessage)}`;
        if (unreadSummary && Object.keys(unreadSummary).length > 0) {
          const otherUnread = Object.entries(unreadSummary).filter(([key]) => key !== channelLabel);
          if (otherUnread.length > 0) {
            prompt += `\n\nYou also have unread messages in other channels:`;
            for (const [ch, count] of otherUnread) {
              prompt += `\n- ${ch}: ${count} unread`;
            }
            prompt += `\n\nUse read_history to catch up, or respond to the message above first.`;
          }
        }
        prompt += `\n\nRespond as appropriate \u2014 reply using send_message, or take action as needed. Complete ALL your work before stopping.\n\nIMPORTANT: If the message requires multi-step work (e.g. research, code changes, testing), complete ALL steps before stopping. Sending a progress update does NOT mean your task is done \u2014 only stop when you have NO more work to do. ${getMessageDeliveryText(driver.supportsStdinNotification)}`;
        if (driver.supportsStdinNotification) {
          prompt += `\n\nNote: While you are busy, you may receive [System notification: ...] messages. Finish your current step, then call check_messages to check for messages.`;
        }
      } else if (isResume && unreadSummary && Object.keys(unreadSummary).length > 0) {
        prompt = `You have unread messages from while you were offline:`;
        for (const [ch, count] of Object.entries(unreadSummary)) {
          prompt += `\n- ${ch}: ${count} unread`;
        }
        prompt += `\n\nUse read_history to catch up on the channels listed above, then stop. Read each listed channel at most once unless a read fails. Do NOT call check_messages in this mode. If the history reveals a direct request, assignment, @mention, review request, or task clearly addressed to you, switch into active handling instead of stopping: reply with send_message and claim the relevant task before starting work. Otherwise, do NOT send any message in this mode. ${getMessageDeliveryText(driver.supportsStdinNotification)}`;
      } else if (isResume) {
        prompt = `No new messages while you were away. Nothing to do \u2014 just stop. ${getMessageDeliveryText(driver.supportsStdinNotification)}`;
        if (driver.supportsStdinNotification) {
          prompt += `\n\nNote: While you are busy, you may receive [System notification: ...] messages about new messages. Finish your current step, then call check_messages to check for messages.`;
        }
      } else {
        prompt = driver.buildSystemPrompt(config, agentId);
      }

      const { process: proc } = driver.spawn({
        agentId,
        config,
        prompt,
        workingDirectory: agentDataDir,
        chatBridgePath: this.chatBridgePath,
        daemonApiKey: this.daemonApiKey,
      });

      const agentProcess: AgentProcess = {
        process: proc,
        driver,
        inbox: this.startingInboxes.get(agentId) || [],
        config,
        sessionId: config.sessionId || null,
        launchId: launchId || null,
        isIdle: false,
        notificationTimer: null,
        pendingNotificationCount: 0,
        activityHeartbeat: null,
        processAliveTimer: null,
        lastActivity: '',
        lastActivityDetail: '',
        recentStdout: [],
        recentStderr: [],
        lastRuntimeError: null,
        spawnError: null,
        exitCode: null,
        exitSignal: null,
        pendingTrajectory: null,
      };

      this.startingInboxes.delete(agentId);
      this.agents.set(agentId, agentProcess);
      this.agentsStarting.delete(agentId);

      let buffer = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        const chunkText = chunk.toString();
        const current = this.agents.get(agentId);
        if (current) {
          current.recentStdout = pushRecentStdout(current.recentStdout, chunkText);
        }
        buffer += chunkText;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const events = driver.parseLine(line);
          for (const event of events) {
            this.handleParsedEvent(agentId, event, driver);
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (!text) return;
        if (/Reconnecting\.\.\.|Falling back from WebSockets/i.test(text)) return;
        const current = this.agents.get(agentId);
        if (current) {
          current.recentStderr = pushRecentStderr(current.recentStderr, text);
        }
        logger.error(`[Agent ${agentId} stderr]: ${text}`);
      });

      proc.on('error', (err: Error) => {
        const current = this.agents.get(agentId);
        if (current) current.spawnError = err.message;
        logger.error(`[Agent ${agentId}] Process error: ${err.message}`);
      });

      proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        const current = this.agents.get(agentId);
        if (current && current.process === proc) {
          current.exitCode = code;
          current.exitSignal = signal as string | null;
        }
        logger.info(`[Agent ${agentId}] Process exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
      });

      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.agents.has(agentId)) {
          const ap = this.agents.get(agentId)!;
          if (ap.process !== proc) return;

          if (ap.notificationTimer) {
            clearTimeout(ap.notificationTimer);
          }
          if (ap.pendingTrajectory?.timer) {
            clearTimeout(ap.pendingTrajectory.timer);
          }
          if (ap.activityHeartbeat) {
            clearInterval(ap.activityHeartbeat);
          }
          if (ap.processAliveTimer) {
            clearInterval(ap.processAliveTimer);
          }

          this.agents.delete(agentId);

          const finalCode = ap.exitCode ?? code;
          const finalSignal = ap.exitSignal ?? (signal as string | null);

          if (finalCode === 0) {
            // Successful turn — reset crash counter
            this.crashRetries.delete(agentId);

            const queuedWakeMessage = !ap.driver.supportsStdinNotification
              ? ap.inbox.shift()
              : undefined;
            const unreadSummary2 = queuedWakeMessage
              ? buildUnreadSummary(ap.inbox, formatChannelLabel(queuedWakeMessage))
              : undefined;

            if (queuedWakeMessage) {
              logger.info(`[Agent ${agentId}] Turn completed; restarting immediately for queued message`);
              const nextConfig = { ...ap.config, sessionId: ap.sessionId };
              this.idleAgentConfigs.set(agentId, {
                config: nextConfig,
                sessionId: ap.sessionId,
                launchId: ap.launchId,
              });
              this.broadcastActivity(agentId, 'working', 'Message received');
              this.idleAgentConfigs.delete(agentId);
              this.startAgent(agentId, nextConfig, queuedWakeMessage, unreadSummary2, undefined, ap.launchId || undefined).catch((err) => {
                logger.error(`[Agent ${agentId}] Failed to continue with queued message`, err);
                this.idleAgentConfigs.set(agentId, {
                  config: nextConfig,
                  sessionId: ap.sessionId,
                  launchId: ap.launchId,
                });
                this.broadcastActivity(agentId, 'online', 'Process idle');
              });
              return;
            }

            this.idleAgentConfigs.set(agentId, {
              config: { ...ap.config, sessionId: ap.sessionId },
              sessionId: ap.sessionId,
              launchId: ap.launchId,
            });
            if (!ap.driver.supportsStdinNotification) {
              logger.info(`[Agent ${agentId}] Turn completed; cached idle state for future restart`);
            }
            this.broadcastActivity(agentId, 'online', 'Process idle');
          } else {
            this.idleAgentConfigs.delete(agentId);
            const reason = formatCrashReason(finalCode, finalSignal, ap);
            const summary = summarizeCrash(finalCode, finalSignal);

            if (isMissingResumeSession(ap)) {
              const staleSessionId = ap.sessionId;
              const restartConfig = { ...ap.config, sessionId: null };
              logger.warn(
                `[Agent ${agentId}] Stored Claude session ${staleSessionId} is unavailable locally; falling back to cold start`,
              );
              this.broadcastActivity(
                agentId,
                'working',
                'Stored Claude session missing; cold-starting a new session\u2026',
                [{ kind: 'text', text: `Stored Claude session ${staleSessionId} was not found locally. Falling back to a cold start.` }],
              );
              this.startAgent(agentId, restartConfig, undefined, undefined, undefined, ap.launchId || undefined).catch((err) => {
                logger.error(`[Agent ${agentId}] Cold start recovery failed`, err);
                this.sendAgentStatus(agentId, 'inactive', ap.launchId);
                this.broadcastActivity(agentId, 'offline', `Crashed (${summary})`);
              });
              return;
            }

            // Retry crashed agents with exponential backoff (up to MAX_CRASH_RETRIES)
            const retryCount = (this.crashRetries.get(agentId) || 0) + 1;
            this.crashRetries.set(agentId, retryCount);

            if (retryCount <= MAX_CRASH_RETRIES) {
              const delayMs = CRASH_RETRY_BASE_MS * Math.pow(2, retryCount - 1); // 5s, 10s, 20s
              logger.warn(
                `[Agent ${agentId}] Process crashed (${reason}) — retry ${retryCount}/${MAX_CRASH_RETRIES} in ${delayMs / 1000}s`,
              );
              this.broadcastActivity(agentId, 'working', `Crashed — retrying in ${delayMs / 1000}s (attempt ${retryCount}/${MAX_CRASH_RETRIES})`);

              // Cache idle state so delivery can still reach this agent during backoff
              this.idleAgentConfigs.set(agentId, {
                config: { ...ap.config, sessionId: ap.sessionId },
                sessionId: ap.sessionId,
                launchId: ap.launchId,
              });

              setTimeout(() => {
                const restartConfig = { ...ap.config, sessionId: ap.sessionId };
                this.idleAgentConfigs.delete(agentId);
                this.startAgent(agentId, restartConfig, undefined, undefined, undefined, ap.launchId || undefined).catch((err) => {
                  logger.error(`[Agent ${agentId}] Crash retry ${retryCount} failed`, err);
                  this.crashRetries.delete(agentId);
                  this.sendAgentStatus(agentId, 'inactive', ap.launchId);
                  this.broadcastActivity(agentId, 'offline', `Crashed (${summary})`);
                });
              }, delayMs);
            } else {
              this.crashRetries.delete(agentId);
              logger.error(`[Agent ${agentId}] Process crashed (${reason}) — exhausted ${MAX_CRASH_RETRIES} retries, marking inactive`);
              this.sendAgentStatus(agentId, 'inactive', ap.launchId);
              this.broadcastActivity(agentId, 'offline', `Crashed (${summary})`);
            }
          }
        }
      });

      this.sendAgentStatus(agentId, 'active', launchId || null);
      this.broadcastActivity(agentId, 'working', 'Starting\u2026');

      // Process-alive heartbeat: periodically check the process is still running
      // and broadcast 'working' so the frontend shows the agent as alive.
      agentProcess.processAliveTimer = setInterval(() => {
        const current = this.agents.get(agentId);
        if (!current || current.process.killed || current.process.exitCode !== null) {
          if (current?.processAliveTimer) {
            clearInterval(current.processAliveTimer);
            current.processAliveTimer = null;
          }
          return;
        }
        if (!current.isIdle) {
          this.broadcastActivity(agentId, 'working', 'Processing\u2026');
        }
      }, PROCESS_ALIVE_HEARTBEAT_MS);
    } catch (err) {
      this.agentsStarting.delete(agentId);
      throw err;
    }
  }

  async stopAgent(agentId: string, { wait = false, silent = false }: { wait?: boolean; silent?: boolean } = {}): Promise<void> {
    this.idleAgentConfigs.delete(agentId);
    const ap = this.agents.get(agentId);
    if (!ap) {
      if (!silent) {
        logger.info(`[Agent ${agentId}] Stop requested but no running process was found`);
      }
      return;
    }

    if (ap.notificationTimer) {
      clearTimeout(ap.notificationTimer);
    }
    if (ap.activityHeartbeat) {
      clearInterval(ap.activityHeartbeat);
    }
    if (ap.processAliveTimer) {
      clearInterval(ap.processAliveTimer);
    }

    this.agents.delete(agentId);
    ap.process.kill('SIGTERM');

    if (!silent) {
      this.sendAgentStatus(agentId, 'inactive', ap.launchId);
      this.broadcastActivity(agentId, 'offline', 'Stopped');
      logger.info(`[Agent ${agentId}] Stopped by request`);
    }

    if (wait) {
      await new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          if (!silent) {
            logger.warn(`[Agent ${agentId}] Stop timed out; force killing`);
          }
          try {
            ap.process.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        }, 5000);

        ap.process.on('exit', () => {
          clearTimeout(forceKillTimer);
          resolve();
        });

        if (ap.process.exitCode !== null || ap.process.signalCode !== null) {
          clearTimeout(forceKillTimer);
          resolve();
        }
      });
    }
  }

  deliverMessage(agentId: string, message: any): void {
    const ap = this.agents.get(agentId);
    if (!ap) {
      if (this.agentsStarting.has(agentId)) {
        const pending = this.startingInboxes.get(agentId) || [];
        pending.push(message);
        this.startingInboxes.set(agentId, pending);
        return;
      }
      const cached = this.idleAgentConfigs.get(agentId);
      if (cached) {
        logger.info(`[Agent ${agentId}] Starting from idle state for new message`);
        this.idleAgentConfigs.delete(agentId);
        this.startAgent(agentId, cached.config, message, undefined, undefined, cached.launchId || undefined).catch((err) => {
          logger.error(`[Agent ${agentId}] Failed to auto-restart`, err);
        });
      }
      return;
    }

    if (ap.isIdle && ap.driver.supportsStdinNotification && ap.sessionId) {
      ap.isIdle = false;
      this.broadcastActivity(agentId, 'working', 'Message received');
      this.deliverMessagesViaStdin(agentId, ap, [message], 'idle');
      return;
    }

    ap.inbox.push(message);
    if (!ap.driver.supportsStdinNotification) return;
    if (!ap.sessionId) return;

    ap.pendingNotificationCount++;
    if (!ap.notificationTimer) {
      ap.notificationTimer = setTimeout(() => {
        this.sendStdinNotification(agentId);
      }, 3000);
    }
  }

  async resetWorkspace(agentId: string): Promise<void> {
    const agentDataDir = path.join(this.dataDir, agentId);
    try {
      await rm(agentDataDir, { recursive: true, force: true });
      logger.info(`[Agent ${agentId}] Workspace reset complete (${agentDataDir})`);
    } catch (err) {
      logger.error(`[Agent ${agentId}] Workspace reset failed`, err);
    }
  }

  async stopAll(): Promise<void> {
    this.idleAgentConfigs.clear();
    const ids = [...this.agents.keys()];
    await Promise.all(ids.map((id) => this.stopAgent(id, { wait: true, silent: true })));
  }

  getRunningAgentIds(): string[] {
    return [...this.agents.keys()];
  }

  getAgentSessionId(agentId: string): string | null {
    return this.agents.get(agentId)?.sessionId ?? null;
  }

  getAgentLaunchId(agentId: string): string | null {
    return this.agents.get(agentId)?.launchId ?? null;
  }

  getIdleAgentSessionIds(): Array<{ agentId: string; sessionId: string; launchId: string | null }> {
    const result: Array<{ agentId: string; sessionId: string; launchId: string | null }> = [];
    for (const [agentId, { sessionId, launchId }] of this.idleAgentConfigs) {
      if (sessionId) result.push({ agentId, sessionId, launchId });
    }
    return result;
  }

  // Delegate workspace operations to WorkspaceService
  async scanAllWorkspaces(): Promise<Array<{ directoryName: string; totalSizeBytes: number; lastModified: string; fileCount: number }>> {
    return this.workspaceService.scanAllWorkspaces();
  }

  async deleteWorkspaceDirectory(directoryName: string): Promise<boolean> {
    return this.workspaceService.deleteWorkspaceDirectory(directoryName);
  }

  async getFileTree(agentId: string, dirPath?: string): Promise<any[]> {
    return this.workspaceService.getFileTree(agentId, dirPath);
  }

  async readFile(agentId: string, filePath: string): Promise<{ content: string | null; binary: boolean }> {
    return this.workspaceService.readFile(agentId, filePath);
  }

  // Delegate skills operations to SkillsService
  async listSkills(agentId: string, runtimeHint?: string): Promise<{ global: any[]; workspace: any[] }> {
    const agent = this.agents.get(agentId);
    return this.skillsService.listSkills(agentId, runtimeHint, agent?.config.runtime);
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Broadcast an activity change — emits a single agent:activity event that carries
   * both the status (for the dot indicator) and trajectory entries (for the activity log).
   */
  private broadcastActivity(agentId: string, activity: string, detail: string, extraTrajectory: any[] = []): void {
    const ap = this.agents.get(agentId);
    const entries = [...extraTrajectory];
    const hasToolStart = entries.some((e) => e.kind === 'tool_start');
    if (!hasToolStart) {
      entries.push({ kind: 'status', activity, detail });
    }
    this.sendToServer({ type: 'agent:activity', agentId, activity, detail, entries, launchId: ap?.launchId || undefined });

    if (ap) {
      ap.lastActivity = activity;
      ap.lastActivityDetail = detail;
      if (activity === 'working' || activity === 'thinking') {
        if (!ap.activityHeartbeat) {
          ap.activityHeartbeat = setInterval(() => {
            this.sendToServer({
              type: 'agent:activity',
              agentId,
              activity: ap.lastActivity,
              detail: ap.lastActivityDetail,
              launchId: ap.launchId || undefined,
            });
          }, ACTIVITY_HEARTBEAT_MS);
        }
      } else {
        if (ap.activityHeartbeat) {
          clearInterval(ap.activityHeartbeat);
          ap.activityHeartbeat = null;
        }
      }
    }
  }

  private flushPendingTrajectory(agentId: string): void {
    const ap = this.agents.get(agentId);
    const pending = ap?.pendingTrajectory;
    if (!ap || !pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    ap.pendingTrajectory = null;
    const text =
      pending.text.length > MAX_TRAJECTORY_TEXT
        ? pending.text.slice(0, MAX_TRAJECTORY_TEXT) + '\u2026'
        : pending.text;
    if (!text) return;
    if (pending.kind === 'thinking') {
      this.broadcastActivity(agentId, 'thinking', '', [{ kind: 'thinking', text }]);
    } else {
      this.broadcastActivity(agentId, 'thinking', '', [{ kind: 'text', text }]);
    }
  }

  private queueTrajectoryText(agentId: string, kind: string, text: string): void {
    const ap = this.agents.get(agentId);
    if (!ap) return;
    if (!text) {
      this.broadcastActivity(agentId, 'thinking', '');
      return;
    }
    const pending = ap.pendingTrajectory;
    if (pending && pending.kind === kind) {
      pending.text += text;
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = setTimeout(() => this.flushPendingTrajectory(agentId), TRAJECTORY_COALESCE_MS);
      return;
    }
    this.flushPendingTrajectory(agentId);
    if (ap.lastActivity !== 'thinking' || ap.lastActivityDetail !== '') {
      this.broadcastActivity(agentId, 'thinking', '');
    }
    ap.pendingTrajectory = {
      kind,
      text,
      timer: setTimeout(() => this.flushPendingTrajectory(agentId), TRAJECTORY_COALESCE_MS),
    };
  }

  /** Handle a single ParsedEvent from any runtime driver */
  private handleParsedEvent(agentId: string, event: import('../../drivers/types.js').ParsedEvent, driver: Driver): void {
    const ap = this.agents.get(agentId);
    switch (event.kind) {
      case 'session_init':
        if (ap) ap.sessionId = event.sessionId!;
        this.sendToServer({ type: 'agent:session', agentId, sessionId: event.sessionId, launchId: ap?.launchId || undefined });
        break;
      case 'thinking': {
        this.queueTrajectoryText(agentId, 'thinking', event.text!);
        if (ap) ap.isIdle = false;
        break;
      }
      case 'text': {
        this.queueTrajectoryText(agentId, 'text', event.text!);
        if (ap) ap.isIdle = false;
        break;
      }
      case 'tool_call': {
        this.flushPendingTrajectory(agentId);
        const toolName = event.name!;
        const inputSummary = driver.summarizeToolInput(toolName, event.input);
        const detail =
          toolName === `${driver.mcpToolPrefix}check_messages`
            ? 'Checking messages\u2026'
            : toolName === `${driver.mcpToolPrefix}send_message`
              ? 'Sending message\u2026'
              : driver.toolDisplayName(toolName);
        this.broadcastActivity(agentId, 'working', detail, [{ kind: 'tool_start', toolName, toolInput: inputSummary }]);
        if (ap) ap.isIdle = false;
        break;
      }
      case 'turn_end':
        this.flushPendingTrajectory(agentId);
        if (ap) {
          if (event.sessionId) ap.sessionId = event.sessionId;
          if (ap.inbox.length > 0 && ap.driver.supportsStdinNotification && ap.sessionId) {
            const nextMessages = ap.inbox.splice(0, ap.inbox.length);
            this.broadcastActivity(agentId, 'working', 'Message received');
            this.deliverMessagesViaStdin(agentId, ap, nextMessages, 'idle');
          } else {
            ap.isIdle = true;
            this.broadcastActivity(agentId, 'online', 'Idle');
          }
        }
        if (event.sessionId) {
          this.sendToServer({ type: 'agent:session', agentId, sessionId: event.sessionId, launchId: ap?.launchId || undefined });
        }
        break;
      case 'error': {
        this.flushPendingTrajectory(agentId);
        if (ap) ap.lastRuntimeError = event.message!;
        this.broadcastActivity(agentId, 'error', event.message!, [
          { kind: 'text', text: `Error: ${event.message}` },
        ]);
        break;
      }
    }
  }

  private sendAgentStatus(agentId: string, status: string, launchId: string | null | undefined): void {
    this.sendToServer({ type: 'agent:status', agentId, status, launchId: launchId || undefined });
  }

  /** Send a batched notification to the agent via stdin about pending messages */
  private sendStdinNotification(agentId: string): void {
    const ap = this.agents.get(agentId);
    if (!ap) return;
    const count = ap.pendingNotificationCount;
    ap.pendingNotificationCount = 0;
    ap.notificationTimer = null;
    if (count === 0) return;
    if (ap.isIdle) return;
    if (!ap.sessionId) return;

    if (ap.driver.deliverMessageDirectlyWhileBusy && ap.inbox.length > 0) {
      const queuedMessages = ap.inbox.splice(0, ap.inbox.length);
      console.log(`[Agent ${agentId}] Delivering queued message via stdin while busy`);
      this.broadcastActivity(agentId, 'working', 'Message received');
      this.deliverMessagesViaStdin(agentId, ap, queuedMessages, 'busy');
      return;
    }

    const notification = `[System notification: You have ${count} new message${count > 1 ? 's' : ''} waiting. Call check_messages to read ${count > 1 ? 'them' : 'it'} when you're ready.]`;
    logger.info(`[Agent ${agentId}] Sending stdin notification: ${count} message(s)`);
    const encoded = ap.driver.encodeStdinMessage(notification, ap.sessionId, { mode: 'busy' });
    if (encoded) {
      ap.process.stdin?.write(encoded + '\n');
    }
  }

  /** Deliver a message to an agent via stdin, formatting it the same way as the MCP bridge */
  private deliverMessagesViaStdin(agentId: string, ap: AgentProcess, messages: any[], mode: string): void {
    if (messages.length === 0) return;
    const prompt =
      messages.length === 1
        ? `New message received:\n\n${formatIncomingMessage(messages[0])}\n\nRespond as appropriate. Complete all your work before stopping.`
        : `New messages received:\n\n${messages.map((message) => formatIncomingMessage(message)).join('\n')}\n\nRespond as appropriate. Complete all your work before stopping.`;
    const encoded = ap.driver.encodeStdinMessage(prompt, ap.sessionId, { mode });
    if (encoded) {
      const senders = [...new Set(messages.map((message: any) => `@${message.sender_name}`))].join(', ');
      logger.info(
        `[Agent ${agentId}] Delivering ${mode} ${messages.length === 1 ? 'message' : `${messages.length} messages`} via stdin from ${senders}`,
      );
      ap.process.stdin?.write(encoded + '\n');
    }
  }
}
