/**
 * Conductor CLI Types
 *
 * Types for the CLI-based conductor/worker architecture using
 * claude -p --resume for session management in E2B sandboxes.
 */

// ============================================================================
// CLI Response Types
// ============================================================================

export interface CLIResponse {
  type: 'result';
  subtype: 'success' | 'error';
  session_id: string;
  total_cost_usd: number;
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  result: string;
  model?: string;
}

export interface CLIStreamMessage {
  type: 'init' | 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'result';
  session_id?: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };
  tool?: {
    type: string;
    name?: string;
    command?: string;
  };
  result?: string;
  total_cost_usd?: number;
}

// ============================================================================
// Session Types
// ============================================================================

export interface Session {
  id: string;
  role: 'conductor' | 'worker';
  createdAt: Date;
  lastActivityAt: Date;
  sandboxId: string; // E2B sandbox ID
}

export interface ConductorSession extends Session {
  role: 'conductor';
  activeWorkers: string[]; // Worker session IDs
}

export interface WorkerSession extends Session {
  role: 'worker';
  conductorId: string;
  task: string;
  status: 'running' | 'complete' | 'error' | 'blocked';
}

// ============================================================================
// Message Types
// ============================================================================

export type MessageSource = 'EMAIL' | 'SMS' | 'USER' | 'WORKER' | 'SYSTEM';

export interface IncomingMessage {
  source: MessageSource;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerReport {
  workerId: string;
  status: 'PROGRESS' | 'COMPLETE' | 'BLOCKED' | 'ERROR';
  summary: string;
  details?: string;
}

// ============================================================================
// Command Detection
// ============================================================================

export interface DetectedCommand {
  type: 'spawn-worker' | 'send-email' | 'send-sms' | 'kill-worker' | 'none';
  payload?: Record<string, string>;
}

// ============================================================================
// Configuration
// ============================================================================

export interface ConductorCLIConfig {
  e2bApiKey: string;
  e2bTemplateId: string;
  maxTurns?: number;
  model?: string;
  systemPrompt?: string;
}
