import WebSocket from 'ws';
import { logger } from './logger.js';
import { buildWebSocketOptions } from './proxy.js';

// ---------------------------------------------------------------------------

export interface ConnectionOptions {
  serverUrl: string;
  apiKey: string;
  proxyEnv?: Record<string, string | undefined>;
  onConnect: () => void;
  onMessage: (msg: any) => void;
  onDisconnect: () => void;
}

const INBOUND_WATCHDOG_MS = 70_000;

export class DaemonConnection {
  private ws: WebSocket | null = null;
  private options: ConnectionOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldConnect = true;
  private reconnectAttempt = 0;
  private lastDroppedSendLogAt = 0;

  constructor(options: ConnectionOptions) {
    this.options = options;
  }

  connect() {
    this.shouldConnect = true;
    if (this.reconnectTimer) return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    this.doConnect();
  }

  disconnect() {
    this.shouldConnect = false;
    this.clearWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      logger.info('[Daemon] Disconnect requested');
      this.ws.close();
      this.ws = null;
    }
  }

  send(msg: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    const now = Date.now();
    if (now - this.lastDroppedSendLogAt > 5000) {
      this.lastDroppedSendLogAt = now;
      logger.warn(`[Daemon] Dropping outbound message while disconnected: ${msg.type}`);
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private doConnect() {
    if (!this.shouldConnect) return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;

    const wsUrl = this.options.serverUrl.replace(/^http/, 'ws') + `/daemon/connect?key=${this.options.apiKey}`;
    logger.info(`[Daemon] Connecting to ${this.options.serverUrl}...`);

    const proxyOpts = buildWebSocketOptions(wsUrl, this.options.proxyEnv ?? process.env as Record<string, string | undefined>);
    const ws = new WebSocket(wsUrl, proxyOpts);
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws || !this.shouldConnect) return;
      logger.info('[Daemon] Connected to server');
      this.reconnectAttempt = 0;
      this.reconnectDelay = 1000;
      this.resetWatchdog();
      this.options.onConnect();
    });

    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      this.resetWatchdog();
      try {
        const msg = JSON.parse(data.toString());
        this.options.onMessage(msg);
      } catch (err) {
        logger.error('[Daemon] Invalid message from server', err);
      }
    });

    ws.on('close', (code, reasonBuffer) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearWatchdog();
      const reason = reasonBuffer.toString('utf8');
      logger.warn(`[Daemon] Disconnected (code=${code}, reason=${JSON.stringify(reason)})`);
      this.options.onDisconnect();
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      logger.error(`[Daemon] WebSocket error: ${err.message}`);
    });
  }

  private scheduleReconnect() {
    if (!this.shouldConnect || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    logger.info(`[Daemon] Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private resetWatchdog() {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      logger.warn(`[Daemon] No inbound traffic for ${INBOUND_WATCHDOG_MS / 1000}s — forcing reconnect`);
      try { this.ws?.terminate(); } catch {}
    }, INBOUND_WATCHDOG_MS);
  }

  private clearWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
