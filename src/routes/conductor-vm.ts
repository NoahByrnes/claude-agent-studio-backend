/**
 * Conductor VM Routes
 *
 * API endpoints for the VM-based conductor architecture.
 * The conductor is an agent in an E2B VM that receives messages via CLI.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { VMManager, MessageFormatter } from "../conductor-vm";

// Validation schemas
const emailWebhookSchema = z.object({
  from: z.string().email(),
  to: z.string().email(),
  subject: z.string(),
  body: z.string(),
  bodyHtml: z.string().optional(),
  attachments: z
    .array(z.object({ filename: z.string(), url: z.string() }))
    .optional(),
  threadId: z.string().optional(),
});

const smsWebhookSchema = z.object({
  from: z.string(),
  message: z.string(),
});

const userPromptSchema = z.object({
  userId: z.string(),
  username: z.string().optional(),
  message: z.string(),
});

// Singleton VM Manager
let vmManager: VMManager | null = null;

function getVMManager(): VMManager {
  if (!vmManager) {
    vmManager = new VMManager(
      {
        e2bApiKey: process.env.E2B_API_KEY!,
        conductorTemplateId:
          process.env.E2B_CONDUCTOR_TEMPLATE_ID || process.env.E2B_TEMPLATE_ID!,
        workerTemplateId:
          process.env.E2B_WORKER_TEMPLATE_ID || process.env.E2B_TEMPLATE_ID!,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
      },
      {
        onConductorReady: () => {
          console.log("Conductor VM is ready to receive messages");
        },
        onConductorOutput: (output) => {
          console.log("Conductor output:", output.slice(0, 200));
        },
        onWorkerSpawned: (workerId, task) => {
          console.log(`Worker ${workerId} spawned: ${task.slice(0, 50)}...`);
        },
        onWorkerKilled: (workerId) => {
          console.log(`Worker ${workerId} killed`);
        },
        onEmailSend: async (to, subject, body) => {
          // TODO: Integrate with email provider (Resend, SendGrid, etc.)
          console.log(`Would send email to ${to}: ${subject}`);
        },
        onSMSSend: async (to, message) => {
          // TODO: Integrate with SMS provider (Twilio, etc.)
          console.log(`Would send SMS to ${to}: ${message}`);
        },
        onError: (error) => {
          console.error("VM Manager error:", error);
        },
      }
    );
  }
  return vmManager;
}

export async function conductorVMRoutes(fastify: FastifyInstance) {
  // ============================================================================
  // Conductor Lifecycle
  // ============================================================================

  /**
   * POST /api/conductor-vm/start
   *
   * Start the conductor VM.
   */
  fastify.post("/start", async (request: FastifyRequest, reply: FastifyReply) => {
    const manager = getVMManager();

    if (manager.isReady()) {
      reply.code(400).send({
        success: false,
        error: "Conductor already running",
      });
      return;
    }

    try {
      await manager.startConductor();
      reply.send({
        success: true,
        message: "Conductor started",
        state: manager.getConductorState(),
      });
    } catch (error) {
      reply.code(500).send({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  /**
   * POST /api/conductor-vm/stop
   *
   * Stop the conductor VM.
   */
  fastify.post("/stop", async (request: FastifyRequest, reply: FastifyReply) => {
    const manager = getVMManager();

    try {
      await manager.stopConductor();
      reply.send({
        success: true,
        message: "Conductor stopped",
      });
    } catch (error) {
      reply.code(500).send({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  /**
   * GET /api/conductor-vm/status
   *
   * Get conductor status.
   */
  fastify.get("/status", async (request: FastifyRequest, reply: FastifyReply) => {
    const manager = getVMManager();

    reply.send({
      success: true,
      conductor: manager.getConductorState(),
      workers: manager.getWorkerStates(),
      ready: manager.isReady(),
    });
  });

  // ============================================================================
  // Message Injection (Webhooks)
  // ============================================================================

  /**
   * POST /api/conductor-vm/webhook/email
   *
   * Inject an email message into conductor.
   */
  fastify.post(
    "/webhook/email",
    async (
      request: FastifyRequest<{ Body: z.infer<typeof emailWebhookSchema> }>,
      reply: FastifyReply
    ) => {
      const manager = getVMManager();

      if (!manager.isReady()) {
        reply.code(503).send({
          success: false,
          error: "Conductor not ready",
        });
        return;
      }

      const body = emailWebhookSchema.parse(request.body);
      const message = MessageFormatter.createEmailMessage(body);

      await manager.injectMessage(message);

      reply.code(202).send({
        success: true,
        message: "Email injected into conductor",
      });
    }
  );

  /**
   * POST /api/conductor-vm/webhook/sms
   *
   * Inject an SMS message into conductor.
   */
  fastify.post(
    "/webhook/sms",
    async (
      request: FastifyRequest<{ Body: z.infer<typeof smsWebhookSchema> }>,
      reply: FastifyReply
    ) => {
      const manager = getVMManager();

      if (!manager.isReady()) {
        reply.code(503).send({
          success: false,
          error: "Conductor not ready",
        });
        return;
      }

      const body = smsWebhookSchema.parse(request.body);
      const message = MessageFormatter.createSMSMessage(body);

      await manager.injectMessage(message);

      reply.code(202).send({
        success: true,
        message: "SMS injected into conductor",
      });
    }
  );

  /**
   * POST /api/conductor-vm/prompt
   *
   * Send a user prompt to conductor.
   */
  fastify.post(
    "/prompt",
    async (
      request: FastifyRequest<{ Body: z.infer<typeof userPromptSchema> }>,
      reply: FastifyReply
    ) => {
      const manager = getVMManager();

      if (!manager.isReady()) {
        reply.code(503).send({
          success: false,
          error: "Conductor not ready",
        });
        return;
      }

      const body = userPromptSchema.parse(request.body);
      const message = MessageFormatter.createUserMessage(
        body.userId,
        body.message,
        body.username
      );

      await manager.injectMessage(message);

      reply.code(202).send({
        success: true,
        message: "Prompt sent to conductor",
      });
    }
  );

  // ============================================================================
  // Health Check
  // ============================================================================

  /**
   * GET /api/conductor-vm/health
   */
  fastify.get("/health", async (request: FastifyRequest, reply: FastifyReply) => {
    const manager = getVMManager();

    reply.send({
      success: true,
      status: manager.isReady() ? "healthy" : "not_started",
      timestamp: new Date().toISOString(),
    });
  });
}
