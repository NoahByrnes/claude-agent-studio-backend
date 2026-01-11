/**
 * Conductor Manager
 *
 * Manages conductor and worker CLI sessions.
 * Uses claude -p --resume for stateful conversations.
 */

import { CLIExecutor } from './cli-executor';
import type {
  ConductorSession,
  WorkerSession,
  IncomingMessage,
  WorkerReport,
  DetectedCommand,
  ConductorCLIConfig,
  CLIResponse,
} from './types';

export interface ConductorManagerEvents {
  onConductorOutput?: (output: string, response: CLIResponse) => void;
  onWorkerSpawned?: (workerId: string, task: string) => void;
  onWorkerOutput?: (workerId: string, output: string) => void;
  onWorkerComplete?: (workerId: string, result: string) => void;
  onSendEmail?: (to: string, subject: string, body: string) => Promise<void>;
  onSendSMS?: (to: string, message: string) => Promise<void>;
  onError?: (error: Error) => void;
}

export class ConductorManager {
  private cli: CLIExecutor;
  private config: ConductorCLIConfig;
  private events: ConductorManagerEvents;

  private conductorSession: ConductorSession | null = null;
  private workerSessions: Map<string, WorkerSession> = new Map();

  constructor(config: ConductorCLIConfig, events: ConductorManagerEvents = {}) {
    this.config = config;
    this.events = events;
    this.cli = new CLIExecutor(config.workingDirectory);
  }

  // ============================================================================
  // Conductor Lifecycle
  // ============================================================================

  /**
   * Initialize the conductor session.
   */
  async initConductor(): Promise<string> {
    const systemPrompt = this.config.systemPrompt || this.getDefaultConductorPrompt();

    const response = await this.cli.execute(systemPrompt, {
      workingDirectory: this.config.workingDirectory,
    });

    this.conductorSession = {
      id: response.session_id,
      role: 'conductor',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      workingDirectory: this.config.workingDirectory,
      activeWorkers: [],
    };

    console.log(`Conductor initialized: ${response.session_id}`);
    return response.session_id;
  }

  /**
   * Get default conductor system prompt.
   */
  private getDefaultConductorPrompt(): string {
    return `You are a CONDUCTOR agent responsible for managing incoming requests and delegating work.

## Message Format
You receive messages tagged with their source:
- [EMAIL] - Incoming emails
- [SMS] - Text messages
- [USER] - Web interface prompts
- [WORKER:id] - Reports from worker agents

## Commands
Output these commands and they will be executed:
- SPAWN_WORKER: <task description> - Create a worker to handle a task
- SEND_EMAIL: <to> | <subject> | <body> - Send an email response
- SEND_SMS: <to> | <message> - Send an SMS
- KILL_WORKER: <worker-id> - Terminate a worker

## Workflow
1. Receive message → Decide if action needed
2. If complex task → SPAWN_WORKER with clear instructions
3. When worker reports → Validate the work
4. If satisfactory → Send response via SEND_EMAIL/SEND_SMS
5. Cleanup → KILL_WORKER

Acknowledge your role briefly and wait for messages.`;
  }

  // ============================================================================
  // Message Handling
  // ============================================================================

  /**
   * Send a message to the conductor and process the response.
   */
  async sendToConductor(message: IncomingMessage): Promise<CLIResponse> {
    if (!this.conductorSession) {
      throw new Error('Conductor not initialized. Call initConductor() first.');
    }

    const formattedMessage = this.formatMessage(message);

    const response = await this.cli.sendToSession(
      this.conductorSession.id,
      formattedMessage
    );

    this.conductorSession.lastActivityAt = new Date();
    this.events.onConductorOutput?.(response.result, response);

    // Parse response for commands
    const commands = this.parseCommands(response.result);
    await this.executeCommands(commands);

    return response;
  }

  /**
   * Format an incoming message for the conductor.
   */
  private formatMessage(message: IncomingMessage): string {
    const prefix = `[${message.source}]`;
    return `${prefix}\n${message.content}`;
  }

  // ============================================================================
  // Worker Management
  // ============================================================================

  /**
   * Spawn a new worker for a task.
   */
  async spawnWorker(task: string): Promise<string> {
    if (!this.conductorSession) {
      throw new Error('Conductor not initialized');
    }

    const workerPrompt = `You are a WORKER agent. Complete the following task thoroughly.

## Task
${task}

## Reporting
When done, output: TASK_COMPLETE: <summary of what you did>
If blocked, output: TASK_BLOCKED: <what's preventing progress>
For progress updates: TASK_PROGRESS: <current status>

Start working on the task now.`;

    const response = await this.cli.execute(workerPrompt, {
      workingDirectory: this.config.workingDirectory,
    });

    const workerId = response.session_id;

    const workerSession: WorkerSession = {
      id: workerId,
      role: 'worker',
      conductorId: this.conductorSession.id,
      task,
      status: 'running',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      workingDirectory: this.config.workingDirectory,
    };

    this.workerSessions.set(workerId, workerSession);
    this.conductorSession.activeWorkers.push(workerId);

    this.events.onWorkerSpawned?.(workerId, task);
    console.log(`Worker spawned: ${workerId}`);

    // Check if worker already completed (short tasks)
    const workerResult = this.parseWorkerStatus(response.result);
    if (workerResult.status !== 'running') {
      await this.handleWorkerReport(workerId, workerResult);
    }

    return workerId;
  }

