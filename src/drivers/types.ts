export interface AgentConfig {
  name: string;
  displayName?: string;
  description?: string;
  runtime: string;
  model?: string;
  sessionId?: string | null;
  serverUrl: string;
  authToken?: string;
  envVars?: Record<string, string>;
  reasoningEffort?: string;
}

export interface SpawnContext {
  agentId: string;
  config: AgentConfig;
  prompt: string;
  workingDirectory: string;
  chatBridgePath: string;
  daemonApiKey: string;
}

export interface ParsedEvent {
  kind: 'session_init' | 'thinking' | 'text' | 'tool_call' | 'turn_end' | 'error';
  sessionId?: string;
  text?: string;
  name?: string;
  input?: any;
  message?: string;
}

export interface Driver {
  id: string;
  supportsStdinNotification: boolean;
  mcpToolPrefix: string;
  deliverMessageDirectlyWhileBusy?: boolean;
  spawn(ctx: SpawnContext): { process: import('child_process').ChildProcess };
  parseLine(line: string): ParsedEvent[];
  encodeStdinMessage(text: string, sessionId: string | null, opts?: { mode?: string }): string | null;
  buildSystemPrompt(config: AgentConfig, agentId: string): string;
  toolDisplayName(name: string): string;
  summarizeToolInput(name: string, input: any): string;
}
