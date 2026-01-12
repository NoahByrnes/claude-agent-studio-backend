/**
 * Conductor E2B Service
 *
 * Manages conductor and worker CLI sessions in E2B sandboxes.
 * This replaces the direct Agent SDK approach with the conductor/worker pattern.
 */

import { Sandbox } from '@e2b/sdk';
import { E2BCLIExecutor } from './cli-executor-e2b.js';
import type {
  ConductorSession,
  WorkerSession,
  IncomingMessage,
  DetectedCommand,
  ConductorCLIConfig,
  CLIResponse,
} from './types.js';

export interface ConductorE2BEvents {
  onConductorOutput?: (output: string, response: CLIResponse) => void;
  onWorkerSpawned?: (workerId: string, task: string) => void;
  onWorkerOutput?: (workerId: string, output: string) => void;
  onWorkerComplete?: (workerId: string, result: string) => void;
  onSendEmail?: (to: string, subject: string, body: string) => Promise<void>;
  onSendSMS?: (to: string, message: string) => Promise<void>;
  onError?: (error: Error) => void;
}

interface SandboxWithExecutor {
  sandbox: Sandbox;
  executor: E2BCLIExecutor;
}

export class ConductorE2BService {
  private config: ConductorCLIConfig;
  private events: ConductorE2BEvents;

  private conductorSession: ConductorSession | null = null;
  private conductorSandbox: SandboxWithExecutor | null = null;

  private workerSessions: Map<string, WorkerSession> = new Map();
  private workerSandboxes: Map<string, SandboxWithExecutor> = new Map();

  constructor(config: ConductorCLIConfig, events: ConductorE2BEvents = {}) {
    this.config = config;
    this.events = events;
  }

  // ============================================================================
  // Conductor Lifecycle
  // ============================================================================

  /**
   * Initialize the conductor in a long-lived E2B sandbox.
   */
  async initConductor(): Promise<string> {
    console.log('🎯 Creating conductor E2B sandbox...');

    // Create E2B sandbox for conductor (long-lived)
    const sandbox = await Sandbox.create({
      template: this.config.e2bTemplateId,
      apiKey: this.config.e2bApiKey,
      metadata: {
        role: 'conductor',
        type: 'cli-session',
      },
      // Conductor lives for 12 hours
      timeout: 12 * 60 * 60 * 1000,
    });

    console.log(`✅ Conductor sandbox created: ${sandbox.id}`);

    // Wait for Claude CLI to be available
    await this.waitForCLI(sandbox);

    const executor = new E2BCLIExecutor(sandbox);

    // Start conductor CLI session
    const systemPrompt = this.config.systemPrompt || this.getDefaultConductorPrompt();
    const cliSessionId = await executor.startSession(systemPrompt);

    this.conductorSession = {
      id: cliSessionId,
      role: 'conductor',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      sandboxId: sandbox.id,
      activeWorkers: [],
    };

    this.conductorSandbox = { sandbox, executor };

    console.log(`✅ Conductor CLI session started: ${cliSessionId}`);
    console.log(`   Sandbox: ${sandbox.id}`);

    return cliSessionId;
  }