  /**
   * Send a message to a worker.
   */
  async sendToWorker(workerId: string, message: string): Promise<CLIResponse> {
    const worker = this.workerSessions.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    const response = await this.cli.sendToSession(workerId, message);
    worker.lastActivityAt = new Date();

    this.events.onWorkerOutput?.(workerId, response.result);

    // Check worker status
    const status = this.parseWorkerStatus(response.result);
    if (status.status !== 'running') {
      await this.handleWorkerReport(workerId, status);
    }

    return response;
  }

  /**
   * Handle a worker report (completion, blocked, etc.).
   */
  private async handleWorkerReport(
    workerId: string,
    report: { status: WorkerSession['status']; summary: string }
  ): Promise<void> {
    const worker = this.workerSessions.get(workerId);
    if (!worker) return;

    worker.status = report.status;

    if (report.status === 'complete' || report.status === 'error' || report.status === 'blocked') {
      // Notify conductor
      const workerReport: IncomingMessage = {
        source: 'WORKER',
        content: `Worker ${workerId} reports:
Status: ${report.status.toUpperCase()}
Summary: ${report.summary}`,
      };

      await this.sendToConductor(workerReport);
      this.events.onWorkerComplete?.(workerId, report.summary);
    }
  }

  /**
   * Kill a worker session.
   */
  killWorker(workerId: string): void {
    const worker = this.workerSessions.get(workerId);
    if (!worker) return;

    this.workerSessions.delete(workerId);

    if (this.conductorSession) {
      this.conductorSession.activeWorkers = this.conductorSession.activeWorkers.filter(
        (id) => id !== workerId
      );
    }

    console.log(`Worker killed: ${workerId}`);
  }

  // ============================================================================
  // Command Parsing & Execution
  // ============================================================================

  /**
   * Parse conductor output for commands.
   */
  private parseCommands(output: string): DetectedCommand[] {
    const commands: DetectedCommand[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // SPAWN_WORKER: <task>
      if (trimmed.startsWith('SPAWN_WORKER:')) {
        const task = trimmed.slice('SPAWN_WORKER:'.length).trim();
        commands.push({ type: 'spawn-worker', payload: { task } });
      }

      // SEND_EMAIL: <to> | <subject> | <body>
      if (trimmed.startsWith('SEND_EMAIL:')) {
        const parts = trimmed.slice('SEND_EMAIL:'.length).split('|').map((s) => s.trim());
        if (parts.length >= 3) {
          commands.push({
            type: 'send-email',
            payload: { to: parts[0], subject: parts[1], body: parts.slice(2).join('|') },
          });
        }
      }

      // SEND_SMS: <to> | <message>
      if (trimmed.startsWith('SEND_SMS:')) {
        const parts = trimmed.slice('SEND_SMS:'.length).split('|').map((s) => s.trim());
        if (parts.length >= 2) {
          commands.push({
            type: 'send-sms',
            payload: { to: parts[0], message: parts.slice(1).join('|') },
          });
        }
      }

      // KILL_WORKER: <worker-id>
      if (trimmed.startsWith('KILL_WORKER:')) {
        const workerId = trimmed.slice('KILL_WORKER:'.length).trim();
        commands.push({ type: 'kill-worker', payload: { workerId } });
      }
    }

    return commands;
  }

  /**
   * Parse worker output for status.
   */
  private parseWorkerStatus(output: string): { status: WorkerSession['status']; summary: string } {
    const lines = output.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('TASK_COMPLETE:')) {
        return {
          status: 'complete',
          summary: trimmed.slice('TASK_COMPLETE:'.length).trim(),
        };
      }

      if (trimmed.startsWith('TASK_BLOCKED:')) {
        return {
          status: 'blocked',
          summary: trimmed.slice('TASK_BLOCKED:'.length).trim(),
        };
      }

      if (trimmed.startsWith('TASK_ERROR:')) {
        return {
          status: 'error',
          summary: trimmed.slice('TASK_ERROR:'.length).trim(),
        };
      }
    }

    return { status: 'running', summary: output.slice(0, 200) };
  }

  /**
   * Execute detected commands.
   */
  private async executeCommands(commands: DetectedCommand[]): Promise<void> {
    for (const cmd of commands) {
      try {
        switch (cmd.type) {
          case 'spawn-worker':
            if (cmd.payload?.task) {
              await this.spawnWorker(cmd.payload.task);
            }
            break;

          case 'send-email':
            if (cmd.payload && this.events.onSendEmail) {
              await this.events.onSendEmail(
                cmd.payload.to,
                cmd.payload.subject,
                cmd.payload.body
              );
            }
            break;

          case 'send-sms':
            if (cmd.payload && this.events.onSendSMS) {
              await this.events.onSendSMS(cmd.payload.to, cmd.payload.message);
            }
            break;

          case 'kill-worker':
            if (cmd.payload?.workerId) {
              this.killWorker(cmd.payload.workerId);
            }
            break;
        }
      } catch (error) {
        console.error(`Failed to execute command ${cmd.type}:`, error);
        this.events.onError?.(error as Error);
      }
    }
  }

  // ============================================================================
  // Status & Info
  // ============================================================================

  /**
   * Get conductor session info.
   */
  getConductorSession(): ConductorSession | null {
    return this.conductorSession;
  }

  /**
   * Get all worker sessions.
   */
  getWorkerSessions(): WorkerSession[] {
    return Array.from(this.workerSessions.values());
  }

  /**
   * Check if conductor is initialized.
   */
  isInitialized(): boolean {
    return this.conductorSession !== null;
  }
}
