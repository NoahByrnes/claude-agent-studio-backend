/**
 * Orchestration Store
 *
 * Persistence layer for orchestration state.
 * Stores the state of ongoing and completed orchestrations.
 */

import { db } from "../lib/db";
import { orchestrations, tasks, workers } from "../../db/schema";
import { eq } from "drizzle-orm";
import type {
  OrchestrationState,
  OrchestrationStatus,
  TriageDecision,
  ValidationResult,
  WorkerResult,
  Task as TaskType,
  TaskAttempt,
} from "./types";

export class OrchestrationStore {
  /**
   * Create a new orchestration record.
   */
  async create(state: OrchestrationState): Promise<void> {
    await db.insert(orchestrations).values({
      id: state.id,
      event_id: state.eventId,
      status: state.status,
      current_task_id: state.currentTaskId,
      current_worker_id: state.currentWorkerId,
      triage_decision: state.triageDecision as any,
      validation_result: state.validationResult as any,
      final_result: state.finalResult as any,
      attempts: state.attempts as any,
      created_at: state.createdAt,
      updated_at: state.updatedAt,
      completed_at: state.completedAt,
    });
  }

  /**
   * Update an existing orchestration record.
   */
  async update(
    id: string,
    updates: Partial<OrchestrationState>
  ): Promise<void> {
    const dbUpdates: Record<string, any> = {};

    if (updates.status !== undefined) {
      dbUpdates.status = updates.status;
    }
    if (updates.currentTaskId !== undefined) {
      dbUpdates.current_task_id = updates.currentTaskId;
    }
    if (updates.currentWorkerId !== undefined) {
      dbUpdates.current_worker_id = updates.currentWorkerId;
    }
    if (updates.triageDecision !== undefined) {
      dbUpdates.triage_decision = updates.triageDecision;
    }
    if (updates.validationResult !== undefined) {
      dbUpdates.validation_result = updates.validationResult;
    }
    if (updates.finalResult !== undefined) {
      dbUpdates.final_result = updates.finalResult;
    }
    if (updates.attempts !== undefined) {
      dbUpdates.attempts = updates.attempts;
    }
    if (updates.updatedAt !== undefined) {
      dbUpdates.updated_at = updates.updatedAt;
    }
    if (updates.completedAt !== undefined) {
      dbUpdates.completed_at = updates.completedAt;
    }

    await db
      .update(orchestrations)
      .set(dbUpdates)
      .where(eq(orchestrations.id, id));
  }

  /**
   * Get an orchestration by ID.
   */
  async get(id: string): Promise<OrchestrationState | null> {
    const rows = await db
      .select()
      .from(orchestrations)
      .where(eq(orchestrations.id, id))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return this.toOrchestrationState(rows[0]);
  }

  /**
   * Get an orchestration by event ID.
   */
  async getByEventId(eventId: string): Promise<OrchestrationState | null> {
    const rows = await db
      .select()
      .from(orchestrations)
      .where(eq(orchestrations.event_id, eventId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return this.toOrchestrationState(rows[0]);
  }

  /**
   * List orchestrations by status.
   */
  async listByStatus(status: OrchestrationStatus): Promise<OrchestrationState[]> {
    const rows = await db
      .select()
      .from(orchestrations)
      .where(eq(orchestrations.status, status));

    return rows.map(this.toOrchestrationState);
  }

  /**
   * List active (non-terminal) orchestrations.
   */
  async listActive(): Promise<OrchestrationState[]> {
    const rows = await db.select().from(orchestrations);

    // Filter to non-terminal statuses
    const activeStatuses: OrchestrationStatus[] = [
      "pending",
      "triaging",
      "spawning",
      "running",
      "validating",
      "retrying",
      "finalizing",
    ];

    return rows
      .filter((r) => activeStatuses.includes(r.status as OrchestrationStatus))
      .map(this.toOrchestrationState);
  }

  /**
   * Convert database row to OrchestrationState.
   */
  private toOrchestrationState(row: any): OrchestrationState {
    return {
      id: row.id,
      eventId: row.event_id,
      status: row.status as OrchestrationStatus,
      currentTaskId: row.current_task_id,
      currentWorkerId: row.current_worker_id,
      triageDecision: row.triage_decision as TriageDecision | undefined,
      validationResult: row.validation_result as ValidationResult | undefined,
      finalResult: row.final_result as WorkerResult | undefined,
      attempts: (row.attempts as TaskAttempt[]) || [],
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    };
  }

  // ============================================================================
  // Task Management
  // ============================================================================

  /**
   * Save a task.
   */
  async saveTask(task: TaskType): Promise<void> {
    // First, get the orchestration for this event
    const orch = await this.getByEventId(task.eventId);
    if (!orch) {
      throw new Error(`No orchestration found for event ${task.eventId}`);
    }

    await db.insert(tasks).values({
      id: task.id,
      orchestration_id: orch.id,
      event_id: task.eventId,
      description: task.description,
      instructions: task.instructions,
      context: task.context as any,
      constraints: task.constraints as any,
      created_at: task.createdAt,
    });
  }

  /**
   * Get a task by ID.
   */
  async getTask(id: string): Promise<TaskType | null> {
    const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);

    if (rows.length === 0) {
      return null;
    }

    return this.toTask(rows[0]);
  }

  private toTask(row: any): TaskType {
    return {
      id: row.id,
      eventId: row.event_id,
      description: row.description,
      instructions: row.instructions,
      context: row.context,
      constraints: row.constraints,
      createdAt: new Date(row.created_at),
    };
  }

  // ============================================================================
  // Worker Management
  // ============================================================================

  /**
   * Save a worker record.
   */
  async saveWorker(worker: {
    id: string;
    taskId: string;
    sandboxId: string;
    status: string;
    result?: any;
    error?: string;
    startedAt: Date;
    endedAt?: Date;
  }): Promise<void> {
    await db.insert(workers).values({
      id: worker.id,
      task_id: worker.taskId,
      sandbox_id: worker.sandboxId,
      status: worker.status,
      result: worker.result,
      error: worker.error,
      started_at: worker.startedAt,
      ended_at: worker.endedAt,
    });
  }

  /**
   * Update a worker record.
   */
  async updateWorker(
    id: string,
    updates: {
      status?: string;
      result?: any;
      error?: string;
      endedAt?: Date;
    }
  ): Promise<void> {
    const dbUpdates: Record<string, any> = {};

    if (updates.status !== undefined) {
      dbUpdates.status = updates.status;
    }
    if (updates.result !== undefined) {
      dbUpdates.result = updates.result;
    }
    if (updates.error !== undefined) {
      dbUpdates.error = updates.error;
    }
    if (updates.endedAt !== undefined) {
      dbUpdates.ended_at = updates.endedAt;
    }

    await db.update(workers).set(dbUpdates).where(eq(workers.id, id));
  }

  /**
   * Get workers for a task.
   */
  async getWorkersForTask(taskId: string): Promise<any[]> {
    return db.select().from(workers).where(eq(workers.task_id, taskId));
  }
}
