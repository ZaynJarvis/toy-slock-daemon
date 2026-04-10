import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import type { Driver, SpawnContext, ParsedEvent, AgentConfig } from './types.js';
import { buildBaseSystemPrompt } from './systemPrompt.js';

const KIMI_WIRE_PROTOCOL_VERSION = '1.3';
const KIMI_SYSTEM_PROMPT_FILE = '.slock-kimi-system.md';
const KIMI_AGENT_FILE = '.slock-kimi-agent.yaml';
const KIMI_MCP_FILE = '.slock-kimi-mcp.json';

function parseToolArguments(raw: any): any {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class KimiDriver implements Driver {
  id = 'kimi';
  supportsStdinNotification = true;
  mcpToolPrefix = '';
  deliverMessageDirectlyWhileBusy = true;

  private sessionId: string | null = null;
  private sessionAnnounced = false;
  private promptRequestId: string | null = null;

  spawn(ctx: SpawnContext): { process: import('child_process').ChildProcess } {
    const isResume = !!ctx.config.sessionId;
    this.sessionId = ctx.config.sessionId || randomUUID();
    this.sessionAnnounced = false;
    this.promptRequestId = randomUUID();

    const isTsSource = ctx.chatBridgePath.endsWith('.ts');
    const command = isTsSource ? 'npx' : 'node';
    const bridgeArgs = isTsSource
      ? ['tsx', ctx.chatBridgePath, '--agent-id', ctx.agentId, '--server-url', ctx.config.serverUrl, '--auth-token', ctx.config.authToken || ctx.daemonApiKey]
      : [ctx.chatBridgePath, '--agent-id', ctx.agentId, '--server-url', ctx.config.serverUrl, '--auth-token', ctx.config.authToken || ctx.daemonApiKey];

    const systemPromptPath = path.join(ctx.workingDirectory, KIMI_SYSTEM_PROMPT_FILE);
    const agentFilePath = path.join(ctx.workingDirectory, KIMI_AGENT_FILE);
    const mcpConfigPath = path.join(ctx.workingDirectory, KIMI_MCP_FILE);

    if (!isResume || !existsSync(systemPromptPath)) {
      writeFileSync(systemPromptPath, ctx.prompt, 'utf8');
    }

    writeFileSync(
      agentFilePath,
      ['version: 1', 'agent:', '  extend: default', `  system_prompt_path: ./${KIMI_SYSTEM_PROMPT_FILE}`, ''].join('\n'),
      'utf8'
    );

    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          chat: {
            command,
            args: bridgeArgs,
          },
        },
      }),
      'utf8'
    );

    const args = [
      '--wire',
      '--yolo',
      '--agent-file',
      agentFilePath,
      '--mcp-config-file',
      mcpConfigPath,
      '--session',
      this.sessionId,
    ];

    if (ctx.config.model && ctx.config.model !== 'default') {
      args.push('--model', ctx.config.model);
    }

    const spawnEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };

    const proc = spawn('kimi', args, {
      cwd: ctx.workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
      shell: process.platform === 'win32',
    });

    proc.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'initialize',
        params: {
          protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
          client: { name: 'slock-daemon', version: '1.0.0' },
          capabilities: {
            supports_question: false,
            supports_plan_mode: false,
          },
        },
      }) + '\n'
    );

    proc.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: this.promptRequestId,
        method: 'prompt',
        params: {
          user_input: isResume
            ? ctx.prompt
            : 'Your system prompt contains your standing instructions. Follow it now and begin listening for messages.',
        },
      }) + '\n'
    );

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return [];
    }
    const events: ParsedEvent[] = [];

    if (!this.sessionAnnounced && this.sessionId) {
      events.push({ kind: 'session_init', sessionId: this.sessionId });
      this.sessionAnnounced = true;
    }

    if ('method' in message && message.method === 'event') {
      const eventType = message.params?.type;
      const payload = message.params?.payload || {};
      switch (eventType) {
        case 'StepBegin':
          events.push({ kind: 'thinking', text: '' });
          break;
        case 'ContentPart':
          if (payload.type === 'think' && payload.think) {
            events.push({ kind: 'thinking', text: payload.think });
          } else if (payload.type === 'text' && payload.text) {
            events.push({ kind: 'text', text: payload.text });
          }
          break;
        case 'ToolCall':
          events.push({
            kind: 'tool_call',
            name: payload.function?.name || 'unknown_tool',
            input: parseToolArguments(payload.function?.arguments),
          });
          break;
        case 'TurnEnd':
          events.push({ kind: 'turn_end', sessionId: this.sessionId || undefined });
          break;
        case 'StepInterrupted':
          events.push({ kind: 'error', message: 'Turn interrupted' });
          events.push({ kind: 'turn_end', sessionId: this.sessionId || undefined });
          break;
      }
      return events;
    }

    if ('error' in message) {
      events.push({ kind: 'error', message: message.error?.message || 'Unknown Kimi error' });
      events.push({ kind: 'turn_end', sessionId: this.sessionId || undefined });
    }

    return events;
  }

  encodeStdinMessage(_text: string, _sessionId: string | null, opts?: { mode?: string }): string | null {
    const mode = opts?.mode || 'busy';
    if (mode === 'idle') {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'prompt',
        params: {
          user_input: _text,
        },
      });
    }
    return JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'steer',
      params: {
        user_input: _text,
      },
    });
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): string {
    return buildBaseSystemPrompt(config, {
      toolPrefix: '',
      extraCriticalRules: [
        '- Do NOT use shell commands to send or receive messages. The MCP tools handle everything.',
      ],
      postStartupNotes: [],
      includeStdinNotificationSection: true,
    });
  }

  toolDisplayName(name: string): string {
    if (name === 'list_tasks') return 'Viewing task board\u2026';
    if (name === 'create_tasks') return 'Creating tasks\u2026';
    if (name === 'claim_tasks') return 'Claiming tasks\u2026';
    if (name === 'unclaim_task') return 'Unclaiming task\u2026';
    if (name === 'update_task_status') return 'Updating task\u2026';
    if (
      name === 'send_message' ||
      name === 'receive_message' ||
      name === 'read_history' ||
      name === 'list_server'
    )
      return '';
    if (name === 'Shell') return 'Running command\u2026';
    if (name === 'ReadFile') return 'Reading file\u2026';
    if (name === 'WriteFile' || name === 'StrReplaceFile') return 'Editing file\u2026';
    if (name === 'Glob' || name === 'Grep') return 'Searching code\u2026';
    if (name === 'SearchWeb') return 'Searching web\u2026';
    if (name === 'FetchURL') return 'Fetching web\u2026';
    if (name === 'SetTodoList') return 'Updating tasks\u2026';
    return `Using ${name.length > 20 ? name.slice(0, 20) + '\u2026' : name}\u2026`;
  }

  summarizeToolInput(name: string, input: any): string {
    if (!input || typeof input !== 'object') return '';
    try {
      if (name === 'Shell') {
        const cmd = input.command || '';
        return cmd.length > 100 ? cmd.slice(0, 100) + '\u2026' : cmd;
      }
      if (name === 'ReadFile' || name === 'WriteFile' || name === 'StrReplaceFile') {
        return input.path || '';
      }
      if (name === 'Glob' || name === 'Grep') return input.pattern || input.query || '';
      if (name === 'SearchWeb') return input.query || '';
      if (name === 'FetchURL') return input.url || '';
      if (name === 'send_message') return input.target || input.channel || '';
      if (name === 'read_history') return input.target || input.channel || '';
      if (name === 'list_tasks') return input.channel || '';
      if (name === 'create_tasks') return input.channel || '';
      if (name === 'claim_tasks') {
        const nums = input.task_numbers;
        return input.channel ? `${input.channel} #t${Array.isArray(nums) ? nums.join(',#t') : nums}` : '';
      }
      if (name === 'unclaim_task' || name === 'update_task_status') {
        return input.channel ? `${input.channel} #t${input.task_number}` : '';
      }
      return '';
    } catch {
      return '';
    }
  }
}
