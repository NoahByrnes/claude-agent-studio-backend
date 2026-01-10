/**
 * Conductor Service
 *
 * The Conductor is the orchestrator that replaces human-in-the-loop with agent-in-the-loop.
 * It receives events, triages them, spawns workers, validates output, and finalizes actions.
 */

import Anthropic from "@anthropic-ai/sdk";
import { db } from "../lib/db";
import { v4 as uuidv4 } from "uuid";
import type {
  IncomingEvent,
  TriageDecision,
  Task,
  TaskContext,
  WorkerMessage,
  WorkerResult,
  ValidationResult,
  OrchestrationState,
  OrchestrationStatus,
  RetryStrategy,
} from "./types";

// These will be injected - defined as interfaces for now
interface WorkerManager {
  spawn(task: Task): Promise<{ workerId: string; sandboxId: string }>;
  sendCommand(workerId: string, command: any): Promise<void>;
  getStatus(workerId: string): Promise<any>;
  kill(workerId: string): Promise<void>;
}

interface ValidationService {
  validate(task: Task, result: WorkerResult): Promise<ValidationResult>;
}

interface NotificationService {
  sendEmail(params: any): Promise<void>;
  postSlack(params: any): Promise<void>;
  respond(event: IncomingEvent, result: WorkerResult): Promise<void>;
}

interface OrchestrationStore {
  create(state: OrchestrationState): Promise<void>;
  update(id: string, updates: Partial<OrchestrationState>): Promise<void>;
  get(id: string): Promise<OrchestrationState | null>;
  getByEventId(eventId: string): Promise<OrchestrationState | null>;
}

export class ConductorService {
  private anthropic: Anthropic;

  constructor(
    private workerManager: WorkerManager,
    private validator: ValidationService,
    private notifier: NotificationService,
    private store: OrchestrationStore,
    anthropicApiKey?: string
  ) {
    this.anthropic = new Anthropic({
      apiKey: anthropicApiKey || process.env.ANTHROPIC_API_KEY,
    });
  }

  // ============================================================================
  // Main Entry Point
  // ============================================================================

