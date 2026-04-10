import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import path from 'path';
import type { Driver, SpawnContext, ParsedEvent, AgentConfig } from './types.js';
import { buildBaseSystemPrompt } from './systemPrompt.js';

export class ClaudeDriver implements Driver {
  id = 'claude';
  supportsStdinNotification = true;
  mcpToolPrefix = 'mcp__chat__';

  spawn(ctx: SpawnContext): { process: import('child_process').ChildProcess } {
    const mcpArgs = [
      ctx.chatBridgePath,
      '--agent-id',
      ctx.agentId,
      '--server-url',
      ctx.config.serverUrl,
      '--auth-token',
      ctx.config.authToken || ctx.daemonApiKey,
    ];
    const isTsSource = ctx.chatBridgePath.endsWith('.ts');
    const mcpConfig = JSON.stringify({
      mcpServers: {
        chat: {
          command: isTsSource ? 'npx' : 'node',
          args: isTsSource ? ['tsx', ...mcpArgs] : mcpArgs,
        },
      },
    });
    let mcpConfigArg: string;
    if (process.platform === 'win32') {
      const mcpConfigPath = path.join(ctx.workingDirectory, '.slock-claude-mcp.json');
      writeFileSync(mcpConfigPath, mcpConfig, 'utf8');
      mcpConfigArg = mcpConfigPath;
    } else {
      mcpConfigArg = mcpConfig;
    }
    const args = [
      '--allow-dangerously-skip-permissions',
      '--dangerously-skip-permissions',
      '--verbose',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--mcp-config',
      mcpConfigArg,
      '--model',
      ctx.config.model || 'sonnet',
      '--disallowed-tools',
      'EnterPlanMode,ExitPlanMode',
    ];
    if (ctx.config.sessionId) {
      args.push('--resume', ctx.config.sessionId);
    }
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', ...ctx.config.envVars || {} };
    delete spawnEnv['CLAUDECODE'];
    const proc = spawn('claude', args, {
      cwd: ctx.workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
      shell: process.platform === 'win32',
    });
    const stdinMsg = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: ctx.prompt }],
      },
      ...(ctx.config.sessionId ? { session_id: ctx.config.sessionId } : {}),
    });
    proc.stdin?.write(stdinMsg + '\n');
    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    const events: ParsedEvent[] = [];
    const pushResultError = (message: any, fallback: string) => {
      const parts: string[] = [];
      if (Array.isArray(message.errors)) {
        for (const err of message.errors) {
          if (typeof err === 'string' && err.trim()) parts.push(err.trim());
        }
      }
      if (typeof message.result === 'string' && message.result.trim()) {
        parts.push(message.result.trim());
      }
      const detail = parts.join(' | ') || fallback;
      events.push({ kind: 'error', message: detail });
    };
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init' && event.session_id) {
          events.push({ kind: 'session_init', sessionId: event.session_id });
        }
        break;
      case 'assistant': {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'thinking' && block.thinking) {
              events.push({ kind: 'thinking', text: block.thinking });
            } else if (block.type === 'text' && block.text) {
              events.push({ kind: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              events.push({ kind: 'tool_call', name: block.name || 'unknown_tool', input: block.input });
            }
          }
        }
        break;
      }
      case 'result': {
        const subtype = typeof event.subtype === 'string' ? event.subtype : 'success';
        const stopReason = typeof event.stop_reason === 'string' ? event.stop_reason : null;
        switch (subtype) {
          case 'success':
            if (event.is_error && stopReason !== 'max_tokens') {
              pushResultError(event, 'Execution failed');
            }
            break;
          case 'error_during_execution':
            if (stopReason !== 'max_tokens') {
              pushResultError(event, 'Execution failed');
            }
            break;
          case 'error_max_budget_usd':
            pushResultError(event, 'Budget limit exceeded');
            break;
          case 'error_max_turns':
            pushResultError(event, 'Max turns exceeded');
            break;
          case 'error_max_structured_output_retries':
            pushResultError(event, 'Structured output retries exceeded');
            break;
        }
        events.push({ kind: 'turn_end', sessionId: event.session_id });
        break;
      }
    }
    return events;
  }

  encodeStdinMessage(text: string, sessionId: string | null, _opts?: { mode?: string }): string | null {
    return JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): string {
    return buildBaseSystemPrompt(config, {
      toolPrefix: 'mcp__chat__',
      extraCriticalRules: [
        '- Do NOT use bash/curl/sqlite to send or receive messages. The MCP tools handle everything.',
      ],
      postStartupNotes: [],
      includeStdinNotificationSection: true,
    });
  }

  toolDisplayName(name: string): string {
    if (name === 'mcp__chat__upload_file') return 'Uploading file\u2026';
    if (name === 'mcp__chat__view_file') return 'Viewing file\u2026';
    if (name === 'mcp__chat__list_tasks') return 'Listing tasks\u2026';
    if (name === 'mcp__chat__create_tasks') return 'Creating tasks\u2026';
    if (name === 'mcp__chat__claim_tasks') return 'Claiming tasks\u2026';
    if (name === 'mcp__chat__unclaim_task') return 'Unclaiming task\u2026';
    if (name === 'mcp__chat__update_task_status') return 'Updating task status\u2026';
    if (name === 'mcp__chat__list_server') return 'Listing server\u2026';
    if (name === 'mcp__chat__read_history') return 'Reading history\u2026';
    if (name === 'mcp__chat__search_messages') return 'Searching messages\u2026';
    if (name === 'mcp__chat__check_messages') return 'Checking messages\u2026';
    if (name.startsWith('mcp__chat__')) return '';
    if (name === 'Read' || name === 'read_file') return 'Reading file\u2026';
    if (name === 'Write' || name === 'write_file') return 'Writing file\u2026';
    if (name === 'Edit' || name === 'edit_file') return 'Editing file\u2026';
    if (name === 'Bash' || name === 'bash') return 'Running command\u2026';
    if (name === 'Glob' || name === 'glob') return 'Searching files\u2026';
    if (name === 'Grep' || name === 'grep') return 'Searching code\u2026';
    if (name === 'WebFetch' || name === 'web_fetch') return 'Fetching web\u2026';
    if (name === 'WebSearch' || name === 'web_search') return 'Searching web\u2026';
    if (name === 'TodoWrite') return 'Updating tasks\u2026';
    return `Using ${name.length > 20 ? name.slice(0, 20) + '\u2026' : name}\u2026`;
  }

  summarizeToolInput(name: string, input: any): string {
    if (!input || typeof input !== 'object') return '';
    try {
      if (name === 'Read' || name === 'read_file') return input.file_path || input.path || '';
      if (name === 'Write' || name === 'write_file') return input.file_path || input.path || '';
      if (name === 'Edit' || name === 'edit_file') return input.file_path || input.path || '';
      if (name === 'Bash' || name === 'bash') {
        const cmd = input.command || '';
        return cmd.length > 100 ? cmd.slice(0, 100) + '\u2026' : cmd;
      }
      if (name === 'Glob' || name === 'glob') return input.pattern || '';
      if (name === 'Grep' || name === 'grep') return input.pattern || '';
      if (name === 'WebFetch' || name === 'web_fetch') return input.url || '';
      if (name === 'WebSearch' || name === 'web_search') return input.query || '';
      if (name === 'mcp__chat__send_message') {
        return input.target || input.channel || (input.dm_to ? `DM:@${input.dm_to}` : '');
      }
      if (name === 'mcp__chat__read_history') return input.target || input.channel || '';
      if (name === 'mcp__chat__search_messages') return input.query || '';
      if (name === 'mcp__chat__list_tasks') return input.channel || '';
      if (name === 'mcp__chat__create_tasks') return input.channel || '';
      if (name === 'mcp__chat__claim_tasks') {
        const nums = input.task_numbers;
        return input.channel ? `${input.channel} #${Array.isArray(nums) ? nums.join(',#t') : nums}` : '';
      }
      if (name === 'mcp__chat__unclaim_task') {
        return input.channel ? `${input.channel} #${input.task_number}` : '';
      }
      if (name === 'mcp__chat__update_task_status') {
        return input.channel ? `${input.channel} #${input.task_number}` : '';
      }
      if (name === 'mcp__chat__upload_file') return input.file_path || '';
      return '';
    } catch {
      return '';
    }
  }
}
