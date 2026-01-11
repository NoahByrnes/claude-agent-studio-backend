/**
 * VM Manager
 *
 * Manages the conductor VM and worker VMs.
 * - Starts and maintains the conductor VM
 * - Spawns worker VMs on conductor command
 * - Routes messages between VMs
 */

import Sandbox from "@e2b/code-interpreter";
import { v4 as uuidv4 } from "uuid";
import { MessageFormatter } from "./message-formatter";
import { CommandParser } from "./command-parser";
import type {
  ConductorConfig,
  ConductorState,
  WorkerState,
  IncomingMessage,
  ParsedCommand,
} from "./types";

// Event handlers for external integration
export interface VMManagerEvents {
  onConductorReady?: () => void;
  onConductorOutput?: (output: string) => void;
  onWorkerSpawned?: (workerId: string, task: string) => void;
  onWorkerOutput?: (workerId: string, output: string) => void;
  onWorkerKilled?: (workerId: string) => void;
  onEmailSend?: (to: string, subject: string, body: string) => Promise<void>;
  onSMSSend?: (to: string, message: string) => Promise<void>;
  onError?: (error: Error) => void;
}

export class VMManager {
  private config: ConductorConfig;
  private events: VMManagerEvents;
  private formatter: MessageFormatter;
  private parser: CommandParser;

  private conductorSandbox: Sandbox | null = null;
  private conductorState: ConductorState | null = null;
  private workers: Map<string, WorkerState> = new Map();
  private workerSandboxes: Map<string, Sandbox> = new Map();

  private messageQueue: IncomingMessage[] = [];
  private isProcessingQueue = false;
  private keepAliveInterval: NodeJS.Timeout | null = null;

  constructor(config: ConductorConfig, events: VMManagerEvents = {}) {
    this.config = config;
    this.events = events;
    this.formatter = new MessageFormatter();
    this.parser = new CommandParser();
  }

  // ============================================================================
  // Conductor Lifecycle
  // ============================================================================

  /**
   * Start the conductor VM.
   */
  async startConductor(): Promise<void> {
    console.log("Starting conductor VM...");

    this.conductorSandbox = await Sandbox.create({
      template: this.config.conductorTemplateId,
      apiKey: this.config.e2bApiKey,
      // Long timeout - conductor is persistent
      timeout: 24 * 60 * 60 * 1000, // 24 hours
    });

    this.conductorState = {
      sandboxId: this.conductorSandbox.sandboxId,
      status: "starting",
      startedAt: new Date(),
      lastActivityAt: new Date(),
      activeWorkers: [],
    };

    console.log(`Conductor sandbox created: ${this.conductorSandbox.sandboxId}`);

    // Initialize conductor with system prompt
    await this.initializeConductor();

    // Start watching for output/commands
    this.startConductorOutputWatcher();

    // Start keep-alive
    this.startKeepAlive();

    this.conductorState.status = "ready";
    this.events.onConductorReady?.();

    console.log("Conductor VM ready");
  }

  /**
   * Initialize conductor with system prompt.
   */
  private async initializeConductor(): Promise<void> {
    if (!this.conductorSandbox) return;

    // Write the system prompt file that the agent will read
    const systemPrompt = this.getConductorSystemPrompt();
    await this.conductorSandbox.files.write(
      "/workspace/.claude/settings.json",
      JSON.stringify({
        permissions: {
          allow: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebFetch"],
          deny: [],
        },
      })
    );

    await this.conductorSandbox.files.write(
      "/workspace/CONDUCTOR_INSTRUCTIONS.md",
      systemPrompt
    );

    // Create inbox directory for messages
    await this.conductorSandbox.commands.run("mkdir -p /workspace/inbox");

    // Start the Claude agent with initial prompt
    // The agent reads instructions and waits for messages
    const initPrompt = `Read /workspace/CONDUCTOR_INSTRUCTIONS.md for your instructions.
Then watch /workspace/inbox/ for incoming messages.
Process each message file as it arrives and delete it after processing.`;

    // Start agent in background
    await this.conductorSandbox.commands.run(
      `cd /workspace && echo '${initPrompt.replace(/'/g, "\\'")}' | npx claude --dangerously-skip-permissions &`,
      { background: true }
    );
  }

