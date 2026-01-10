/**
 * Conductor Routes
 *
 * API endpoints for the Conductor/Worker orchestration system.
 * These routes allow triggering orchestration, checking status, and managing workers.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { createConductor, IncomingEvent, OrchestrationState } from "../conductor";
import { OrchestrationStore } from "../conductor/orchestration-store";
import { v4 as uuidv4 } from "uuid";

// Validation schemas
const triggerEventSchema = z.object({
  type: z.enum(["email", "slack", "webhook", "scheduled", "api"]),
  payload: z.record(z.unknown()),
  metadata: z.record(z.unknown()).optional(),
});

const emailEventSchema = z.object({
  from: z.string().email(),
  to: z.string().email(),
  subject: z.string(),
  body: z.string(),
  bodyHtml: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        url: z.string().optional(),
        content: z.string().optional(),
        mimeType: z.string(),
        size: z.number().optional(),
      })
    )
    .optional(),
  threadId: z.string().optional(),
  inReplyTo: z.string().optional(),
});

// Create conductor instance (singleton for the application)
let conductorInstance: ReturnType<typeof createConductor> | null = null;
const store = new OrchestrationStore();

function getConductor() {
  if (!conductorInstance) {
    conductorInstance = createConductor({
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      conductorUrl: process.env.BACKEND_API_URL,
      internalApiKey: process.env.INTERNAL_API_KEY,
      defaultFromEmail: process.env.DEFAULT_FROM_EMAIL || "agent@example.com",
    });
  }
  return conductorInstance;
}

export async function conductorRoutes(fastify: FastifyInstance) {
  // ============================================================================
  // Trigger Orchestration
  // ============================================================================

  /**
   * POST /api/conductor/trigger
   *
   * Trigger a new orchestration for an incoming event.
   * The conductor will triage the event, spawn workers if needed,
   * and handle the entire workflow autonomously.
   */
  fastify.post(
    "/trigger",
    async (
      request: FastifyRequest<{ Body: z.infer<typeof triggerEventSchema> }>,
      reply: FastifyReply
    ) => {
      const body = triggerEventSchema.parse(request.body);

      const event: IncomingEvent = {
        id: uuidv4(),
        type: body.type,
        timestamp: new Date(),
        payload: body.payload as any,
        metadata: body.metadata,
      };

      const conductor = getConductor();

      // Start orchestration asynchronously
      // Return immediately with orchestration ID
      const orchestrationPromise = conductor.handleEvent(event);

      // Get initial state
      const state = await store.getByEventId(event.id);

      // Don't await the full orchestration - it runs in background
      orchestrationPromise.catch((error) => {
        console.error(`Orchestration for event ${event.id} failed:`, error);
      });

      reply.code(202).send({
        success: true,
        message: "Orchestration started",
        eventId: event.id,
        orchestrationId: state?.id,
      });
    }
  );

  /**
   * POST /api/conductor/trigger/email
   *
   * Convenience endpoint specifically for email events.
   */
  fastify.post(
    "/trigger/email",
    async (
      request: FastifyRequest<{ Body: z.infer<typeof emailEventSchema> }>,
      reply: FastifyReply
    ) => {
      const emailPayload = emailEventSchema.parse(request.body);

      const event: IncomingEvent = {
        id: uuidv4(),
        type: "email",
        timestamp: new Date(),
        payload: emailPayload as any,
      };

      const conductor = getConductor();
      const orchestrationPromise = conductor.handleEvent(event);

      const state = await store.getByEventId(event.id);

      orchestrationPromise.catch((error) => {
        console.error(`Email orchestration for ${event.id} failed:`, error);
      });

      reply.code(202).send({
        success: true,
        message: "Email orchestration started",
        eventId: event.id,
        orchestrationId: state?.id,
      });
    }
  );

  // ============================================================================
  // Orchestration Status
  // ============================================================================

  /**
   * GET /api/conductor/orchestrations/:id
   *
   * Get the status of an orchestration.
   */
  fastify.get(
    "/orchestrations/:id",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      const { id } = request.params;

      const state = await store.get(id);
      if (!state) {
        reply.code(404).send({ error: "Orchestration not found" });
        return;
      }

      reply.send({
        success: true,
        orchestration: state,
      });
    }
  );

  /**
   * GET /api/conductor/orchestrations
   *
   * List orchestrations, optionally filtered by status.
   */
  fastify.get(
    "/orchestrations",
    async (
      request: FastifyRequest<{ Querystring: { status?: string; active?: string } }>,
      reply: FastifyReply
    ) => {
      const { status, active } = request.query;

      let orchestrations: OrchestrationState[];

      if (active === "true") {
        orchestrations = await store.listActive();
      } else if (status) {
        orchestrations = await store.listByStatus(status as any);
      } else {
        // List all (could add pagination later)
        orchestrations = await store.listActive();
      }

      reply.send({
        success: true,
        orchestrations,
        count: orchestrations.length,
      });
    }
  );

  /**
   * GET /api/conductor/events/:eventId/orchestration
   *
   * Get orchestration by event ID.
   */
  fastify.get(
    "/events/:eventId/orchestration",
    async (
      request: FastifyRequest<{ Params: { eventId: string } }>,
      reply: FastifyReply
    ) => {
      const { eventId } = request.params;

      const state = await store.getByEventId(eventId);
      if (!state) {
        reply.code(404).send({ error: "Orchestration not found for this event" });
        return;
      }

      reply.send({
        success: true,
        orchestration: state,
      });
    }
  );

  // ============================================================================
  // Worker Management
  // ============================================================================

  /**
   * GET /api/conductor/workers
   *
   * List active workers.
   */
  fastify.get("/workers", async (request: FastifyRequest, reply: FastifyReply) => {
    // Note: This requires access to the WorkerManagerService
    // For now, return from database
    reply.send({
      success: true,
      message: "Worker listing requires WorkerManagerService access",
      // workers: workerManager.listActiveWorkers(),
    });
  });

  // ============================================================================
  // Health Check
  // ============================================================================

  /**
   * GET /api/conductor/health
   *
   * Check conductor health status.
   */
  fastify.get("/health", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.send({
      success: true,
      status: "healthy",
      timestamp: new Date().toISOString(),
    });
  });
}
