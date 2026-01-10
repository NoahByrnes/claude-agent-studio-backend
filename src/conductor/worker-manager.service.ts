/**
 * Worker Manager Service
 *
 * Manages the lifecycle of worker agents running in E2B sandboxes.
 * Handles spawning, communication, monitoring, and termination.
 */

import Sandbox from "@e2b/code-interpreter";
import { v4 as uuidv4 } from "uuid";
import type {
  Task,
  WorkerState,
  WorkerStatus,
  WorkerResult,
  ConductorCommand,
  WorkerMessage,
} from "./types";

interface ActiveWorker {
  id: string;
  sandboxId: string;
  sandbox: Sandbox;
  task: Task;
  state: WorkerState;
  httpEndpoint?: string;
}

export class WorkerManagerService {
  private activeWorkers: Map<string, ActiveWorker> = new Map();
  private conductorUrl: string;
  private internalApiKey: string;

  constructor(
    conductorUrl?: string,
    internalApiKey?: string
  ) {
    this.conductorUrl = conductorUrl || process.env.BACKEND_API_URL || "";
    this.internalApiKey = internalApiKey || process.env.INTERNAL_API_KEY || "";
  }

  /**
   * Spawn a new worker to execute a task.
   */
  async spawn(task: Task): Promise<{ workerId: string; sandboxId: string }> {
    const workerId = uuidv4();

    console.log(`Spawning worker ${workerId} for task ${task.id}`);

    // Create E2B sandbox
    const sandbox = await Sandbox.create({
      template: process.env.E2B_WORKER_TEMPLATE_ID || process.env.E2B_TEMPLATE_ID,
      apiKey: process.env.E2B_API_KEY,
      timeout: task.constraints.timeout * 1000,
    });

    const sandboxId = sandbox.sandboxId;
    console.log(`Created sandbox ${sandboxId} for worker ${workerId}`);

    // Initialize worker state
    const state: WorkerState = {
      id: workerId,
      taskId: task.id,
      status: "initializing",
      startedAt: new Date(),
      lastActivityAt: new Date(),
    };

    // Store active worker
    const worker: ActiveWorker = {
      id: workerId,
      sandboxId,
      sandbox,
      task,
      state,
    };
    this.activeWorkers.set(workerId, worker);

    // Set up the worker environment
    await this.initializeWorker(worker);

    // Start the worker execution
    await this.startWorkerExecution(worker);

    return { workerId, sandboxId };
  }

  /**
   * Initialize the worker environment with task context.
   */
  private async initializeWorker(worker: ActiveWorker): Promise<void> {
    const { sandbox, task } = worker;

    // Write task context to a file the worker can read
    const taskContext = JSON.stringify(
      {
        taskId: task.id,
        description: task.description,
        instructions: task.instructions,
        constraints: task.constraints,
        originalEvent: task.context.originalEvent,
        previousAttempts: task.context.previousAttempts,
        conductorUrl: this.conductorUrl,
        workerId: worker.id,
      },
      null,
      2
    );

    await sandbox.files.write("/workspace/task.json", taskContext);

    // Write environment variables
    const envContent = `
CONDUCTOR_URL=${this.conductorUrl}
WORKER_ID=${worker.id}
TASK_ID=${task.id}
INTERNAL_API_KEY=${this.internalApiKey}
`;
    await sandbox.files.write("/workspace/.env.conductor", envContent);

    // Create worker entry script
    const workerScript = `
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs";

// Load task context
const task = JSON.parse(fs.readFileSync("/workspace/task.json", "utf-8"));

// Build the prompt for the worker
const prompt = \`You are a worker agent executing a task. Complete it fully and report back.

## Task
\${task.description}

## Instructions
\${task.instructions}

## Original Request
\${JSON.stringify(task.originalEvent?.payload || {}, null, 2)}

## Constraints
- Timeout: \${task.constraints.timeout} seconds
- Allowed tools: \${task.constraints.allowedTools.join(", ")}
${task.constraints.forbiddenActions?.length ? `- Forbidden: ${task.constraints.forbiddenActions.join(", ")}` : ""}

## Your Job
1. Plan your approach
2. Execute using available tools
3. Verify your work
4. Report completion with a summary

When done, create a file at /workspace/result.json with:
{
  "success": true/false,
  "summary": "Brief summary of what was done",
  "artifacts": [{ "type": "...", "name": "...", "description": "..." }],
  "actions": [{ "action": "...", "target": "...", "result": "success/failed" }]
}
\`;

// Execute the agent
async function run() {
  for await (const message of query({
    prompt,
    options: {
      cwd: "/workspace",
      allowedTools: task.constraints.allowedTools,
      maxTurns: 100,
    },
  })) {
    // Log progress to conductor
    if (message.type === "tool_use") {
      console.log(JSON.stringify({
        type: "progress",
        workerId: task.workerId,
        taskId: task.taskId,
        tool: message.name,
        timestamp: new Date().toISOString()
      }));
    }
  }

  // Notify completion
  console.log(JSON.stringify({
    type: "done",
    workerId: task.workerId,
    taskId: task.taskId,
    timestamp: new Date().toISOString()
  }));
}

run().catch(err => {
  console.error(JSON.stringify({
    type: "error",
    workerId: task.workerId,
    taskId: task.taskId,
    error: err.message,
    timestamp: new Date().toISOString()
  }));
});
`;

    await sandbox.files.write("/workspace/worker-entry.ts", workerScript);

    worker.state.status = "planning";
    worker.state.lastActivityAt = new Date();
  }

