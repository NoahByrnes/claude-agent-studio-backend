/**
 * Conductor E2B Service
 *
 * Manages conductor and worker CLI sessions in E2B sandboxes.
 * This replaces the direct Agent SDK approach with the conductor/worker pattern.
 */

import { Sandbox } from 'e2b';
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
   * Implements retry logic for E2B infrastructure reliability.
   */
  async initConductor(): Promise<string> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🎯 Creating conductor E2B sandbox (attempt ${attempt}/${maxRetries})...`);

        // Create E2B sandbox for conductor (long-lived)
        const sandbox = await Sandbox.create(this.config.e2bTemplateId, {
          apiKey: this.config.e2bApiKey,
          metadata: {
            role: 'conductor',
            type: 'cli-session',
          },
          // Conductor lives for 1 hour (E2B max limit)
          timeoutMs: 60 * 60 * 1000,
          // Allow 5 minutes for sandbox creation (template is large with Claude CLI)
          requestTimeoutMs: 300000,
        });

        console.log(`✅ Conductor sandbox created: ${sandbox.sandboxId}`);

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
          sandboxId: sandbox.sandboxId,
          activeWorkers: [],
        };

        this.conductorSandbox = { sandbox, executor };

        console.log(`✅ Conductor CLI session started: ${cliSessionId}`);
        console.log(`   Sandbox: ${sandbox.sandboxId}`);

        return cliSessionId;

      } catch (error) {
        lastError = error as Error;
        console.warn(`⚠️  Attempt ${attempt}/${maxRetries} failed:`, lastError.message);

        // If we have more retries, wait before trying again
        if (attempt < maxRetries) {
          const waitTime = attempt * 5000; // Exponential backoff: 5s, 10s
          console.log(`   Retrying in ${waitTime / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    // All retries failed
    throw new Error(
      `Failed to initialize conductor after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`
    );
  }

  /**
   * Wait for Claude CLI to be ready in sandbox.
   */
  private async waitForCLI(sandbox: Sandbox, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const result = await sandbox.commands.run('which claude');

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
    return `You are the CONDUCTOR orchestrating OTHER CLAUDE CODE INSTANCES as autonomous workers.

## CRITICAL: You Have NO Direct Tool Access
You CANNOT write files, run commands, or do any direct work. You ONLY orchestrate workers.
**ALL work must be delegated to workers via SPAWN_WORKER.**

## What SPAWN_WORKER Really Does
When you output "SPAWN_WORKER: <task>", the system:
1. Creates a new E2B sandbox (full Ubuntu 22.04 environment)
2. Starts a NEW Claude Code CLI session in that sandbox
3. That Claude worker has FULL tool access:
   - Bash (full command line access)
   - Read/Write/Edit (filesystem access)
   - Glob/Grep (search files)
   - Playwright for browser automation
   - Everything needed to complete tasks

## Your Commands (Actually Execute)
**SPAWN_WORKER: <detailed task>** - Spawns autonomous Claude worker
**SEND_EMAIL: <to> | <subject> | <body>** - Sends real email
**SEND_SMS: <to> | <message>** - Sends real SMS
**KILL_WORKER: <worker-id>** - Terminates worker

## Message Sources
- [EMAIL] - External emails
- [SMS] - Text messages
- [USER] - Web dashboard
- [WORKER:id] - Reports from your Claude workers

## How To Orchestrate
**ALWAYS delegate work to workers - even simple tasks.** You'll have a conversation with them:

1. **Spawn**: "SPAWN_WORKER: <detailed instructions>"
2. **Worker may ask questions**: [WORKER:abc123] "Should I use CSV or JSON format?"
3. **You answer**: "Use JSON format for better structure"
4. **Worker submits work**: [WORKER:abc123] "Analysis complete. Results in /tmp/report.json"
5. **You vet the work**: Review their output. If not satisfactory, tell them what to fix
6. **Iterate until satisfied**, then send final response to client
7. **Clean up**: "KILL_WORKER: abc123"

Example Flow:
[EMAIL] "Analyze Q4 sales and send report"

You: "SPAWN_WORKER: Access sales database, analyze Q4 2024 data, calculate key metrics (revenue, growth, top products), generate summary report"

[WORKER:w1] "Found Q4 data. Should I include international sales or just domestic?"

You: "Include both, with a breakdown by region"

[WORKER:w1] "Analysis complete: Total $2.4M (+15% vs Q3), top product is Widget A ($800K). Report saved to /tmp/q4-report.md"

You: [review the report] "Good work. Add a forecast section for Q1 2025 based on trends"

[WORKER:w1] "Updated report with Q1 forecast: projected $2.7M based on 12% growth trend"

You: "SEND_EMAIL: client@example.com | Q4 Sales Analysis | [report content from /tmp/q4-report.md]"
You: "KILL_WORKER: w1"

**You're orchestrating AND mentoring Claude workers.** Answer their questions, vet their work, iterate until quality is right.`;
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
   * Spawn a new worker in a dedicated E2B sandbox and manage conversation.
   */
  async spawnWorker(task: string): Promise<string> {
    if (!this.conductorSession) {
      throw new Error('Conductor not initialized');
    }

    console.log(`🔨 Spawning worker for task: ${task.substring(0, 100)}...`);

    // Create E2B sandbox for worker (short-lived)
    const sandbox = await Sandbox.create(this.config.e2bTemplateId, {
      apiKey: this.config.e2bApiKey,
      metadata: {
        role: 'worker',
        conductorId: this.conductorSession.id,
        type: 'cli-session',
      },
      // Workers live for 30 minutes max
      timeoutMs: 30 * 60 * 1000,
      // Allow 5 minutes for sandbox creation
      requestTimeoutMs: 300000,
    });

    console.log(`   ✅ Worker sandbox created: ${sandbox.sandboxId}`);

    // Wait for CLI
    await this.waitForCLI(sandbox);

    const executor = new E2BCLIExecutor(sandbox, process.env.ANTHROPIC_API_KEY);

    // Start worker CLI session with initial task
    const workerPrompt = `You are an autonomous WORKER agent. A conductor has delegated a task to you.

## Your Task
${task}

## Your Capabilities
You have full access to:
- Bash (run any commands, install packages, execute scripts)
- File system (Read, Write, Edit, Glob, Grep)
- Browser automation (Playwright if needed)
- Any tools installed in this Ubuntu environment

## How to Work
1. Complete the task thoroughly using all available tools
2. When done, provide a complete summary of what you did
3. If you need clarification or are blocked, ask clearly
4. The conductor will review your work and may ask for changes

Begin working on the task now.`;

    console.log(`   📤 Sending initial task to worker...`);
    const initialResponse = await executor.execute(workerPrompt, {
      outputFormat: 'json',
      skipPermissions: true, // Workers run autonomously without permission prompts
    });
    const workerId = initialResponse.session_id;

    console.log(`   ✅ Worker ${workerId} started, received initial response`);

    const workerSession: WorkerSession = {
      id: workerId,
      role: 'worker',
      conductorId: this.conductorSession.id,
      task,
      status: 'running',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      sandboxId: sandbox.sandboxId,
    };

    this.workerSessions.set(workerId, workerSession);
    this.workerSandboxes.set(workerId, { sandbox, executor });
    this.conductorSession.activeWorkers.push(workerId);

    this.events.onWorkerSpawned?.(workerId, task);
    console.log(`✅ Worker spawned: ${workerId} in sandbox ${sandbox.sandboxId}`);

    // Start the conductor-worker conversation loop
    await this.manageWorkerConversation(workerId, initialResponse);

    return workerId;
  }

  /**
   * Manage ongoing conversation between conductor and worker.
   */
  private async manageWorkerConversation(workerId: string, workerResponse: CLIResponse): Promise<void> {
    console.log(`💬 Starting conversation loop: Conductor ↔ Worker ${workerId.substring(0, 8)}`);

    let currentWorkerResponse = workerResponse;
    let conversationActive = true;

    while (conversationActive) {
      // Format worker's message for conductor
      const workerMessage = `[WORKER:${workerId}]\n${currentWorkerResponse.result}`;
      console.log(`   📥 Worker → Conductor: ${currentWorkerResponse.result.substring(0, 150)}...`);

      // Send worker's response to conductor
      const conductorResponse = await this.conductorSandbox!.executor.sendToSession(
        this.conductorSession!.id,
        workerMessage
      );

      console.log(`   📤 Conductor response: ${conductorResponse.result.substring(0, 150)}...`);

      // Parse conductor's response for commands
      const commands = this.parseCommands(conductorResponse.result);

      // Check if conductor wants to end conversation with this worker
      const hasKillWorker = commands.some(cmd => cmd.type === 'kill-worker' && cmd.payload?.workerId === workerId);
      const hasEmailOrSms = commands.some(cmd => cmd.type === 'send-email' || cmd.type === 'send-sms');

      if (hasKillWorker || hasEmailOrSms) {
        console.log(`   ✅ Conductor finished with worker ${workerId.substring(0, 8)}`);
        conversationActive = false;
        // Execute any final commands (like SEND_EMAIL)
        await this.executeCommands(commands);
        break;
      }

      // Check if conductor is addressing the worker (continuing conversation)
      // If the response doesn't contain commands, it's a message for the worker
      if (commands.length === 0 || !commands.some(cmd => cmd.type === 'spawn-worker')) {
        // Send conductor's message to worker
        console.log(`   📤 Conductor → Worker: ${conductorResponse.result.substring(0, 100)}...`);

        const sandboxInfo = this.workerSandboxes.get(workerId);
        if (sandboxInfo) {
          currentWorkerResponse = await sandboxInfo.executor.sendToSession(
            workerId,
            conductorResponse.result,
            { skipPermissions: true } // Workers run autonomously
          );
        } else {
          console.log(`   ⚠️  Worker ${workerId} not found, ending conversation`);
          conversationActive = false;
        }
      } else {
        // Conductor issued new commands, conversation with this worker is done
        console.log(`   ✅ Conductor issued new commands, ending conversation with worker`);
        conversationActive = false;
        await this.executeCommands(commands);
      }
    }

    console.log(`✅ Conversation ended: Conductor ↔ Worker ${workerId.substring(0, 8)}`);
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
      await Sandbox.kill(sandboxInfo.sandbox.sandboxId);
      console.log(`   ✅ Worker sandbox closed: ${sandboxInfo.sandbox.sandboxId}`);
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
      // Remove markdown formatting (**, *, etc.) and trim
      const trimmed = line.replace(/\*\*/g, '').replace(/\*/g, '').trim();

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
        await Sandbox.kill(sandboxInfo.sandbox.sandboxId);
        console.log(`   ✅ Closed worker sandbox: ${sandboxInfo.sandbox.sandboxId}`);
      } catch (error: any) {
        console.error(`   ⚠️  Error closing worker ${workerId}:`, error.message);
      }
    }

    // Close conductor sandbox
    if (this.conductorSandbox) {
      try {
        await Sandbox.kill(this.conductorSandbox.sandbox.sandboxId);
        console.log(`   ✅ Closed conductor sandbox: ${this.conductorSandbox.sandbox.sandboxId}`);
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
