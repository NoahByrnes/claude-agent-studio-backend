/**
 * Conductor VM Types
 *
 * Types for the CLI-based conductor/worker architecture.
 */

// ============================================================================
// Messages (what gets injected into conductor CLI)
// ============================================================================

export type MessageSource = 'EMAIL' | 'SMS' | 'USER' | 'WORKER' | 'SYSTEM';

export interface IncomingMessage {
  source: MessageSource;
  timestamp: Date;
  content: MessageContent;
}

export type MessageContent =
  | EmailContent
  | SMSContent
  | UserContent
  | WorkerContent
  | SystemContent;

export interface EmailContent {
  type: 'EMAIL';
  from: string;
  to: string;
  subject: string;
  body: string;
  attachments?: { filename: string; url: string }[];
  threadId?: string;
}

export interface SMSContent {
  type: 'SMS';
  from: string;
  message: string;
}

export interface UserContent {
  type: 'USER';
  userId: string;
  username?: string;
  message: string;
}

export interface WorkerContent {
  type: 'WORKER';
  workerId: string;
  status: 'PROGRESS' | 'QUESTION' | 'BLOCKED' | 'COMPLETE' | 'ERROR';
  summary: string;
  details?: string;
  artifacts?: { name: string; url?: string; description?: string }[];
}

export interface SystemContent {
  type: 'SYSTEM';
  event: 'WORKER_SPAWNED' | 'WORKER_KILLED' | 'EMAIL_SENT' | 'SMS_SENT' | 'ERROR';
  message: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// Commands (what conductor outputs to control infrastructure)
// ============================================================================

export type CommandType =
  | 'spawn-worker'
  | 'message-worker'
  | 'kill-worker'
  | 'send-email'
  | 'send-sms'
  | 'list-workers'
  | 'worker-status';

export interface Command {
  type: CommandType;
  raw: string;
}

export interface SpawnWorkerCommand extends Command {
  type: 'spawn-worker';
  task: string;
  context?: string;
}

export interface MessageWorkerCommand extends Command {
  type: 'message-worker';
  workerId: string;
  message: string;
}

export interface KillWorkerCommand extends Command {
  type: 'kill-worker';
  workerId: string;
}

export interface SendEmailCommand extends Command {
  type: 'send-email';
  to: string;
  subject: string;
  body: string;
}

export interface SendSMSCommand extends Command {
  type: 'send-sms';
  to: string;
  message: string;
}

export interface ListWorkersCommand extends Command {
  type: 'list-workers';
}

export interface WorkerStatusCommand extends Command {
  type: 'worker-status';
  workerId: string;
}

export type ParsedCommand =
  | SpawnWorkerCommand
  | MessageWorkerCommand
  | KillWorkerCommand
  | SendEmailCommand
  | SendSMSCommand
  | ListWorkersCommand
  | WorkerStatusCommand;

// ============================================================================
// VM State
// ============================================================================

export interface ConductorState {
  sandboxId: string;
  status: 'starting' | 'ready' | 'processing' | 'error';
  startedAt: Date;
  lastActivityAt: Date;
  activeWorkers: string[];
}

export interface WorkerState {
  id: string;
  sandboxId: string;
  task: string;
  status: 'starting' | 'running' | 'complete' | 'error';
  startedAt: Date;
  lastOutputAt?: Date;
}

// ============================================================================
// Configuration
// ============================================================================

export interface ConductorConfig {
  e2bApiKey: string;
  conductorTemplateId: string;
  workerTemplateId: string;
  anthropicApiKey: string;
  defaultFromEmail?: string;
  keepAliveIntervalMs?: number;
}