  /**
   * Get the conductor system prompt.
   */
  private getConductorSystemPrompt(): string {
    return `# Conductor Agent Instructions

You are a conductor agent responsible for managing incoming requests and delegating work.

## Your Role

You receive messages from various sources:
- **[EMAIL]** - Emails sent to your inbox
- **[SMS]** - Text messages
- **[USER]** - Direct prompts from users via web interface
- **[WORKER:id]** - Output from worker agents you've spawned
- **[SYSTEM]** - System confirmations and errors

## Message Format

Messages arrive in your /workspace/inbox/ directory as files. Each file contains one message:

\`\`\`
[EMAIL]
From: client@example.com
To: agent@yourdomain.com
Subject: Please update the pricing
Body:
Hi, can you update the Basic plan to $29/month?
---
\`\`\`

## Decision Making

For each message:

1. **Triage** - Does this need action?
   - Marketing emails, spam, FYI-only → No action needed
   - Clear requests, questions, tasks → Action needed

2. **Direct or Delegate?**
   - Simple responses, quick answers → Handle directly
   - Complex tasks, coding, research → Spawn a worker

3. **Validate** - When workers complete:
   - Check if output satisfies the original request
   - If good → Send response, kill worker
   - If not → Send clarifying instructions

## Available Commands

Use these slash commands (our infrastructure executes them):

\`\`\`
/spawn-worker <task description>
  Create a new worker VM to handle this task.
  Be specific about what you want done.

/message-worker <worker-id> <message>
  Send additional instructions to a running worker.

/kill-worker <worker-id>
  Terminate a worker when its task is complete.

/send-email <to> "<subject>" "<body>"
  Send an email response.

/send-sms <to> "<message>"
  Send an SMS response.

/list-workers
  See all active workers.

/worker-status <worker-id>
  Get status of a specific worker.
\`\`\`

## Example Interaction

Message arrives:
\`\`\`
[EMAIL]
From: client@example.com
Subject: Update pricing
Body: Please change Basic to $29 and Pro to $79.
\`\`\`

Your response:
\`\`\`
This is a clear request to update pricing. I'll spawn a worker for this.

/spawn-worker Update the pricing on the client landing page.
  - Change Basic plan from current price to $29/month
  - Change Pro plan from current price to $79/month
  - The repo is at github.com/client/landing-page
  - Create a PR when done
\`\`\`

Later, worker reports:
\`\`\`
[WORKER:abc123]
Status: COMPLETE
Summary: Updated pricing, created PR #42
PR URL: https://github.com/client/landing-page/pull/42
\`\`\`

Your response:
\`\`\`
Worker completed successfully. PR looks good. Sending confirmation.

/send-email client@example.com "Re: Update pricing" "Hi! I've updated the pricing as requested. Here's the PR for your review: https://github.com/client/landing-page/pull/42"

/kill-worker abc123
\`\`\`

## Key Principles

1. **Be decisive** - Quickly determine if action is needed
2. **Delegate appropriately** - Use workers for focused tasks
3. **Validate thoroughly** - Check worker output before responding
4. **Communicate clearly** - Keep responses professional and helpful

## Monitoring Inbox

Watch for new files in /workspace/inbox/:
\`\`\`bash
ls /workspace/inbox/
\`\`\`

Read a message:
\`\`\`bash
cat /workspace/inbox/<filename>
\`\`\`

After processing, delete it:
\`\`\`bash
rm /workspace/inbox/<filename>
\`\`\`

Start processing messages now. If no messages, wait and check periodically.
`;
  }

