/**
 * Conductor E2B Service
 *
 * Manages conductor and worker CLI sessions in E2B sandboxes.
 * This replaces the direct Agent SDK approach with the conductor/worker pattern.
 */

import { Sandbox } from 'e2b';
import { E2BCLIExecutor } from './cli-executor-e2b.js';
import {
  importMemoryToSandbox,
  exportMemoryFromSandbox,
} from '../services/memory.service.js';
import {
  deliverFilesFromSandbox,
  parseDeliverFileCommand,
} from '../services/file-delivery.service.js';
import { addCLIOutput } from '../routes/monitoring.js';
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

        // Import memory from previous sessions (if exists)
        await importMemoryToSandbox(sandbox, 'conductor');

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
    let attemptCount = 0;

    console.log(`   ⏳ Waiting for Claude CLI in sandbox ${sandbox.sandboxId}... (timeout: ${timeoutMs / 1000}s)`);

    while (Date.now() - startTime < timeoutMs) {
      attemptCount++;
      try {
        const result = await sandbox.commands.run('which claude', { timeoutMs: 5000 });

        if (result.exitCode === 0) {
          console.log(`   ✅ Claude CLI ready (took ${attemptCount} attempts, ${Math.round((Date.now() - startTime) / 1000)}s)`);
          return;
        } else {
          console.log(`   ⏳ Attempt ${attemptCount}: Claude CLI not found yet (exit code ${result.exitCode})`);
        }
      } catch (error: any) {
        console.log(`   ⏳ Attempt ${attemptCount}: Error checking CLI: ${error.message}`);
      }

      await new Promise(resolve => setTimeout(resolve, 2000)); // Check every 2 seconds
    }

    throw new Error(`Timeout waiting for Claude CLI to be ready after ${attemptCount} attempts (${Math.round((Date.now() - startTime) / 1000)}s)`);
  }

  /**
   * Get default conductor system prompt.
   */
  private getDefaultConductorPrompt(): string {
    return `You are the CONDUCTOR orchestrating OTHER CLAUDE CODE INSTANCES as autonomous workers.

## CRITICAL: You Have NO Direct Tool Access
You CANNOT write files, run commands, or do any direct work. You ONLY orchestrate workers.
**ALL work must be delegated to workers via SPAWN_WORKER.**

## MANDATORY REPLY RULE
**EVERY [SMS] OR [EMAIL] MESSAGE REQUIRES A RESPONSE - NO EXCEPTIONS!**

If you receive:
- [SMS] → You MUST output SEND_SMS: <phone> | <message>
- [EMAIL] → You MUST output SEND_EMAIL: <email> | <subject> | <body>
- [USER] → Reply conversationally (no command needed)

**Commands like LIST_WORKERS, SPAWN_WORKER are for taking actions, NOT for replying!**
**After using info commands (LIST_WORKERS), you MUST follow up with SEND_SMS/SEND_EMAIL!**

## Platform-Specific Response Formatting

**[SMS] Messages - ALWAYS use SEND_SMS command:**
- **REQUIRED FORMAT**: SEND_SMS: <phone-number> | <message>
- Keep message SHORT (under 160 chars ideal, max 320 chars)
- Plain text only (no markdown, no special characters)
- Get straight to the point - no long pleasantries
- Examples:
  ✓ SEND_SMS: +16041234567 | Done! Report sent to your email.
  ✓ SEND_SMS: +16041234567 | Working on it. ETA 5 min.
  ✗ Just replying conversationally without SEND_SMS command
  ✗ Using LIST_WORKERS without following up with SEND_SMS

**[EMAIL] Messages - ALWAYS use SEND_EMAIL command:**
- **REQUIRED FORMAT**: SEND_EMAIL: <email> | <subject> | <body>
- Can be detailed with proper formatting
- Professional tone with structure
- Example:
  ✓ SEND_EMAIL: user@example.com | Analysis Complete | Here are the results...

**[USER] Messages - Direct conversation (no command needed):**
- Conversational but professional
- Can be detailed with structure
- Use markdown formatting when helpful

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
**DELIVER_FILE: <to> | <file-paths> | <subject> | <message>** - Extracts files from worker sandbox and emails them
**KILL_WORKER: <worker-id>** - Terminates specific worker (use the ID from [WORKER:id] tags)
**KILL_WORKER: *** - Terminates ALL active workers (use when done with all tasks)
**LIST_WORKERS** - Shows all active workers with their IDs and tasks (use to check what's running)

Example DELIVER_FILE usage:
DELIVER_FILE: user@example.com | /tmp/report.pdf, /tmp/data.csv | Analysis Complete | Here are the files you requested

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

Example Flow with LIST_WORKERS (Note: LIST_WORKERS alone is NOT a reply!):
[SMS] "What workers are running?"

You: "LIST_WORKERS"  ← Info gathering command
[SYSTEM] Active Workers (2):
1. [WORKER:abc123] - Research skiing conditions near Vancouver...
2. [WORKER:def456] - Analyze Q4 sales data and generate report...

You: "SEND_SMS: +16041234567 | 2 workers active: ski research + Q4 sales analysis"  ← REQUIRED REPLY

Another example - no workers:
[SMS] "What workers are running?"

You: "LIST_WORKERS"  ← Info gathering
[SYSTEM] No active workers currently running.

You: "SEND_SMS: +16041234567 | No workers running right now."  ← REQUIRED REPLY

Example - killing a worker:
[SMS] "Kill all workers"

You: "LIST_WORKERS"  ← Check what's running first
[SYSTEM] Active Workers (1):
1. [WORKER:abc123] - Research skiing conditions...

You: "KILL_WORKER: *"  ← Kill all workers
You: "SEND_SMS: +16041234567 | All workers stopped."  ← REQUIRED REPLY

Example Flow:
[EMAIL] "Analyze Q4 sales and send report"

You: "SPAWN_WORKER: Access sales database, analyze Q4 2024 data, calculate key metrics (revenue, growth, top products), generate summary report"

[WORKER:abc123] "Found Q4 data. Should I include international sales or just domestic?"

You: "Include both, with a breakdown by region"

[WORKER:abc123] "Analysis complete: Total $2.4M (+15% vs Q3), top product is Widget A ($800K). Report saved to /tmp/q4-report.md"

You: [review the report] "Good work. Add a forecast section for Q1 2025 based on trends"

[WORKER:abc123] "Updated report with Q1 forecast: projected $2.7M based on 12% growth trend"

You: "SEND_EMAIL: client@example.com | Q4 Sales Analysis | [report content from /tmp/q4-report.md]"
You: "KILL_WORKER: abc123"   ← Use the actual worker ID from [WORKER:abc123]

**IMPORTANT: Always kill workers when done to save costs. Use KILL_WORKER: * to kill all active workers.**

**You're orchestrating AND mentoring Claude workers.** Answer their questions, vet their work, iterate until quality is right.

## CRITICAL REMINDERS (Read this before EVERY response!)
1. **EVERY [SMS] REQUIRES SEND_SMS output** - no exceptions!
2. **EVERY [EMAIL] REQUIRES SEND_EMAIL output** - no exceptions!
3. **LIST_WORKERS, SPAWN_WORKER, KILL_WORKER are actions, NOT replies!**
4. **After using info commands, ALWAYS follow up with SEND_SMS/SEND_EMAIL!**
5. **If you forget to use SEND_SMS/SEND_EMAIL, your reply will NEVER reach the user!**`;
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

    // Capture incoming message to CLI feed
    addCLIOutput({
      timestamp: new Date(),
      source: 'conductor',
      sourceId: this.conductorSession.id,
      content: formattedMessage,
      type: 'input',
    });

    const response = await this.conductorSandbox.executor.sendToSession(
      this.conductorSession.id,
      formattedMessage,
      {
        skipPermissions: true, // Conductor runs autonomously
        timeout: 300000 // 5 minutes for conductor thinking/planning
      }
    );

    this.conductorSession.lastActivityAt = new Date();
    this.events.onConductorOutput?.(response.result, response);

    console.log(`💬 Conductor response: ${response.result.substring(0, 200)}...`);

    // Capture conductor output to CLI feed
    addCLIOutput({
      timestamp: new Date(),
      source: 'conductor',
      sourceId: this.conductorSession.id,
      content: response.result,
      type: 'output',
    });

    // Parse response for commands
    const commands = this.parseCommands(response.result);
    await this.executeCommands(commands);

    // Export memory after each conversation (async, don't await)
    this.exportMemory().catch((error) => {
      console.error('⚠️  Failed to export memory:', error.message);
    });

    return response;
  }

  /**
   * Export conductor memory to persistent storage.
   * Called automatically after each conversation.
   */
  private async exportMemory(): Promise<void> {
    if (!this.conductorSandbox) {
      return;
    }

    try {
      await exportMemoryFromSandbox(this.conductorSandbox.sandbox, 'conductor');
    } catch (error: any) {
      console.error('❌ Memory export failed:', error.message);
      // Don't throw - memory export is not critical
    }
  }

  /**
   * Format an incoming message for the conductor.
   */
  private formatMessage(message: IncomingMessage): string {
    const prefix = `[${message.source}]`;

    // Add platform-specific reminder for SMS
    let platformReminder = '';
    if (message.source === 'SMS') {
      platformReminder = '\n(CRITICAL REMINDER: This requires a SEND_SMS reply! Commands like LIST_WORKERS are NOT replies - you must output SEND_SMS: <phone> | <message>. Keep message SHORT under 160 chars!)\n';
    } else if (message.source === 'EMAIL') {
      platformReminder = '\n(CRITICAL REMINDER: This requires a SEND_EMAIL reply! Commands like SPAWN_WORKER are NOT replies - you must output SEND_EMAIL: <email> | <subject> | <body>)\n';
    }

    return `${prefix}${platformReminder}\n${message.content}`;
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

    // Create worker sandbox with retry logic (same as conductor)
    const maxRetries = 3;
    let lastError: Error | undefined;
    let sandbox: Sandbox | undefined;
    let executor: E2BCLIExecutor | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`   🎯 Creating worker E2B sandbox (attempt ${attempt}/${maxRetries})...`);

        // Create E2B sandbox for worker (lives until explicitly killed)
        // Uses SAME template and settings as conductor
        sandbox = await Sandbox.create(this.config.e2bTemplateId, {
          apiKey: this.config.e2bApiKey,
          metadata: {
            role: 'worker',
            conductorId: this.conductorSession.id,
            type: 'cli-session',
          },
          // No auto-timeout - conductor controls worker lifecycle
          // Workers run until explicitly killed with KILL_WORKER command
          timeoutMs: 0,
          // Allow 5 minutes for sandbox creation (same as conductor)
          requestTimeoutMs: 300000,
        });

        console.log(`   ✅ Worker sandbox created: ${sandbox.sandboxId}`);

        // Wait for CLI (same timeout as conductor - they use same template)
        await this.waitForCLI(sandbox);

        executor = new E2BCLIExecutor(sandbox, process.env.ANTHROPIC_API_KEY);

        // Success - break out of retry loop
        break;

      } catch (error) {
        lastError = error as Error;
        console.warn(`   ⚠️  Worker creation attempt ${attempt}/${maxRetries} failed:`, lastError.message);

        // Clean up failed sandbox if it was created
        if (sandbox) {
          try {
            await sandbox.kill();
          } catch (cleanupError) {
            console.warn(`   ⚠️  Failed to cleanup sandbox:`, cleanupError);
          }
        }

        // If we have more retries, wait before trying again
        if (attempt < maxRetries) {
          const waitTime = attempt * 5000; // Exponential backoff: 5s, 10s
          console.log(`   ⏳ Retrying in ${waitTime / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    if (!sandbox || !executor) {
      throw new Error(
        `Failed to create worker after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`
      );
    }

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
      timeout: 600000, // 10 minutes for complex tasks like research, web browsing
    });
    const workerId = initialResponse.session_id;

    console.log(`   ✅ Worker ${workerId} started, received initial response`);

    // Capture initial worker task to CLI feed
    addCLIOutput({
      timestamp: new Date(),
      source: 'worker',
      sourceId: workerId,
      content: `[NEW WORKER TASK]: ${task}`,
      type: 'system',
    });

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
      // Capture worker output to CLI feed
      addCLIOutput({
        timestamp: new Date(),
        source: 'worker',
        sourceId: workerId,
        content: currentWorkerResponse.result,
        type: 'output',
      });

      // Format worker's message for conductor
      const workerMessage = `[WORKER:${workerId}]\n${currentWorkerResponse.result}`;
      console.log(`   📥 Worker → Conductor: ${currentWorkerResponse.result.substring(0, 150)}...`);

      // Send worker's response to conductor
      const conductorResponse = await this.conductorSandbox!.executor.sendToSession(
        this.conductorSession!.id,
        workerMessage,
        { timeout: 300000 } // 5 minutes for conductor thinking/planning
      );

      console.log(`   📤 Conductor response: ${conductorResponse.result.substring(0, 150)}...`);

      // Parse conductor's response for commands
      const commands = this.parseCommands(conductorResponse.result);

      // Check if conductor wants to end conversation with this worker
      const hasKillWorker = commands.some(cmd => cmd.type === 'kill-worker');
      const hasEmailOrSms = commands.some(cmd => cmd.type === 'send-email' || cmd.type === 'send-sms');

      if (hasKillWorker || hasEmailOrSms) {
        console.log(`   ✅ Conductor finished with worker ${workerId.substring(0, 8)}`);
        conversationActive = false;
        // Execute any final commands (like SEND_EMAIL, KILL_WORKER)
        await this.executeCommands(commands);

        // Safety: If conductor sent final reply but didn't kill this specific worker, kill it now
        if (hasEmailOrSms && !commands.some(cmd => cmd.type === 'kill-worker' && cmd.payload?.workerId === workerId)) {
          console.log(`   🧹 Auto-cleanup: Killing worker ${workerId.substring(0, 8)} (conductor sent final reply)`);
          await this.killWorker(workerId);
        }
        break;
      }

      // Check if conductor is addressing the worker (continuing conversation)
      // If the response doesn't contain commands, it's a message for the worker
      if (commands.length === 0 || !commands.some(cmd => cmd.type === 'spawn-worker')) {
        // Send conductor's message to worker
        console.log(`   📤 Conductor → Worker: ${conductorResponse.result.substring(0, 100)}...`);

        // Capture conductor's message to worker in CLI feed
        addCLIOutput({
          timestamp: new Date(),
          source: 'worker',
          sourceId: workerId,
          content: `[CONDUCTOR → WORKER]: ${conductorResponse.result}`,
          type: 'input',
        });

        const sandboxInfo = this.workerSandboxes.get(workerId);
        if (sandboxInfo) {
          currentWorkerResponse = await sandboxInfo.executor.sendToSession(
            workerId,
            conductorResponse.result,
            {
              skipPermissions: true, // Workers run autonomously
              timeout: 600000 // 10 minutes for worker tasks
            }
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
   * List active workers and send info to conductor.
   * The conductor will respond to the SYSTEM message, and we need to process that response.
   */
  async listWorkersForConductor(): Promise<void> {
    if (!this.conductorSession || !this.conductorSandbox) return;

    const activeWorkers = this.getActiveWorkers();

    let systemMessage: string;
    if (activeWorkers.length === 0) {
      console.log('📋 LIST_WORKERS: No active workers');
      systemMessage = '[SYSTEM] No active workers currently running.\n(REMINDER: You must now send your reply to the user using SEND_SMS or SEND_EMAIL!)';
    } else {
      console.log(`📋 LIST_WORKERS: Found ${activeWorkers.length} active workers`);

      // Format worker list concisely
      const workerList = activeWorkers.map((w, idx) => {
        const taskPreview = w.task.substring(0, 60) + (w.task.length > 60 ? '...' : '');
        return `${idx + 1}. [WORKER:${w.id}] - ${taskPreview}`;
      }).join('\n');

      systemMessage = `[SYSTEM] Active Workers (${activeWorkers.length}):\n${workerList}\n\n(REMINDER: You must now send your reply to the user using SEND_SMS or SEND_EMAIL!)`;
    }

    // Send to conductor and get their response
    const response = await this.conductorSandbox.executor.sendToSession(
      this.conductorSession.id,
      systemMessage,
      { timeout: 300000 }
    );

    console.log(`   ✅ Conductor response to LIST_WORKERS: ${response.result.substring(0, 150)}...`);

    // Parse and execute any commands from the conductor's response (should include SEND_SMS/SEND_EMAIL)
    const commands = this.parseCommands(response.result);
    if (commands.length > 0) {
      console.log(`   📤 Executing ${commands.length} command(s) from conductor's response`);
      await this.executeCommands(commands);
    } else {
      console.warn(`   ⚠️  Conductor didn't output any commands after LIST_WORKERS - user won't get a reply!`);
    }
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

      // DELIVER_FILE: <to> | <file-paths> | <subject> | <message>
      if (trimmed.startsWith('DELIVER_FILE:')) {
        const deliveryRequest = parseDeliverFileCommand(trimmed);
        if (deliveryRequest) {
          commands.push({ type: 'deliver-file', payload: deliveryRequest });
        }
      }

      // LIST_WORKERS
      if (trimmed === 'LIST_WORKERS' || trimmed.startsWith('LIST_WORKERS')) {
        commands.push({ type: 'list-workers', payload: {} });
      }

      // KILL_WORKER: <worker-id> or KILL_WORKER: * (kill all)
      if (trimmed.startsWith('KILL_WORKER:')) {
        const workerId = trimmed.slice('KILL_WORKER:'.length).trim();

        // Support wildcard * to kill all workers
        if (workerId === '*' || workerId === 'all') {
          const activeWorkerIds = this.getActiveWorkers().map(w => w.id);
          console.log(`📋 KILL_WORKER wildcard detected, killing ${activeWorkerIds.length} workers`);
          for (const id of activeWorkerIds) {
            commands.push({ type: 'kill-worker', payload: { workerId: id } });
          }
        } else if (workerId) {
          commands.push({ type: 'kill-worker', payload: { workerId } });
        } else {
          console.warn('⚠️  KILL_WORKER command with empty worker ID - ignoring');
        }
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

          case 'deliver-file':
            if (cmd.payload) {
              await this.deliverFiles(cmd.payload);
            }
            break;

          case 'list-workers':
            await this.listWorkersForConductor();
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

  /**
   * Deliver files from the most recent worker to a recipient.
   * Files are extracted from worker sandbox and emailed as attachments.
   */
  private async deliverFiles(request: any): Promise<void> {
    try {
      // Find the most recently active worker
      const activeWorkers = this.getActiveWorkers();
      const allWorkers = Array.from(this.workerSessions.values());
      const latestWorker = allWorkers.sort((a, b) =>
        b.lastActivityAt.getTime() - a.lastActivityAt.getTime()
      )[0];

      if (!latestWorker) {
        console.error('❌ No workers available for file delivery');
        return;
      }

      const workerSandbox = this.workerSandboxes.get(latestWorker.id);
      if (!workerSandbox) {
        console.error(`❌ Worker sandbox not found: ${latestWorker.id}`);
        return;
      }

      console.log(`📦 Delivering files from worker ${latestWorker.id.substring(0, 8)}...`);

      await deliverFilesFromSandbox(workerSandbox.sandbox, request);

      console.log('✅ Files delivered successfully');
    } catch (error: any) {
      console.error('❌ File delivery failed:', error.message);
      throw error;
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
   * Get active workers (running status only).
   */
  getActiveWorkers(): WorkerSession[] {
    return Array.from(this.workerSessions.values()).filter(w => w.status === 'running');
  }

  /**
   * Check if conductor is initialized.
   */
  isInitialized(): boolean {
    return this.conductorSession !== null && this.conductorSandbox !== null;
  }
}
