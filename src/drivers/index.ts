import { ClaudeDriver } from './claude.js';
import { CodexDriver } from './codex.js';
import { KimiDriver } from './kimi.js';
import { HermesDriver } from './hermes.js';
import type { Driver } from './types.js';

const driverFactories: Record<string, () => Driver> = {
  claude: () => new ClaudeDriver(),
  codex: () => new CodexDriver(),
  kimi: () => new KimiDriver(),
  hermes: () => new HermesDriver(),
};

export function getDriver(runtimeId: string): Driver {
  const factory = driverFactories[runtimeId];
  if (!factory) throw new Error(`Unknown runtime: ${runtimeId}. Available: ${Object.keys(driverFactories).join(', ')}`);
  return factory();
}
