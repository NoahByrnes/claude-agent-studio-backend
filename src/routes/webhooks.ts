/**
 * Webhook Routes - Conductor/Worker Architecture
 *
 * Handles incoming webhooks from email, SMS, and other sources.
 * Routes messages to the global conductor for autonomous processing.
 */

import type { FastifyInstance } from 'fastify';
import { ConductorE2BService } from '../conductor-cli/conductor-e2b.service.js';
import type { IncomingMessage } from '../conductor-cli/types.js';
import { sendEmail, sendSMS } from '../services/messaging.service.js';
import * as verificationCodeService from '../services/verification-code.service.js';
import { clearConductorState } from '../services/conductor-state.service.js';
import { clearMemoryBackups } from '../services/memory.service.js';

// Global conductor instance (initialized on first webhook)
let conductorService: ConductorE2BService | null = null;

/**
 * Get the global conductor service instance.
 * Used by monitoring routes to access conductor status.
 */
export function getConductorService(): ConductorE2BService | null {
  return conductorService;
}

async function initConductor() {
  // Check if we already have a conductor
  if (conductorService) {
    const isInit = conductorService.isInitialized();
    console.log(`🔍 Existing conductor found. Initialized: ${isInit}`);

    if (isInit) {
      console.log('♻️  Reusing existing E2B conductor sandbox');
      return conductorService;
    } else {
      console.log('⚠️  Conductor exists but not initialized, creating new one');
    }
  } else {
    console.log('🆕 No existing conductor, creating first one');
  }

  const e2bApiKey = process.env.E2B_API_KEY;
  const e2bTemplateId = process.env.E2B_TEMPLATE_ID;

  if (!e2bApiKey || !e2bTemplateId) {
    throw new Error('E2B_API_KEY and E2B_TEMPLATE_ID must be configured');
  }

  console.log('🚀 Initializing global conductor...');

  conductorService = new ConductorE2BService(
    {
      e2bApiKey,
      e2bTemplateId,
    },
    {
      onConductorOutput: (output) => {
        console.log(`💬 Conductor: ${output.substring(0, 200)}...`);
      },
      onWorkerSpawned: (workerId, task) => {
        console.log(`🔨 Worker spawned: ${workerId}`);
      },
      onSendEmail: async (to, subject, body) => {
        console.log(`📧 Sending email to ${to}: ${subject}`);
        try {
          await sendEmail(to, subject, body, undefined, 'default-user');
        } catch (error: any) {
          console.error(`❌ Failed to send email: ${error.message}`);
        }
      },
      onSendSMS: async (to, message) => {
        console.log(`📱 Sending SMS to ${to}`);
        try {
          await sendSMS(to, message, 'default-user');
        } catch (error: any) {
          console.error(`❌ Failed to send SMS: ${error.message}`);
        }
      },
      onError: (error) => {
        console.error('❌ Conductor error:', error);
      },
    }
  );

  await conductorService.initConductor();
  return conductorService;
}

