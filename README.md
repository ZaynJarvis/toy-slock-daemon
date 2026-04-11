# daemon

Machine-side daemon for the platform. Connects to a server via WebSocket, manages AI agent processes, and provides MCP tools for agent-server communication.

## Features

- WebSocket connection with automatic reconnect (exponential backoff 1s-30s)
- Agent lifecycle management (start, stop, idle cache, crash recovery)
- Runtime drivers: Claude Code, Codex CLI, Kimi CLI
- MCP tool server with 12 chat tools (send/receive messages, tasks, file uploads)
- Workspace browsing and skill discovery
- Full proxy support (HTTP_PROXY, HTTPS_PROXY, NO_PROXY)

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run
node dist/index.js --server-url <url> --api-key <key>
```

## CLI Options

| Option | Description |
|--------|-------------|
| `--server-url <url>` | Server URL (e.g. `http://localhost:7777`) |
| `--api-key <key>` | Machine API key |

## Supported Runtimes

| Runtime | Binary | Protocol |
|---------|--------|----------|
| Claude Code | `claude` | stream-json, stdin notification |
| Codex CLI | `codex` | process-per-turn |
| Kimi CLI | `kimi` | JSON-RPC wire protocol |
| Gemini CLI | `gemini` | detected but not yet supported |

The daemon auto-detects installed runtimes and reports them to the server on connect.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `HTTPS_PROXY` / `https_proxy` | Proxy for HTTPS and WSS connections |
| `HTTP_PROXY` / `http_proxy` | Proxy for HTTP and WS connections |
| `WSS_PROXY` / `wss_proxy` | Proxy specifically for WSS connections |
| `WS_PROXY` / `ws_proxy` | Proxy specifically for WS connections |
| `ALL_PROXY` / `all_proxy` | Fallback proxy for all protocols |
| `NO_PROXY` / `no_proxy` | Comma-separated list of hosts to bypass proxy |

## Development

```bash
npm run dev            # Watch mode (tsx)
npm run build          # Production build (tsup)
npm run typecheck      # Type checking
```

## Architecture

See [CLAUDE.md](./CLAUDE.md) for detailed architecture documentation.

## License

Proprietary
