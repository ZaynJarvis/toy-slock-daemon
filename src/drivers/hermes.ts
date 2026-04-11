import { spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import type { Driver, SpawnContext, ParsedEvent, AgentConfig } from './types.js';
import { buildBaseSystemPrompt } from './systemPrompt.js';

function resolveModel(model: string | undefined): string {
  if (!model || model === 'default') return 'gpt-5.4';
  return model;
}

function inferProvider(model: string): string {
  if (model.startsWith('gemini-') || model.startsWith('google/')) return 'gemini';
  if (model.startsWith('gpt-') || /^o\d/.test(model)) return 'openai-codex';
  return 'anthropic';
}

export class HermesDriver implements Driver {
  id = 'hermes';
  supportsStdinNotification = false;
  mcpToolPrefix = 'mcp_chat_';

  spawn(ctx: SpawnContext): { process: import('child_process').ChildProcess } {
    const hermesHome = path.join(ctx.workingDirectory, '.hermes');
    mkdirSync(hermesHome, { recursive: true });

    // Build bridge invocation (mirrors Codex/Claude pattern)
    const isTsSource = ctx.chatBridgePath.endsWith('.ts');
    const bridgeCommand = isTsSource ? 'npx' : 'node';
    const bridgeArgs = isTsSource
      ? ['tsx', ctx.chatBridgePath, '--agent-id', ctx.agentId, '--server-url', ctx.config.serverUrl, '--auth-token', ctx.config.authToken || ctx.daemonApiKey]
      : [ctx.chatBridgePath, '--agent-id', ctx.agentId, '--server-url', ctx.config.serverUrl, '--auth-token', ctx.config.authToken || ctx.daemonApiKey];

    // Write config.yaml before spawn — isolated HERMES_HOME has no config by default
    const model = resolveModel(ctx.config.model);
    const provider = inferProvider(model);
    const argsYaml = bridgeArgs.map(a => `      - ${JSON.stringify(a)}`).join('\n');
    const configYaml = [
      'config_version: 14',
      'model:',
      `  default: ${model}`,
      `  provider: ${provider}`,
      'mcp_servers:',
      '  chat:',
      `    command: ${JSON.stringify(bridgeCommand)}`,
      '    args:',
      argsYaml,
      '    enabled: true',
      '    timeout: 300',
    ].join('\n');

    writeFileSync(path.join(hermesHome, 'config.yaml'), configYaml, 'utf8');

    // Build hermes chat args
    const args = ['chat', '-q', ctx.prompt, '-Q', '--source', 'tool', '--yolo'];
    if (ctx.config.sessionId) {
      args.push('--resume', ctx.config.sessionId);
    }

    const proc = spawn('hermes', args, {
      cwd: ctx.workingDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HERMES_HOME: hermesHome,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        ...(ctx.config.envVars || {}),
      },
    });

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    // Banner line: emit thinking to signal turn is alive
    if (/^╭─/.test(line)) {
      return [{ kind: 'thinking', text: '' }];
    }
    // Resume info line: skip silently
    if (/^↻ Resumed session/.test(line)) {
      return [];
    }
    // Session ID: emit session_init
    const sessionMatch = line.match(/^session_id:\s*(.+)$/);
    if (sessionMatch) {
      return [{ kind: 'session_init', sessionId: sessionMatch[1].trim() }];
    }
    // Invalid session resume (stdout, exit 1): emit error
    if (/^Session not found:/.test(line)) {
      return [{ kind: 'error', message: line }];
    }
    // Follow-up hint line after "Session not found:" — skip
    if (/^Use a session ID from a previous CLI run/.test(line)) {
      return [];
    }
    // Empty lines: skip
    if (!line.trim()) {
      return [];
    }
    // Everything else is agent response text
    return [{ kind: 'text', text: line }];
  }

  encodeStdinMessage(_text: string, _sessionId: string | null, _opts?: { mode?: string }): string | null {
    // Hermes is one-shot per turn — no stdin delivery
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): string {
    return buildBaseSystemPrompt(config, {
      toolPrefix: '',
      extraCriticalRules: [
        '- Do NOT use shell commands to send or receive messages. The MCP tools handle everything.',
      ],
      postStartupNotes: [
        '**IMPORTANT**: Your process exits after each turn completes. You will be automatically restarted when new messages arrive. Complete all your work, then stop \u2014 new messages will wake you up.',
      ],
      includeStdinNotificationSection: false,
    });
  }

  toolDisplayName(name: string): string {
    if (name === `${this.mcpToolPrefix}upload_file`) return 'Uploading file\u2026';
    if (name === `${this.mcpToolPrefix}view_file`) return 'Viewing file\u2026';
    if (name === `${this.mcpToolPrefix}list_tasks`) return 'Listing tasks\u2026';
    if (name === `${this.mcpToolPrefix}create_tasks`) return 'Creating tasks\u2026';
    if (name === `${this.mcpToolPrefix}claim_tasks`) return 'Claiming tasks\u2026';
    if (name === `${this.mcpToolPrefix}unclaim_task`) return 'Unclaiming task\u2026';
    if (name === `${this.mcpToolPrefix}update_task_status`) return 'Updating task status\u2026';
    if (name === `${this.mcpToolPrefix}list_server`) return 'Listing server\u2026';
    if (name === `${this.mcpToolPrefix}read_history`) return 'Reading history\u2026';
    if (name === `${this.mcpToolPrefix}search_messages`) return 'Searching messages\u2026';
    if (name === `${this.mcpToolPrefix}check_messages`) return 'Checking messages\u2026';
    if (name.startsWith(this.mcpToolPrefix)) return '';
    return `Using ${name.length > 20 ? name.slice(0, 20) + '\u2026' : name}\u2026`;
  }

  summarizeToolInput(name: string, input: any): string {
    if (!input || typeof input !== 'object') return '';
    try {
      if (name === `${this.mcpToolPrefix}send_message`) {
        return input.target || input.channel || (input.dm_to ? `DM:@${input.dm_to}` : '');
      }
      if (name === `${this.mcpToolPrefix}read_history`) return input.target || input.channel || '';
      if (name === `${this.mcpToolPrefix}search_messages`) return input.query || '';
      if (name === `${this.mcpToolPrefix}list_tasks`) return input.channel || '';
      if (name === `${this.mcpToolPrefix}create_tasks`) return input.channel || '';
      if (name === `${this.mcpToolPrefix}claim_tasks`) {
        const nums = input.task_numbers;
        return input.channel ? `${input.channel} #${Array.isArray(nums) ? nums.join(',#') : nums}` : '';
      }
      if (name === `${this.mcpToolPrefix}unclaim_task`) {
        return input.channel ? `${input.channel} #${input.task_number}` : '';
      }
      if (name === `${this.mcpToolPrefix}update_task_status`) {
        return input.channel ? `${input.channel} #${input.task_number}` : '';
      }
      if (name === `${this.mcpToolPrefix}upload_file`) return input.file_path || '';
      return '';
    } catch {
      return '';
    }
  }
}
