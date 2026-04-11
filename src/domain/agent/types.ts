import { ChildProcess } from 'child_process';
import type { Driver, AgentConfig } from '../../drivers/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

import path from 'path';
import os from 'os';

export const DATA_DIR = path.join(os.homedir(), '.slock', 'agents');

export const MAX_TRAJECTORY_TEXT = 2000;
export const TRAJECTORY_COALESCE_MS = 350;
export const ACTIVITY_HEARTBEAT_MS = 60000;

export const MAX_STDOUT_LINES = 8;
export const MAX_STDOUT_LINE_LENGTH = 240;
export const MAX_STDERR_LINES = 8;
export const MAX_STDERR_LINE_LENGTH = 240;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentProcess {
  process: ChildProcess;
  driver: Driver;
  inbox: any[];
  config: AgentConfig;
  sessionId: string | null;
  launchId: string | null;
  isIdle: boolean;
  notificationTimer: ReturnType<typeof setTimeout> | null;
  pendingNotificationCount: number;
  activityHeartbeat: ReturnType<typeof setInterval> | null;
  lastActivity: string;
  lastActivityDetail: string;
  recentStdout: string[];
  recentStderr: string[];
  lastRuntimeError: string | null;
  spawnError: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  pendingTrajectory: { kind: string; text: string; timer: ReturnType<typeof setTimeout> } | null;
}

export interface IdleAgentEntry {
  config: AgentConfig;
  sessionId: string | null;
  launchId: string | null;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function toLocalTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatChannelLabel(message: any): string {
  return message.channel_type === 'dm'
    ? `DM:@${message.channel_name}`
    : `#${message.channel_name}`;
}

export function formatMessageTarget(message: any): string {
  if (message.channel_type === 'thread' && message.parent_channel_name) {
    const shortId = message.channel_name.startsWith('thread-')
      ? message.channel_name.slice(7)
      : message.channel_name;
    if (message.parent_channel_type === 'dm') {
      return `dm:@${message.parent_channel_name}:${shortId}`;
    }
    return `#${message.parent_channel_name}:${shortId}`;
  }
  if (message.channel_type === 'dm') {
    return `dm:@${message.channel_name}`;
  }
  return `#${message.channel_name}`;
}

export function formatIncomingMessage(message: any): string {
  const target = formatMessageTarget(message);
  const msgId = message.message_id ? message.message_id.slice(0, 8) : '-';
  const time = message.timestamp ? toLocalTime(message.timestamp) : '-';
  const senderType = message.sender_type === 'agent' ? ' type=agent' : '';
  const attachSuffix = message.attachments?.length
    ? ` [${message.attachments.length} image${message.attachments.length > 1 ? 's' : ''}: ${message.attachments.map((a: any) => `${a.filename} (id:${a.id})`).join(', ')} \u2014 use view_file to see]`
    : '';
  const taskSuffix = message.task_status
    ? ` [task #${message.task_number} status=${message.task_status}${message.task_assignee_id ? ` assignee=${message.task_assignee_type}:${message.task_assignee_id}` : ''}]`
    : '';
  return `[target=${target} msg=${msgId} time=${time}${senderType}] @${message.sender_name}: ${message.content}${attachSuffix}${taskSuffix}`;
}

export function buildUnreadSummary(
  messages: any[],
  excludeChannel?: string,
): Record<string, number> | undefined {
  const summary = new Map<string, number>();
  for (const message of messages) {
    const label = formatChannelLabel(message);
    if (excludeChannel && label === excludeChannel) continue;
    summary.set(label, (summary.get(label) || 0) + 1);
  }
  return summary.size > 0 ? Object.fromEntries(summary) : undefined;
}

export function formatCrashReason(code: number | null, signal: string | null, ap: AgentProcess): string {
  const parts: string[] = [];
  if (signal) {
    parts.push(`signal ${signal}`);
  } else if (typeof code === 'number') {
    parts.push(`exit code ${code}`);
  } else {
    parts.push('unknown exit');
  }
  if (ap.spawnError) {
    parts.push(`spawn error: ${ap.spawnError}`);
  }
  if (ap.lastRuntimeError) {
    parts.push(`runtime error: ${ap.lastRuntimeError}`);
  }
  if (ap.recentStderr.length > 0) {
    parts.push(`stderr: ${ap.recentStderr.join(' | ')}`);
  }
  if (!ap.lastRuntimeError && ap.recentStdout.length > 0) {
    parts.push(`stdout: ${ap.recentStdout.join(' | ')}`);
  }
  return parts.join(' | ');
}

export function summarizeCrash(code: number | null, signal: string | null): string {
  if (signal) return `signal ${signal}`;
  if (typeof code === 'number') return `exit code ${code}`;
  return 'unknown exit';
}

export function isMissingResumeSession(ap: AgentProcess): boolean {
  if (!ap.sessionId) return false;
  if (ap.driver.id === 'claude') {
    return /No conversation found with session ID/i.test(ap.lastRuntimeError || '');
  }
  if (ap.driver.id === 'hermes') {
    return /^Session not found:/i.test(ap.lastRuntimeError || '');
  }
  return false;
}

export function getMessageDeliveryText(supportsStdinNotification: boolean): string {
  return supportsStdinNotification
    ? 'New messages will be delivered to you automatically via stdin.'
    : 'The daemon will automatically restart you when new messages arrive.';
}

export function pushRecentLines(
  lines: string[],
  chunk: string,
  maxLines: number,
  maxLineLength: number,
): string[] {
  const next = [...lines];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const text = rawLine.trim();
    if (!text) continue;
    next.push(text.length > maxLineLength ? `${text.slice(0, maxLineLength)}...` : text);
  }
  return next.slice(-maxLines);
}

export function pushRecentStdout(lines: string[], chunk: string): string[] {
  return pushRecentLines(lines, chunk, MAX_STDOUT_LINES, MAX_STDOUT_LINE_LENGTH);
}

export function pushRecentStderr(lines: string[], chunk: string): string[] {
  return pushRecentLines(lines, chunk, MAX_STDERR_LINES, MAX_STDERR_LINE_LENGTH);
}
