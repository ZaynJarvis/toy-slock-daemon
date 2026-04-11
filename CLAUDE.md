# Slock Daemon

## Overview

This is the daemon component of the Slock platform. It runs on a machine, connects to the Slock server via WebSocket, and manages AI agent processes (Claude Code, Codex CLI, Kimi CLI).

## Architecture

```
src/
├── domain/                      # Core business logic
│   ├── agent/
│   │   ├── AgentManager.ts      # Agent lifecycle: start/stop/idle/resume/crash recovery
│   │   └── types.ts             # Shared types, constants, message formatting helpers
│   ├── workspace/
│   │   └── WorkspaceService.ts  # File tree browsing, file read, workspace scan/delete
│   └── skills/
│       └── SkillsService.ts     # Skill discovery and SKILL.md parsing
│
├── infrastructure/
│   ├── connection.ts            # WebSocket connection with reconnect + 70s watchdog
│   ├── proxy.ts                 # HTTP/WS proxy support (HTTPS_PROXY, NO_PROXY, etc.)
│   └── logger.ts                # Structured logging
│
├── drivers/                     # Runtime-specific agent drivers
│   ├── claude.ts                # Claude Code (stream-json, stdin notification)
│   ├── codex.ts                 # Codex CLI (process-per-turn)
│   ├── kimi.ts                  # Kimi CLI (JSON-RPC wire protocol)
│   ├── systemPrompt.ts          # Base system prompt builder
│   ├── types.ts                 # Driver interface
│   └── index.ts                 # Driver registry
│
├── chat-bridge.ts               # MCP server (12 tools) — injected into each agent process
└── index.ts                     # CLI entry point + WebSocket message router
```

## Key Design Decisions

- **Two-layer architecture**: `index.ts` (WebSocket daemon) spawns agent processes that get `chat-bridge.ts` (MCP server) injected as their tool provider. These are separate processes.
- **Pull-based message delivery**: Busy agents receive stdin notifications ("You have N new messages"), not full message content. They pull via `check_messages` at their own cadence.
- **Idle cache**: When an agent's turn ends (exit 0), its config and session ID are cached. New messages auto-restart it with the cached session.
- **Driver abstraction**: Each runtime (claude/codex/kimi) implements the `Driver` interface for spawn args, output parsing, and stdin encoding.

## Development

```bash
npm install
npm run build          # tsup — builds dist/index.js + dist/chat-bridge.js
npm run dev            # tsx watch mode
npm test               # node --test
```

## Commit Conventions

- `fix:` for bug fixes, `feat:` for new features, `refactor:` for structural changes
- Keep commits atomic — one logical change per commit
- Run `npm run build` before pushing

## Important Notes

- `chat-bridge.ts` filename must not change — tsup entry point config and runtime path resolution depend on it
- Protocol message types must match the official `@slock-ai/daemon` npm package exactly
- The `ready` message capabilities array must only contain: `agent:start`, `agent:stop`, `agent:deliver`, `workspace:files`
- Agent workspace data lives in `~/.slock/agents/{agentId}/`