  /**
   * Wait for Claude CLI to be ready in sandbox.
   */
  private async waitForCLI(sandbox: Sandbox, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const result = await sandbox.process.startAndWait({
          cmd: 'which claude',
        });

        if (result.exitCode === 0) {
          console.log('   ✅ Claude CLI ready');
          return;
        }
      } catch (error) {
        // CLI not ready yet
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error('Timeout waiting for Claude CLI to be ready');
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
    if (!this.conductorSession || !this.conductorSandbox) {
      throw new Error('Conductor not initialized. Call initConductor() first.');
    }

    const formattedMessage = this.formatMessage(message);

    console.log(`📨 Sending to conductor: ${formattedMessage.substring(0, 100)}...`);

    const response = await this.conductorSandbox.executor.sendToSession(
      this.conductorSession.id,
      formattedMessage
    );

    this.conductorSession.lastActivityAt = new Date();
    this.events.onConductorOutput?.(response.result, response);

    console.log(`💬 Conductor response: ${response.result.substring(0, 200)}...`);

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
   * Spawn a new worker in a dedicated E2B sandbox.
   */
  async spawnWorker(task: string): Promise<string> {
    if (!this.conductorSession) {
      throw new Error('Conductor not initialized');
    }

    console.log(`🔨 Spawning worker for task: ${task.substring(0, 100)}...`);

    // Create E2B sandbox for worker (short-lived)
    const sandbox = await Sandbox.create({
      template: this.config.e2bTemplateId,
      apiKey: this.config.e2bApiKey,
      metadata: {
        role: 'worker',
        conductorId: this.conductorSession.id,
        type: 'cli-session',
      },
      // Workers live for 30 minutes max
      timeout: 30 * 60 * 1000,
    });

    console.log(`   ✅ Worker sandbox created: ${sandbox.id}`);

    // Wait for CLI
    await this.waitForCLI(sandbox);

    const executor = new E2BCLIExecutor(sandbox);

    // Start worker CLI session
    const workerPrompt = `You are a WORKER agent. Complete the following task thoroughly.

## Task
${task}

## Reporting
When done, output: TASK_COMPLETE: <summary of what you did>
If blocked, output: TASK_BLOCKED: <what's preventing progress>
For progress updates: TASK_PROGRESS: <current status>

Start working on the task now.`;

    const response = await executor.startSession(workerPrompt);
    const workerId = response; // CLI session ID

    const workerSession: WorkerSession = {
      id: workerId,
      role: 'worker',
      conductorId: this.conductorSession.id,
      task,
      status: 'running',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      sandboxId: sandbox.id,
    };

    this.workerSessions.set(workerId, workerSession);
    this.workerSandboxes.set(workerId, { sandbox, executor });
    this.conductorSession.activeWorkers.push(workerId);

    this.events.onWorkerSpawned?.(workerId, task);
    console.log(`✅ Worker spawned: ${workerId} in sandbox ${sandbox.id}`);

    return workerId;
  }

  /**
   * Kill a worker and close its E2B sandbox.
   */
  async killWorker(workerId: string): Promise<void> {
    const worker = this.workerSessions.get(workerId);
    const sandboxInfo = this.workerSandboxes.get(workerId);

    if (!worker || !sandboxInfo) return;

    console.log(`🛑 Killing worker: ${workerId}`);

    // Close E2B sandbox
    try {
      await sandboxInfo.sandbox.close();
      console.log(`   ✅ Worker sandbox closed: ${sandboxInfo.sandbox.id}`);
    } catch (error: any) {
      console.error(`   ⚠️  Error closing worker sandbox:`, error.message);
    }

    this.workerSessions.delete(workerId);
    this.workerSandboxes.delete(workerId);

    if (this.conductorSession) {
      this.conductorSession.activeWorkers = this.conductorSession.activeWorkers.filter(
        (id) => id !== workerId
      );
    }

    console.log(`✅ Worker killed: ${workerId}`);
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
   * Execute detected commands.
   */
  private async executeCommands(commands: DetectedCommand[]): Promise<void> {
    for (const cmd of commands) {
      try {
        console.log(`⚡ Executing command: ${cmd.type}`, cmd.payload);

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
              await this.killWorker(cmd.payload.workerId);
            }
            break;
        }
      } catch (error) {
        console.error(`❌ Failed to execute command ${cmd.type}:`, error);
        this.events.onError?.(error as Error);
      }
    }
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Close all sandboxes and cleanup.
   */
  async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up conductor and workers...');

    // Close all worker sandboxes
    for (const [workerId, sandboxInfo] of this.workerSandboxes.entries()) {
      try {
        await sandboxInfo.sandbox.close();
        console.log(`   ✅ Closed worker sandbox: ${sandboxInfo.sandbox.id}`);
      } catch (error: any) {
        console.error(`   ⚠️  Error closing worker ${workerId}:`, error.message);
      }
    }

    // Close conductor sandbox
    if (this.conductorSandbox) {
      try {
        await this.conductorSandbox.sandbox.close();
        console.log(`   ✅ Closed conductor sandbox: ${this.conductorSandbox.sandbox.id}`);
      } catch (error: any) {
        console.error(`   ⚠️  Error closing conductor:`, error.message);
      }
    }

    this.conductorSession = null;
    this.conductorSandbox = null;
    this.workerSessions.clear();
    this.workerSandboxes.clear();

    console.log('✅ Cleanup complete');
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
    return this.conductorSession !== null && this.conductorSandbox !== null;
  }
}