  /**
   * Watch conductor output for commands.
   */
  private startConductorOutputWatcher(): void {
    // In a real implementation, we'd attach to the sandbox's stdout
    // For now, we poll a output file
    setInterval(async () => {
      await this.checkConductorOutput();
    }, 1000);
  }

  /**
   * Check conductor output for commands.
   */
  private async checkConductorOutput(): Promise<void> {
    if (!this.conductorSandbox) return;

    try {
      // Read any pending output
      const output = await this.conductorSandbox.files.read(
        "/workspace/.conductor_output"
      );

      if (output && output.trim()) {
        // Clear the output file
        await this.conductorSandbox.files.write("/workspace/.conductor_output", "");

        // Emit raw output
        this.events.onConductorOutput?.(output);

        // Parse for commands
        const commands = this.parser.parseAll(output);
        for (const cmd of commands) {
          await this.executeCommand(cmd);
        }

        if (this.conductorState) {
          this.conductorState.lastActivityAt = new Date();
        }
      }
    } catch {
      // File may not exist yet, that's ok
    }
  }

  /**
   * Start keep-alive ping.
   */
  private startKeepAlive(): void {
    const interval = this.config.keepAliveIntervalMs || 60000; // 1 minute default

    this.keepAliveInterval = setInterval(async () => {
      if (this.conductorSandbox) {
        try {
          await this.conductorSandbox.commands.run("echo 'keepalive'", {
            timeout: 5000,
          });
        } catch (error) {
          console.error("Conductor keep-alive failed:", error);
          this.events.onError?.(error as Error);
        }
      }
    }, interval);
  }

  /**
   * Stop the conductor VM.
   */
  async stopConductor(): Promise<void> {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }

    // Kill all workers
    for (const [workerId] of this.workers) {
      await this.killWorker(workerId);
    }

    if (this.conductorSandbox) {
      await this.conductorSandbox.kill();
      this.conductorSandbox = null;
    }

