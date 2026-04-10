import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { accessSync } from 'fs';

import { DaemonConnection } from './connection.js';
import { AgentProcessManager } from './agentProcessManager.js';
import { logger } from './logger.js';

const require2 = createRequire(import.meta.url);
const DAEMON_VERSION: string = require2('../package.json').version;

const RUNTIMES = [
  { id: 'claude', displayName: 'Claude Code', binary: 'claude' },
  { id: 'codex', displayName: 'Codex CLI', binary: 'codex' },
  { id: 'kimi', displayName: 'Kimi CLI', binary: 'kimi' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatChannelTarget(msg: any): string {
  return msg.message.channel_type === 'dm'
    ? `dm:@${msg.message.channel_name}`
    : `#${msg.message.channel_name}`;
}

export function summarizeIncomingMessage(msg: { type: string; [key: string]: unknown }): string {
  switch (msg.type) {
    case 'agent:start': {
      const m = msg as any;
      return `(agent=${m.agentId}, runtime=${m.config.runtime}, model=${m.config.model}, session=${m.config.sessionId || 'new'}${m.wakeMessage ? ', wake=true' : ''})`;
    }
    case 'agent:stop': {
      const m = msg as any;
      return `(agent=${m.agentId})`;
    }
    case 'agent:reset-workspace': {
      const m = msg as any;
      return `(agent=${m.agentId})`;
    }
    case 'agent:deliver': {
      const m = msg as any;
      return `(agent=${m.agentId}, seq=${m.seq}, from=@${m.message.sender_name}, target=${formatChannelTarget(m)})`;
    }
    case 'agent:workspace:list': {
      const m = msg as any;
      return `(agent=${m.agentId}, dir=${m.dirPath || '.'})`;
    }
    case 'agent:workspace:read': {
      const m = msg as any;
      return `(agent=${m.agentId}, path=${m.path})`;
    }
    case 'agent:skills:list': {
      const m = msg as any;
      return `(agent=${m.agentId}, runtime=${m.runtime || 'auto'})`;
    }
    case 'machine:workspace:delete': {
      const m = msg as any;
      return `(directory=${m.directoryName})`;
    }
    default:
      return '';
  }
}

function detectRuntimes(): { ids: string[]; versions: Record<string, string> } {
  const ids: string[] = [];
  const versions: Record<string, string> = {};
  const cmd = process.platform === 'win32' ? 'where' : 'which';

  for (const rt of RUNTIMES) {
    try {
      execSync(`${cmd} ${rt.binary}`, { stdio: 'pipe' });
      ids.push(rt.id);
      try {
        const ver = execSync(`${rt.binary} --version`, { stdio: 'pipe', timeout: 5000 })
          .toString()
          .trim()
          .split('\n')[0];
        versions[rt.id] = ver;
      } catch {
        // version fetch is optional; ignore errors
      }
    } catch {
      // binary not found; skip
    }
  }

  return { ids, versions };
}

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let serverUrl = '';
let apiKey = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--server-url' && args[i + 1]) serverUrl = args[++i];
  if (args[i] === '--api-key' && args[i + 1]) apiKey = args[++i];
}

if (!serverUrl || !apiKey) {
  console.error('Usage: slock-daemon --server-url <url> --api-key <key>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Resolve chat-bridge path
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let chatBridgePath = path.resolve(__dirname, 'chat-bridge.js');
try {
  accessSync(chatBridgePath);
} catch {
  chatBridgePath = path.resolve(__dirname, 'chat-bridge.ts');
}

// ---------------------------------------------------------------------------
// Create manager and connection
// ---------------------------------------------------------------------------

let connection: DaemonConnection;

const agentManager = new AgentProcessManager(
  chatBridgePath,
  (msg) => {
    connection.send(msg);
  },
  apiKey,
);

connection = new DaemonConnection({
  serverUrl,
  apiKey,

  onConnect: () => {
    const { ids: runtimes, versions: runtimeVersions } = detectRuntimes();
    const runtimeInfo = runtimes.map((id) =>
      runtimeVersions[id] ? `${id} (${runtimeVersions[id]})` : id,
    );
    logger.info(`[Daemon] Detected runtimes: ${runtimeInfo.join(', ') || 'none'}`);

    connection.send({
      type: 'ready',
      capabilities: ['agent:start', 'agent:stop', 'agent:deliver', 'workspace:files', 'workspace:list', 'workspace:read', 'skills:list'],
      runtimes,
      runningAgents: agentManager.getRunningAgentIds(),
      hostname: os.hostname(),
      os: `${os.platform()} ${os.arch()}`,
      daemonVersion: DAEMON_VERSION,
    });

    // Re-send session IDs for running agents
    for (const agentId of agentManager.getRunningAgentIds()) {
      const sessionId = agentManager.getAgentSessionId(agentId);
      const launchId = agentManager.getAgentLaunchId(agentId);
      if (sessionId) {
        connection.send({ type: 'agent:session', agentId, sessionId, launchId: launchId || undefined });
      }
    }

    // Re-send session IDs for idle agents
    for (const { agentId, sessionId, launchId } of agentManager.getIdleAgentSessionIds()) {
      connection.send({ type: 'agent:session', agentId, sessionId, launchId: launchId || undefined });
    }
  },

  onMessage: (msg: { type: string; [key: string]: any }) => {
    const summary = summarizeIncomingMessage(msg);
    logger.info(`[Daemon] Received ${msg.type}${summary ? ` ${summary}` : ''}`);

    switch (msg.type) {
      case 'agent:start':
        logger.info(
          `[Agent ${msg.agentId}] Start requested (runtime=${msg.config.runtime}, model=${msg.config.model}, session=${msg.config.sessionId || 'new'}${msg.wakeMessage ? ', wake=true' : ''})`,
        );
        agentManager
          .startAgent(msg.agentId, msg.config, msg.wakeMessage, msg.unreadSummary, msg.resumePrompt, msg.launchId)
          .catch((err: unknown) => {
            const reason = err instanceof Error ? err.message : String(err);
            logger.error(`[Agent ${msg.agentId}] Start failed (${reason})`);
            connection.send({ type: 'agent:status', agentId: msg.agentId, status: 'inactive', launchId: msg.launchId });
            connection.send({
              type: 'agent:activity',
              agentId: msg.agentId,
              activity: 'offline',
              detail: `Start failed: ${reason}`,
              launchId: msg.launchId,
            });
          });
        break;

      case 'agent:stop':
        logger.info(`[Agent ${msg.agentId}] Stop requested`);
        agentManager.stopAgent(msg.agentId);
        break;

      case 'agent:deliver':
        logger.info(
          `[Agent ${msg.agentId}] Delivery received (seq=${msg.seq}, from=@${msg.message.sender_name}, target=${formatChannelTarget(msg)})`,
        );
        agentManager.deliverMessage(msg.agentId, msg.message);
        connection.send({ type: 'agent:deliver:ack', agentId: msg.agentId, seq: msg.seq });
        break;

      case 'ping':
        connection.send({ type: 'pong' });
        break;

      case 'agent:workspace:list':
        agentManager.getFileTree(msg.agentId, msg.dirPath).then((files) => {
          connection.send({ type: 'agent:workspace:list:result', agentId: msg.agentId, files });
        }).catch((err: unknown) => {
          connection.send({ type: 'agent:workspace:list:result', agentId: msg.agentId, files: [], error: String(err) });
        });
        break;

      case 'agent:workspace:read':
        agentManager.readFile(msg.agentId, msg.path).then((result) => {
          connection.send({ type: 'agent:workspace:read:result', agentId: msg.agentId, path: msg.path, ...result });
        }).catch((err: unknown) => {
          connection.send({ type: 'agent:workspace:read:result', agentId: msg.agentId, path: msg.path, content: null, error: String(err) });
        });
        break;

      case 'agent:skills:list':
        agentManager.listSkills(msg.agentId, msg.runtime).then((skills) => {
          connection.send({ type: 'agent:skills:list:result', agentId: msg.agentId, ...skills });
        }).catch((err: unknown) => {
          connection.send({ type: 'agent:skills:list:result', agentId: msg.agentId, global: [], workspace: [], error: String(err) });
        });
        break;

      case 'machine:workspace:list':
        agentManager.scanAllWorkspaces().then((workspaces) => {
          connection.send({ type: 'machine:workspace:list:result', workspaces });
        }).catch(() => {
          connection.send({ type: 'machine:workspace:list:result', workspaces: [] });
        });
        break;

      case 'machine:workspace:delete':
        agentManager.deleteWorkspaceDirectory(msg.directoryName).then((success) => {
          connection.send({ type: 'machine:workspace:delete:result', directoryName: msg.directoryName, success });
        }).catch(() => {
          connection.send({ type: 'machine:workspace:delete:result', directoryName: msg.directoryName, success: false });
        });
        break;
    }
  },

  onDisconnect: () => {
    logger.warn('[Daemon] Lost connection \u2014 agents continue running locally');
  },
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

logger.info('[Slock Daemon] Starting...');
connection.connect();

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async () => {
  logger.info('[Slock Daemon] Shutting down...');
  await agentManager.stopAll();
  connection.disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
