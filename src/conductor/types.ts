/**
 * Conductor/Worker Agent Types
 *
 * These types define the communication protocol between the Conductor
 * (orchestrator) and Workers (task executors).
 */

// ============================================================================
// Incoming Events (what triggers the conductor)
// ============================================================================

export type IncomingEventType = 'email' | 'slack' | 'webhook' | 'scheduled' | 'api';

export interface IncomingEvent {
  id: string;
  type: IncomingEventType;
  timestamp: Date;
  payload: EmailEvent | SlackEvent | WebhookEvent | ScheduledEvent | ApiEvent;
  metadata?: Record<string, unknown>;
}

export interface EmailEvent {
  from: string;
  to: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  attachments?: Attachment[];
  threadId?: string;
  inReplyTo?: string;
}

export interface SlackEvent {
  channel: string;
  user: string;
  text: string;
  threadTs?: string;
  files?: Attachment[];
}

export interface WebhookEvent {
  source: string;
  action: string;
  data: Record<string, unknown>;
}

export interface ScheduledEvent {
  scheduleId: string;
  scheduleName: string;
  cron?: string;
  data?: Record<string, unknown>;
}

export interface ApiEvent {
  endpoint: string;
  method: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface Attachment {
  filename: string;
  url?: string;
  content?: string; // base64
  mimeType: string;
  size?: number;
}

// ============================================================================
// Triage (conductor decides what to do)
// ============================================================================

export type TriageAction = 'ignore' | 'action' | 'defer' | 'escalate';

export interface TriageDecision {
  action: TriageAction;
  reason: string;
  confidence: number; // 0-1
  taskType?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  suggestedApproach?: string;
}

// ============================================================================
// Tasks (what conductor tells workers to do)
// ============================================================================

export interface Task {
  id: string;
  eventId: string;
  description: string;
  instructions: string;
  context: TaskContext;
  constraints: TaskConstraints;
  createdAt: Date;
}

export interface TaskContext {
  originalEvent: IncomingEvent;
  projectInfo?: ProjectInfo;
  previousAttempts?: TaskAttempt[];
  additionalContext?: Record<string, unknown>;
}

export interface ProjectInfo {
  name: string;
  repoUrl?: string;
  branch?: string;
  credentials?: string[]; // Names of secrets to inject
  documentation?: string;
}

export interface TaskConstraints {
  timeout: number; // seconds
  maxRetries: number;
  allowedTools: string[];
  forbiddenActions?: string[];
  requireApproval?: string[]; // Actions that need conductor approval
}

export interface TaskAttempt {
  attemptNumber: number;
  workerId: string;
  startedAt: Date;
  endedAt?: Date;
  result?: WorkerResult;
  failureReason?: string;
}

// ============================================================================
// Worker Messages (worker -> conductor communication)
// ============================================================================

export type WorkerMessageType =
  | 'started'
  | 'progress'
  | 'question'
  | 'blocked'
  | 'approval_request'
  | 'done'
  | 'error';

export interface WorkerMessage {
  type: WorkerMessageType;
  workerId: string;
  taskId: string;
  timestamp: Date;
  payload: WorkerMessagePayload;
}

export type WorkerMessagePayload =
  | StartedPayload
  | ProgressPayload
  | QuestionPayload
  | BlockedPayload
  | ApprovalRequestPayload
  | DonePayload
  | ErrorPayload;

export interface StartedPayload {
  type: 'started';
  plan?: string; // Worker's initial plan
}

export interface ProgressPayload {
  type: 'progress';
  message: string;
  percent?: number;
  currentStep?: string;
  toolsUsed?: string[];
}

export interface QuestionPayload {
  type: 'question';
  question: string;
  context: string;
  options?: string[]; // If there are specific choices
  defaultOption?: string;
}

export interface BlockedPayload {
  type: 'blocked';
  reason: string;
  blockerType: 'missing_info' | 'permission' | 'technical' | 'unclear_requirement';
  suggestedResolution?: string;
}

export interface ApprovalRequestPayload {
  type: 'approval_request';
  action: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  reversible: boolean;
}

export interface DonePayload {
  type: 'done';
  result: WorkerResult;
}

export interface ErrorPayload {
  type: 'error';
  error: string;
  stackTrace?: string;
  recoverable: boolean;
}

// ============================================================================
// Worker Results (what worker produces)
// ============================================================================

export interface WorkerResult {
  success: boolean;
  summary: string;
  detailedReport?: string;
  artifacts: Artifact[];
  actions: ActionTaken[];
  validationHints?: ValidationHints;
  suggestedResponse?: SuggestedResponse;
}

export interface Artifact {
  type: 'file' | 'url' | 'code' | 'data' | 'image';
  name: string;
  description?: string;
  content?: string;
  url?: string;
  mimeType?: string;
}

export interface ActionTaken {
  action: string;
  target: string;
  result: 'success' | 'partial' | 'failed';
  details?: string;
  timestamp: Date;
}

export interface ValidationHints {
  howToVerify: string;
  expectedOutcome: string;
  testSteps?: string[];
}

export interface SuggestedResponse {
  to: string;
  subject?: string;
  body: string;
  attachments?: Artifact[];
}

// ============================================================================
// Validation (conductor validates worker output)
// ============================================================================

export type ValidationStatus = 'valid' | 'partial' | 'invalid' | 'needs_human';

export interface ValidationResult {
  status: ValidationStatus;
  confidence: number; // 0-1
  issues: ValidationIssue[];
  suggestion?: string;
  retryStrategy?: RetryStrategy;
}

export interface ValidationIssue {
  severity: 'info' | 'warning' | 'error';
  description: string;
  location?: string;
}

export type RetryStrategy =
  | { type: 'same_worker'; additionalInstructions: string }
  | { type: 'new_worker'; newApproach: string }
  | { type: 'split_task'; subtasks: string[] }
  | { type: 'escalate'; reason: string };

// ============================================================================
// Conductor Commands (conductor -> worker instructions)
// ============================================================================

export type ConductorCommandType =
  | 'execute'
  | 'continue'
  | 'abort'
  | 'answer'
  | 'approve'
  | 'deny';

export interface ConductorCommand {
  type: ConductorCommandType;
  workerId: string;
  taskId: string;
  payload?: ConductorCommandPayload;
}

export type ConductorCommandPayload =
  | { type: 'execute'; task: Task }
  | { type: 'continue'; instructions?: string }
  | { type: 'abort'; reason: string }
  | { type: 'answer'; question: string; answer: string }
  | { type: 'approve'; action: string }
  | { type: 'deny'; action: string; reason: string };

// ============================================================================
// Orchestration State (what conductor tracks)
// ============================================================================

export type OrchestrationStatus =
  | 'pending'
  | 'triaging'
  | 'spawning'
  | 'running'
  | 'validating'
  | 'retrying'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'escalated';

export interface OrchestrationState {
  id: string;
  eventId: string;
  status: OrchestrationStatus;
  currentTaskId?: string;
  currentWorkerId?: string;
  attempts: TaskAttempt[];
  triageDecision?: TriageDecision;
  validationResult?: ValidationResult;
  finalResult?: WorkerResult;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

// ============================================================================
// Worker State (what worker tracks internally)
// ============================================================================

export type WorkerStatus =
  | 'initializing'
  | 'planning'
  | 'executing'
  | 'waiting_for_answer'
  | 'waiting_for_approval'
  | 'completing'
  | 'done'
  | 'error';

export interface WorkerState {
  id: string;
  taskId: string;
  status: WorkerStatus;
  startedAt: Date;
  lastActivityAt: Date;
  currentStep?: string;
  progress?: number;
  pendingQuestion?: QuestionPayload;
  pendingApproval?: ApprovalRequestPayload;
}