    this.conductorState = null;
    console.log("Conductor stopped");
  }

  // ============================================================================
  // Message Injection
  // ============================================================================

  /**
   * Inject a message into the conductor's inbox.
   */
  async injectMessage(message: IncomingMessage): Promise<void> {
    if (!this.conductorSandbox) {
      // Queue message if conductor not ready
      this.messageQueue.push(message);
      return;
    }

    const formatted = this.formatter.format(message);
    const filename = `msg_${Date.now()}_${uuidv4().slice(0, 8)}.txt`;

    await this.conductorSandbox.files.write(
      `/workspace/inbox/${filename}`,
      formatted
    );

    if (this.conductorState) {
      this.conductorState.lastActivityAt = new Date();
    }
  }

  /**
   * Process any queued messages.
   */
  private async processMessageQueue(): Promise<void> {
    if (this.isProcessingQueue || this.messageQueue.length === 0) return;

    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message) {
        await this.injectMessage(message);
      }
    }

    this.isProcessingQueue = false;
  }

  // ============================================================================
  // Command Execution
  // ============================================================================

  /**
   * Execute a command from conductor output.
   */
  private async executeCommand(command: ParsedCommand): Promise<void> {
    console.log(`Executing command: ${command.type}`);

    switch (command.type) {
      case "spawn-worker":
        await this.spawnWorker(command.task);
        break;

      case "message-worker":
        await this.messageWorker(command.workerId, command.message);
        break;

      case "kill-worker":
        await this.killWorker(command.workerId);
        break;

      case "send-email":
        await this.sendEmail(command.to, command.subject, command.body);
        break;

      case "send-sms":
        await this.sendSMS(command.to, command.message);
        break;

      case "list-workers":
        await this.listWorkers();
        break;

      case "worker-status":
        await this.workerStatus(command.workerId);
        break;
    }
  }

  // ============================================================================
  // Worker Management
  // ============================================================================

  /**
   * Spawn a new worker VM.
   */
  async spawnWorker(task: string): Promise<string> {
    const workerId = uuidv4().slice(0, 8);

    console.log(`Spawning worker ${workerId} for task: ${task.slice(0, 50)}...`);

    const sandbox = await Sandbox.create({
      template: this.config.workerTemplateId,
      apiKey: this.config.e2bApiKey,
      timeout: 60 * 60 * 1000, // 1 hour max
    });

    const state: WorkerState = {
      id: workerId,
      sandboxId: sandbox.sandboxId,
      task,
      status: "starting",
      startedAt: new Date(),
    };

    this.workers.set(workerId, state);
    this.workerSandboxes.set(workerId, sandbox);

    // Initialize worker
    await this.initializeWorker(workerId, sandbox, task);

    // Start watching worker output
    this.startWorkerOutputWatcher(workerId, sandbox);

    state.status = "running";

    // Update conductor state
    if (this.conductorState) {
      this.conductorState.activeWorkers.push(workerId);
    }

    // Notify conductor
    await this.injectMessage(
      MessageFormatter.createSystemMessage(
        "WORKER_SPAWNED",
        `Worker ${workerId} started`,
        { workerId, task }
      )
    );

    this.events.onWorkerSpawned?.(workerId, task);

    return workerId;
  }

  /**
   * Initialize a worker with its task.
   */
  private async initializeWorker(
    workerId: string,
    sandbox: Sandbox,
    task: string
  ): Promise<void> {
    const workerPrompt = `# Worker Agent Instructions

You are a worker agent with ID: ${workerId}

## Your Task
${task}

## Communication

Your output is monitored. The conductor will see everything you write.

When you complete the task, clearly state:
- What you did
- Any artifacts created (PRs, files, etc.)
- Whether it was successful

If you have questions or get blocked, say so clearly.

## Getting Started

Start working on the task now. Be thorough but efficient.
`;

    await sandbox.files.write("/workspace/TASK.md", workerPrompt);

    // Start the worker agent
    await sandbox.commands.run(
      `cd /workspace && echo 'Read /workspace/TASK.md and complete the task.' | npx claude --dangerously-skip-permissions &`,
      { background: true }
    );
  }

  /**
   * Watch a worker's output.
   */
  private startWorkerOutputWatcher(workerId: string, sandbox: Sandbox): void {
    const interval = setInterval(async () => {
      if (!this.workers.has(workerId)) {
        clearInterval(interval);
        return;
      }

      try {
        const output = await sandbox.files.read("/workspace/.worker_output");

        if (output && output.trim()) {
          // Clear the output file
          await sandbox.files.write("/workspace/.worker_output", "");

          // Emit output
          this.events.onWorkerOutput?.(workerId, output);

          // Update last output time
          const state = this.workers.get(workerId);
          if (state) {
            state.lastOutputAt = new Date();
          }

          // Parse output for completion/status
          const workerMessage = this.parseWorkerOutput(workerId, output);
          if (workerMessage) {
            await this.injectMessage(workerMessage);
          }
        }
      } catch {
        // File may not exist, that's ok
      }
    }, 2000);
  }

  /**
   * Parse worker output into a message for conductor.
   */
  private parseWorkerOutput(
    workerId: string,
    output: string
  ): IncomingMessage | null {
    // Look for completion indicators
    const lowerOutput = output.toLowerCase();

    let status: "PROGRESS" | "COMPLETE" | "BLOCKED" | "ERROR" = "PROGRESS";

    if (
      lowerOutput.includes("task complete") ||
      lowerOutput.includes("completed successfully") ||
      lowerOutput.includes("done")
    ) {
      status = "COMPLETE";
    } else if (
      lowerOutput.includes("blocked") ||
      lowerOutput.includes("need help") ||
      lowerOutput.includes("stuck")
    ) {
      status = "BLOCKED";
    } else if (
      lowerOutput.includes("error") ||
      lowerOutput.includes("failed")
    ) {
      status = "ERROR";
    }

    return MessageFormatter.createWorkerMessage(workerId, status, output);
  }

  /**
   * Send a message to a worker.
   */
  async messageWorker(workerId: string, message: string): Promise<void> {
    const sandbox = this.workerSandboxes.get(workerId);
    if (!sandbox) {
      console.error(`Worker ${workerId} not found`);
      return;
    }

    const filename = `msg_${Date.now()}.txt`;
    await sandbox.files.write(`/workspace/inbox/${filename}`, message);
  }

  /**
   * Kill a worker.
   */
  async killWorker(workerId: string): Promise<void> {
    const sandbox = this.workerSandboxes.get(workerId);
    if (sandbox) {
      await sandbox.kill();
    }

    this.workers.delete(workerId);
    this.workerSandboxes.delete(workerId);

    // Update conductor state
    if (this.conductorState) {
      this.conductorState.activeWorkers = this.conductorState.activeWorkers.filter(
        (id) => id !== workerId
      );
    }

    // Notify conductor
    await this.injectMessage(
      MessageFormatter.createSystemMessage(
        "WORKER_KILLED",
        `Worker ${workerId} terminated`,
        { workerId }
      )
    );

    this.events.onWorkerKilled?.(workerId);

    console.log(`Worker ${workerId} killed`);
  }

  /**
   * List all workers.
   */
  private async listWorkers(): Promise<void> {
    const workerList = Array.from(this.workers.values())
      .map((w) => `- ${w.id}: ${w.status} (started ${w.startedAt.toISOString()})`)
      .join("\n");

    await this.injectMessage(
      MessageFormatter.createSystemMessage(
        "WORKER_SPAWNED", // reusing, should add LIST type
        `Active workers:\n${workerList || "None"}`,
        { count: this.workers.size }
      )
    );
  }

  /**
   * Get worker status.
   */
  private async workerStatus(workerId: string): Promise<void> {
    const state = this.workers.get(workerId);

    if (!state) {
      await this.injectMessage(
        MessageFormatter.createSystemMessage(
          "ERROR",
          `Worker ${workerId} not found`
        )
      );
      return;
    }

    await this.injectMessage(
      MessageFormatter.createSystemMessage(
        "WORKER_SPAWNED", // reusing
        `Worker ${workerId} status: ${state.status}`,
        { ...state }
      )
    );
  }

  // ============================================================================
  // External Communication
  // ============================================================================

  /**
   * Send an email.
   */
  private async sendEmail(
    to: string,
    subject: string,
    body: string
  ): Promise<void> {
    if (this.events.onEmailSend) {
      await this.events.onEmailSend(to, subject, body);
    } else {
      console.log(`[EMAIL] To: ${to}, Subject: ${subject}`);
      console.log(`Body: ${body}`);
    }

    // Confirm to conductor
    await this.injectMessage(
      MessageFormatter.createSystemMessage("EMAIL_SENT", `Email sent to ${to}`, {
        to,
        subject,
      })
    );
  }

  /**
   * Send an SMS.
   */
  private async sendSMS(to: string, message: string): Promise<void> {
    if (this.events.onSMSSend) {
      await this.events.onSMSSend(to, message);
    } else {
      console.log(`[SMS] To: ${to}, Message: ${message}`);
    }

    // Confirm to conductor
    await this.injectMessage(
      MessageFormatter.createSystemMessage("SMS_SENT", `SMS sent to ${to}`, {
        to,
      })
    );
  }

  // ============================================================================
  // Status & Info
  // ============================================================================

  /**
   * Get conductor state.
   */
  getConductorState(): ConductorState | null {
    return this.conductorState;
  }

  /**
   * Get all worker states.
   */
  getWorkerStates(): WorkerState[] {
    return Array.from(this.workers.values());
  }

  /**
   * Check if conductor is ready.
   */
  isReady(): boolean {
    return this.conductorState?.status === "ready";
  }
}