  /**
   * Start the worker execution in the sandbox.
   */
  private async startWorkerExecution(worker: ActiveWorker): Promise<void> {
    const { sandbox } = worker;

    // Run the worker script in the background
    // The worker will communicate back via HTTP to the conductor
    try {
      // Install dependencies if needed
      await sandbox.commands.run("cd /workspace && npm install @anthropic-ai/claude-agent-sdk 2>/dev/null || true");

      // Start the worker in background
      await sandbox.commands.run(
        "cd /workspace && npx tsx worker-entry.ts &",
        { background: true }
      );

      worker.state.status = "executing";
      worker.state.lastActivityAt = new Date();
    } catch (error) {
      console.error(`Failed to start worker ${worker.id}:`, error);
      worker.state.status = "error";
    }
  }

  /**
   * Send a command to a worker.
   */
  async sendCommand(workerId: string, command: ConductorCommand): Promise<void> {
    const worker = this.activeWorkers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    // Write command to a file the worker can poll
    const commandPath = `/workspace/commands/${uuidv4()}.json`;
    await worker.sandbox.files.write(
      commandPath,
      JSON.stringify({
        ...command,
        timestamp: new Date().toISOString(),
      })
    );

    worker.state.lastActivityAt = new Date();
  }

  /**
   * Get the current status of a worker.
   */
  async getStatus(workerId: string): Promise<{
    status: WorkerStatus;
    result?: WorkerResult;
    error?: string;
    pendingQuestion?: any;
    pendingApproval?: any;
  }> {
    const worker = this.activeWorkers.get(workerId);
    if (!worker) {
      return { status: "error", error: "Worker not found" };
    }

    try {
      // Check if result file exists (worker completed)
      const resultContent = await this.tryReadFile(
        worker.sandbox,
        "/workspace/result.json"
      );

      if (resultContent) {
        const result = JSON.parse(resultContent);
        worker.state.status = "done";
        return {
          status: "done",
          result: {
            success: result.success,
            summary: result.summary,
            artifacts: result.artifacts || [],
            actions: result.actions || [],
            validationHints: result.validationHints,
            suggestedResponse: result.suggestedResponse,
          },
        };
      }

      // Check for pending question
      const questionContent = await this.tryReadFile(
        worker.sandbox,
        "/workspace/pending_question.json"
      );

      if (questionContent) {
        const question = JSON.parse(questionContent);
        worker.state.status = "waiting_for_answer";
        worker.state.pendingQuestion = question;
        return {
          status: "waiting_for_answer",
          pendingQuestion: question,
        };
      }

      // Check for pending approval
      const approvalContent = await this.tryReadFile(
        worker.sandbox,
        "/workspace/pending_approval.json"
      );

      if (approvalContent) {
        const approval = JSON.parse(approvalContent);
        worker.state.status = "waiting_for_approval";
        worker.state.pendingApproval = approval;
        return {
          status: "waiting_for_approval",
          pendingApproval: approval,
        };
      }

      // Check for error
      const errorContent = await this.tryReadFile(
        worker.sandbox,
        "/workspace/error.json"
      );

      if (errorContent) {
        const error = JSON.parse(errorContent);
        worker.state.status = "error";
        return {
          status: "error",
          error: error.message || "Unknown error",
        };
      }

      // Still running
      return { status: worker.state.status };
    } catch (error) {
      console.error(`Error getting status for worker ${workerId}:`, error);
      return { status: worker.state.status };
    }
  }

  /**
   * Kill a worker and clean up its sandbox.
   */
  async kill(workerId: string): Promise<void> {
    const worker = this.activeWorkers.get(workerId);
    if (!worker) {
      console.warn(`Worker ${workerId} not found, may already be killed`);
      return;
    }

    console.log(`Killing worker ${workerId} (sandbox ${worker.sandboxId})`);

    try {
      await worker.sandbox.kill();
    } catch (error) {
      console.error(`Error killing sandbox for worker ${workerId}:`, error);
    }

    this.activeWorkers.delete(workerId);
  }

  /**
   * List all active workers.
   */
  listActiveWorkers(): Array<{ workerId: string; taskId: string; status: WorkerStatus; startedAt: Date }> {
    return Array.from(this.activeWorkers.values()).map((w) => ({
      workerId: w.id,
      taskId: w.task.id,
      status: w.state.status,
      startedAt: w.state.startedAt,
    }));
  }

  /**
   * Clean up stale workers (e.g., on startup recovery).
   */
  async cleanupStaleWorkers(maxAgeMs: number = 3600000): Promise<void> {
    const now = Date.now();

    for (const [workerId, worker] of this.activeWorkers) {
      const age = now - worker.state.startedAt.getTime();
      if (age > maxAgeMs) {
        console.log(`Cleaning up stale worker ${workerId} (age: ${age}ms)`);
        await this.kill(workerId);
      }
    }
  }

  /**
   * Helper to safely read a file that may not exist.
   */
  private async tryReadFile(sandbox: Sandbox, path: string): Promise<string | null> {
    try {
      return await sandbox.files.read(path);
    } catch {
      return null;
    }
  }
}