  /**
   * Handle an incoming event end-to-end.
   * This is the main orchestration loop.
   */
  async handleEvent(event: IncomingEvent): Promise<OrchestrationState> {
    const orchestrationId = uuidv4();

    // Initialize orchestration state
    const state: OrchestrationState = {
      id: orchestrationId,
      eventId: event.id,
      status: "pending",
      attempts: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.create(state);

    try {
      // Step 1: Triage
      await this.updateStatus(orchestrationId, "triaging");
      const decision = await this.triage(event);
      state.triageDecision = decision;

      if (decision.action === "ignore") {
        await this.logIgnored(event, decision);
        return this.complete(orchestrationId, "completed");
      }

      if (decision.action === "escalate") {
        await this.escalate(event, decision);
        return this.complete(orchestrationId, "escalated");
      }

      if (decision.action === "defer") {
        // TODO: Schedule for later
        return this.complete(orchestrationId, "pending");
      }

      // Step 2: Create task and spawn worker
      const task = await this.createTask(event, decision);
      state.currentTaskId = task.id;
      await this.store.update(orchestrationId, { currentTaskId: task.id });

      // Step 3: Execute with retry loop
      const result = await this.executeWithRetry(orchestrationId, task, event);

      if (!result) {
        return this.complete(orchestrationId, "failed");
      }

      // Step 4: Finalize
      await this.updateStatus(orchestrationId, "finalizing");
      await this.finalize(event, result);

      return this.complete(orchestrationId, "completed", result);
    } catch (error) {
      console.error(`Orchestration ${orchestrationId} failed:`, error);
      await this.store.update(orchestrationId, {
        status: "failed",
        updatedAt: new Date(),
      });
      throw error;
    }
  }

  // ============================================================================
  // Triage - Decide if event needs action
  // ============================================================================

  private async triage(event: IncomingEvent): Promise<TriageDecision> {
    const prompt = this.buildTriagePrompt(event);

    const response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    return this.parseTriageResponse(text);
  }

  private buildTriagePrompt(event: IncomingEvent): string {
    return `You are an intelligent event triage system. Analyze this incoming event and decide what action to take.

## Event Details
Type: ${event.type}
Timestamp: ${event.timestamp}
Payload:
${JSON.stringify(event.payload, null, 2)}

## Your Task
Decide whether this event:
1. IGNORE - No action needed (spam, marketing, FYI only, no clear ask)
2. ACTION - Requires work to be done (clear request, task, question needing resolution)
3. DEFER - Not urgent, can be handled later (low priority, not time-sensitive)
4. ESCALATE - Needs human attention (sensitive, unclear, high-risk)

## Response Format (JSON)
{
  "action": "ignore" | "action" | "defer" | "escalate",
  "reason": "Brief explanation of why",
  "confidence": 0.0-1.0,
  "taskType": "What kind of task is this? (only if action)",
  "priority": "low" | "medium" | "high" | "urgent" (only if action),
  "suggestedApproach": "Brief description of how to handle (only if action)"
}

Respond with only the JSON, no other text.`;
  }

  private parseTriageResponse(text: string): TriageDecision {
    try {
      // Extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }
      const parsed = JSON.parse(jsonMatch[0]);

      return {
        action: parsed.action || "ignore",
        reason: parsed.reason || "Unable to parse",
        confidence: parsed.confidence || 0.5,
        taskType: parsed.taskType,
        priority: parsed.priority,
        suggestedApproach: parsed.suggestedApproach,
      };
    } catch (error) {
      console.error("Failed to parse triage response:", error);
      return {
        action: "escalate",
        reason: "Failed to parse triage decision",
        confidence: 0,
      };
    }
  }

  // ============================================================================
  // Task Creation
  // ============================================================================

  private async createTask(
    event: IncomingEvent,
    decision: TriageDecision
  ): Promise<Task> {
    const context: TaskContext = {
      originalEvent: event,
      previousAttempts: [],
    };

    // TODO: Enrich context with project info from database

    const instructions = await this.generateTaskInstructions(event, decision);

    return {
      id: uuidv4(),
      eventId: event.id,
      description: decision.taskType || "Handle event",
      instructions,
      context,
      constraints: {
        timeout: this.getTimeout(decision.priority),
        maxRetries: 3,
        allowedTools: this.getAllowedTools(decision.taskType),
      },
      createdAt: new Date(),
    };
  }

  private async generateTaskInstructions(
    event: IncomingEvent,
    decision: TriageDecision
  ): Promise<string> {
    const prompt = `Generate clear, actionable instructions for completing this task.

## Event
${JSON.stringify(event.payload, null, 2)}

## Triage Decision
Task Type: ${decision.taskType}
Priority: ${decision.priority}
Suggested Approach: ${decision.suggestedApproach}

## Your Task
Write clear instructions that a worker agent can follow to complete this task.
Be specific about:
1. What the end goal is
2. What steps to take
3. What the output should look like
4. How to verify success

Keep it concise but complete. The worker should know exactly what to do.`;

    const response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    return response.content[0].type === "text"
      ? response.content[0].text
      : "Complete the requested task based on the event details.";
  }

  private getTimeout(priority?: string): number {
    switch (priority) {
      case "urgent":
        return 600; // 10 minutes
      case "high":
        return 1800; // 30 minutes
      case "medium":
        return 3600; // 1 hour
      default:
        return 7200; // 2 hours
    }
  }

  private getAllowedTools(taskType?: string): string[] {
    // Base tools all workers get
    const baseTools = [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Grep",
      "Glob",
      "WebFetch",
    ];

    // Add specialized tools based on task type
    switch (taskType) {
      case "code_change":
      case "bug_fix":
      case "feature":
        return [...baseTools, "Git", "Test"];
      case "research":
      case "analysis":
        return [...baseTools, "WebSearch"];
      case "email_response":
        return [...baseTools, "EmailDraft"];
      default:
        return baseTools;
    }
  }

  // ============================================================================
  // Execution with Retry
  // ============================================================================

  private async executeWithRetry(
    orchestrationId: string,
    task: Task,
    event: IncomingEvent
  ): Promise<WorkerResult | null> {
    let attempts = 0;
    const maxAttempts = task.constraints.maxRetries + 1;

    while (attempts < maxAttempts) {
      attempts++;

      await this.updateStatus(orchestrationId, "spawning");

      // Spawn worker
      const { workerId, sandboxId } = await this.workerManager.spawn(task);
      await this.store.update(orchestrationId, { currentWorkerId: workerId });

      await this.updateStatus(orchestrationId, "running");

      // Wait for worker to complete
      const result = await this.waitForWorker(workerId, task);

      if (!result) {
        console.log(`Worker ${workerId} failed without result`);
        continue;
      }

      // Validate result
      await this.updateStatus(orchestrationId, "validating");
      const validation = await this.validator.validate(task, result);

      if (validation.status === "valid") {
        return result;
      }

      if (validation.status === "needs_human") {
        await this.escalate(event, {
          action: "escalate",
          reason: "Validation requires human review",
          confidence: 0,
        });
        return null;
      }

      // Handle retry based on strategy
      if (validation.retryStrategy) {
        await this.updateStatus(orchestrationId, "retrying");
        task = await this.adjustTaskForRetry(task, validation);
      }

      // Kill current worker before retry
      await this.workerManager.kill(workerId);
    }

    console.log(`All ${maxAttempts} attempts failed for task ${task.id}`);
    return null;
  }

  private async waitForWorker(
    workerId: string,
    task: Task
  ): Promise<WorkerResult | null> {
    const startTime = Date.now();
    const timeout = task.constraints.timeout * 1000;

    while (Date.now() - startTime < timeout) {
      const status = await this.workerManager.getStatus(workerId);

      if (status.status === "done") {
        return status.result;
      }

      if (status.status === "error") {
        console.error(`Worker ${workerId} error:`, status.error);
        return null;
      }

      if (status.status === "waiting_for_answer") {
        // Conductor answers the question
        const answer = await this.answerWorkerQuestion(status.pendingQuestion);
        await this.workerManager.sendCommand(workerId, {
          type: "answer",
          question: status.pendingQuestion.question,
          answer,
        });
      }

      if (status.status === "waiting_for_approval") {
        // Conductor decides on approval
        const approved = await this.decideApproval(status.pendingApproval);
        await this.workerManager.sendCommand(workerId, {
          type: approved ? "approve" : "deny",
          action: status.pendingApproval.action,
          reason: approved ? undefined : "Conductor denied the action",
        });
      }

      // Poll every 5 seconds
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    console.log(`Worker ${workerId} timed out after ${task.constraints.timeout}s`);
    return null;
  }

  private async answerWorkerQuestion(question: any): Promise<string> {
    const prompt = `A worker agent is asking a question while completing a task. Provide a helpful answer.

Question: ${question.question}
Context: ${question.context || "No additional context"}
Options: ${question.options?.join(", ") || "Open-ended"}

Provide a clear, concise answer that helps the worker continue.`;

    const response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    return response.content[0].type === "text"
      ? response.content[0].text
      : "Continue with your best judgment.";
  }

  private async decideApproval(approval: any): Promise<boolean> {
    // For now, auto-approve low-risk, reversible actions
    if (approval.risk === "low" && approval.reversible) {
      return true;
    }

    // For higher risk, use Claude to decide
    const prompt = `A worker agent is requesting approval for an action. Should it be approved?

Action: ${approval.action}
Description: ${approval.description}
Risk Level: ${approval.risk}
Reversible: ${approval.reversible}

Respond with just "APPROVE" or "DENY" followed by a brief reason.`;

    const response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    return text.toUpperCase().startsWith("APPROVE");
  }

  private async adjustTaskForRetry(
    task: Task,
    validation: ValidationResult
  ): Promise<Task> {
    const strategy = validation.retryStrategy;

    if (!strategy) {
      return task;
    }

    switch (strategy.type) {
      case "same_worker":
        return {
          ...task,
          instructions:
            task.instructions +
            `\n\n## Additional Instructions from Previous Attempt\n${strategy.additionalInstructions}`,
        };

      case "new_worker":
        return {
          ...task,
          id: uuidv4(),
          instructions:
            task.instructions + `\n\n## New Approach\n${strategy.newApproach}`,
        };

      case "split_task":
        // TODO: Handle task splitting properly
        return {
          ...task,
          id: uuidv4(),
          instructions:
            task.instructions +
            `\n\n## Focus on These Subtasks\n${strategy.subtasks.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
        };

      default:
        return task;
    }
  }

  // ============================================================================
  // Finalization
  // ============================================================================

  private async finalize(
    event: IncomingEvent,
    result: WorkerResult
  ): Promise<void> {
    // Send appropriate response based on event type
    await this.notifier.respond(event, result);
  }

  private async logIgnored(
    event: IncomingEvent,
    decision: TriageDecision
  ): Promise<void> {
    console.log(`Event ${event.id} ignored: ${decision.reason}`);
    // TODO: Store in audit log
  }

  private async escalate(
    event: IncomingEvent,
    decision: TriageDecision
  ): Promise<void> {
    console.log(`Event ${event.id} escalated: ${decision.reason}`);
    // TODO: Notify human via preferred channel
  }

  // ============================================================================
  // State Management
  // ============================================================================

  private async updateStatus(
    orchestrationId: string,
    status: OrchestrationStatus
  ): Promise<void> {
    await this.store.update(orchestrationId, {
      status,
      updatedAt: new Date(),
    });
  }

  private async complete(
    orchestrationId: string,
    status: OrchestrationStatus,
    result?: WorkerResult
  ): Promise<OrchestrationState> {
    await this.store.update(orchestrationId, {
      status,
      finalResult: result,
      completedAt: new Date(),
      updatedAt: new Date(),
    });

    const state = await this.store.get(orchestrationId);
    if (!state) {
      throw new Error(`Orchestration ${orchestrationId} not found`);
    }
    return state;
  }

  // ============================================================================
  // Worker Message Handling (for async updates from workers)
  // ============================================================================

  async handleWorkerMessage(message: WorkerMessage): Promise<void> {
    const orchestration = await this.store.getByEventId(message.taskId);
    if (!orchestration) {
      console.error(`No orchestration found for task ${message.taskId}`);
      return;
    }

    switch (message.payload.type) {
      case "progress":
        console.log(
          `Worker ${message.workerId} progress: ${message.payload.message}`
        );
        break;

      case "question":
        // Will be handled in waitForWorker polling
        break;

      case "blocked":
        console.log(
          `Worker ${message.workerId} blocked: ${message.payload.reason}`
        );
        break;

      case "done":
        // Will be handled in waitForWorker polling
        break;

      case "error":
        console.error(`Worker ${message.workerId} error: ${message.payload.error}`);
        break;
    }
  }
}