export async function webhookRoutes(fastify: FastifyInstance) {
  // Email webhook
  fastify.post('/api/webhooks/email', async (request, reply) => {
    try {
      const body = request.body as any;

      const email = {
        from: body.from || body.sender,
        to: body.to || body.recipient,
        subject: body.subject,
        body: body.text || body.body,
      };

      console.log(`📧 Incoming email from ${email.from}: ${email.subject}`);

      const message: IncomingMessage = {
        source: 'EMAIL',
        content: `From: ${email.from}
To: ${email.to}
Subject: ${email.subject}

${email.body}`,
      };

      let conductor = await initConductor();

      try {
        const response = await conductor.sendToConductor(message);
        return reply.send({ success: true, sessionId: response.session_id });
      } catch (innerError: any) {
        // Check if E2B sandbox died (expired after 1 hour)
        if (innerError.message?.includes('Sandbox is probably not running anymore') ||
            innerError.message?.includes('NotFoundError')) {
          console.log('🔄 E2B sandbox expired, creating new conductor...');

          // Reset conductor to force recreation
          conductorService = null;

          // Create fresh conductor and retry
          conductor = await initConductor();
          const response = await conductor.sendToConductor(message);
          return reply.send({ success: true, sessionId: response.session_id });
        }

        // Re-throw if it's a different error
        throw innerError;
      }
    } catch (error: any) {
      console.error('❌ Email webhook error:', error);
      return reply.code(500).send({ error: error.message });
    }
  });

  // SMS webhook
  fastify.post('/api/webhooks/sms', async (request, reply) => {
    try {
      const body = request.body as any;

      const sms = {
        from: body.From || body.from,
        body: body.Body || body.body,
      };

      console.log(`📱 Incoming SMS from ${sms.from}`);

      // Check if this is a verification code
      const verificationResult = await verificationCodeService.processIncomingMessage(
        sms.body,
        'SMS',
        sms.from
      );

      if (verificationResult.isVerificationCode) {
        console.log(`🔐 Verification code detected, stored for Stu's use`);

        // Don't route to Stu - just acknowledge receipt
        return reply.send({
          success: true,
          message: 'Verification code received and stored',
          code: verificationResult.code,
        });
      }

      // Check for /new-session command (force fresh conductor session)
      const messageBody = sms.body.trim();
      if (messageBody === '/new-session' || messageBody.toLowerCase() === '/new-session') {
        console.log(`🔄 /new-session command received - clearing conductor state...`);

        try {
          // Clear conductor state (PostgreSQL + Redis)
          await clearConductorState();

          // Clear memory backups (conversation history)
          await clearMemoryBackups('default');

          // Kill existing conductor service and all E2B sandboxes
          if (conductorService) {
            try {
              console.log(`   🔪 Killing existing conductor and worker E2B sandboxes...`);
              await conductorService.cleanup();
              console.log(`   ✅ All E2B sandboxes terminated`);
            } catch (cleanupError: any) {
              console.error(`   ❌ Conductor cleanup error: ${cleanupError.message}`);
              console.error(`   Full error:`, cleanupError);
              // Continue anyway - we'll clear state and force fresh creation
            }
          } else {
            console.log(`   ℹ️  No active conductor service to clean up`);
          }

          // Reset conductor to force fresh creation on next message
          conductorService = null;

          console.log(`✅ Conductor state cleared - next message will start fresh session`);

          // Send acknowledgment SMS
          await sendSMS(
            sms.from,
            '🔄 Session reset complete! Send your next message to start a fresh conversation with Stu.',
            'default-user'
          );

          return reply.send({
            success: true,
            message: 'Session reset - fresh conductor will be created on next message',
          });
        } catch (resetError: any) {
          console.error(`❌ Failed to reset session: ${resetError.message}`);

          await sendSMS(
            sms.from,
            `❌ Failed to reset session: ${resetError.message}`,
            'default-user'
          );

          return reply.code(500).send({
            success: false,
            error: resetError.message,
          });
        }
      }

      // Normal message - route to Stu
      const message: IncomingMessage = {
        source: 'SMS',
        content: `From: ${sms.from}
Message: ${sms.body}`,
      };

      let conductor = await initConductor();

      try {
        const response = await conductor.sendToConductor(message);
        return reply.send({ success: true, sessionId: response.session_id });
      } catch (innerError: any) {
        // Check if E2B sandbox died (expired after 1 hour)
        if (innerError.message?.includes('Sandbox is probably not running anymore') ||
            innerError.message?.includes('NotFoundError')) {
          console.log('🔄 E2B sandbox expired, creating new conductor...');

          // Reset conductor to force recreation
          conductorService = null;

          // Create fresh conductor and retry
          conductor = await initConductor();
          const response = await conductor.sendToConductor(message);
          return reply.send({ success: true, sessionId: response.session_id });
        }

        // Re-throw if it's a different error
        throw innerError;
      }
    } catch (error: any) {
      console.error('❌ SMS webhook error:', error);
      return reply.code(500).send({ error: error.message });
    }
  });

  // Get conductor status
  fastify.get('/api/webhooks/conductor/status', async (request, reply) => {
    if (!conductorService || !conductorService.isInitialized()) {
      return reply.send({ initialized: false });
    }

    const conductor = conductorService.getConductorSession();
    const workers = conductorService.getWorkerSessions();

    return reply.send({
      initialized: true,
      conductor: {
        sessionId: conductor?.id,
        sandboxId: conductor?.sandboxId,
        activeWorkers: conductor?.activeWorkers.length || 0,
      },
      workers: workers.map((w) => ({
        sessionId: w.id,
        status: w.status,
      })),
    });
  });

  // Test route - manually send message to conductor
  fastify.post('/api/webhooks/conductor/message', async (request, reply) => {
    try {
      const { content } = request.body as any;

      if (!content) {
        return reply.code(400).send({ error: 'content is required' });
      }

      const message: IncomingMessage = {
        source: 'USER',
        content,
      };

      const conductor = await initConductor();
      const response = await conductor.sendToConductor(message);

      return reply.send({
        success: true,
        conductorResponse: response.result,
      });
    } catch (error: any) {
      console.error('❌ Manual message error:', error);
      return reply.code(500).send({ error: error.message });
    }
  });
}
