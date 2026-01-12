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
  if (conductorService && conductorService.isInitialized()) {
    return conductorService;
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
          await sendEmail(to, subject, body);
        } catch (error: any) {
          console.error(`❌ Failed to send email: ${error.message}`);
        }
      },
      onSendSMS: async (to, message) => {
        console.log(`📱 Sending SMS to ${to}`);
        try {
          await sendSMS(to, message);
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

      const conductor = await initConductor();
      const response = await conductor.sendToConductor(message);

      return reply.send({ success: true, sessionId: response.session_id });
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

      const message: IncomingMessage = {
        source: 'SMS',
        content: `From: ${sms.from}
Message: ${sms.body}`,
      };

      const conductor = await initConductor();
      const response = await conductor.sendToConductor(message);

      return reply.send({ success: true, sessionId: response.session_id });
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
