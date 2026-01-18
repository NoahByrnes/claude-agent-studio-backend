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
import { killAllConductors, killAllWorkers, killAllInfrastructureWorkers } from '../services/e2b-cleanup.service.js';
import { E2B_TEMPLATES } from '../config/templates.js';

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

      // Check for SMS commands
      const messageBody = sms.body.trim().toLowerCase();
      const e2bApiKey = process.env.E2B_API_KEY;

      if (!e2bApiKey) {
        console.error('❌ E2B_API_KEY not configured - commands disabled');
      }

      // /help - List available commands
      if (messageBody === '/help') {
        const helpText = `📚 Available Commands:

/help - Show this help message

/new-stu - Kill all Stu (conductor) instances, keep workers running
Use when: Conversation gets confused but workers are doing good work

/kill-workers - Kill all workers, keep Stu running
Use when: Workers are stuck/broken, want to start fresh tasks

/new-session - NUCLEAR: Kill everything (Stu + all workers)
Use when: Complete fresh start needed

💡 Tip: Just text normally to talk to Stu!`;

        await sendSMS(sms.from, helpText, 'default-user');

        return reply.send({
          success: true,
          message: 'Help sent',
        });
      }

      // /new-stu - Kill all conductors, keep workers alive
      if (messageBody === '/new-stu') {
        console.log(`🔄 /new-stu command received - killing all conductor sandboxes...`);

        try {
          if (!e2bApiKey) {
            throw new Error('E2B_API_KEY not configured');
          }

          // Kill ALL conductor sandboxes (including orphaned ones)
          const result = await killAllConductors(E2B_TEMPLATES.CONDUCTOR, e2bApiKey);

          // Clear conductor state
          await clearConductorState();

          // Clear memory backups (conversation history)
          await clearMemoryBackups('default');

          // Reset conductor service to force fresh creation
          conductorService = null;

          console.log(`✅ All conductors killed: ${result.killed.length}/${result.total}`);

          await sendSMS(
            sms.from,
            `🔄 Stu reset! Killed ${result.killed.length} conductor${result.killed.length !== 1 ? 's' : ''}. Workers still running. Send your next message to start fresh.`,
            'default-user'
          );

          return reply.send({
            success: true,
            message: 'All conductors killed',
            result,
          });
        } catch (error: any) {
          console.error(`❌ Failed to kill conductors: ${error.message}`);
          await sendSMS(sms.from, `❌ Failed to reset Stu: ${error.message}`, 'default-user');
          return reply.code(500).send({ success: false, error: error.message });
        }
      }

      // /kill-workers - Kill all workers and infrastructure workers, keep conductor
      if (messageBody === '/kill-workers') {
        console.log(`🔄 /kill-workers command received - killing all worker sandboxes...`);

        try {
          if (!e2bApiKey) {
            throw new Error('E2B_API_KEY not configured');
          }

          // Kill standard workers
          const workerResult = await killAllWorkers(E2B_TEMPLATES.WORKER, e2bApiKey);

          // Kill infrastructure workers
          const infraResult = await killAllInfrastructureWorkers(E2B_TEMPLATES.INFRASTRUCTURE, e2bApiKey);

          const totalKilled = workerResult.killed.length + infraResult.killed.length;
          const totalCount = workerResult.total + infraResult.total;

          console.log(`✅ All workers killed: ${totalKilled}/${totalCount}`);

          await sendSMS(
            sms.from,
            `🧹 Killed ${totalKilled} worker${totalKilled !== 1 ? 's' : ''} (${workerResult.killed.length} standard, ${infraResult.killed.length} infrastructure). Stu is still running.`,
            'default-user'
          );

          return reply.send({
            success: true,
            message: 'All workers killed',
            workers: workerResult,
            infrastructure: infraResult,
          });
        } catch (error: any) {
          console.error(`❌ Failed to kill workers: ${error.message}`);
          await sendSMS(sms.from, `❌ Failed to kill workers: ${error.message}`, 'default-user');
          return reply.code(500).send({ success: false, error: error.message });
        }
      }

      // /new-session - Nuclear option: Kill EVERYTHING
      if (messageBody === '/new-session') {
        console.log(`🔄 /new-session command received - NUCLEAR RESET (kill all E2B sandboxes)...`);

        try {
          if (!e2bApiKey) {
            throw new Error('E2B_API_KEY not configured');
          }

          // Kill ALL sandboxes across all templates
          const conductorResult = await killAllConductors(E2B_TEMPLATES.CONDUCTOR, e2bApiKey);
          const workerResult = await killAllWorkers(E2B_TEMPLATES.WORKER, e2bApiKey);
          const infraResult = await killAllInfrastructureWorkers(E2B_TEMPLATES.INFRASTRUCTURE, e2bApiKey);

          const totalKilled = conductorResult.killed.length + workerResult.killed.length + infraResult.killed.length;
          const totalCount = conductorResult.total + workerResult.total + infraResult.total;

          // Clear all state
          await clearConductorState();
          await clearMemoryBackups('default');

          // Reset conductor service
          conductorService = null;

          console.log(`✅ NUCLEAR RESET COMPLETE: ${totalKilled}/${totalCount} sandboxes killed`);

          await sendSMS(
            sms.from,
            `💥 Nuclear reset complete! Killed ${totalKilled} sandbox${totalKilled !== 1 ? 'es' : ''} (${conductorResult.killed.length} conductors, ${workerResult.killed.length} workers, ${infraResult.killed.length} infrastructure). Everything fresh!`,
            'default-user'
          );

          return reply.send({
            success: true,
            message: 'Nuclear reset complete',
            conductors: conductorResult,
            workers: workerResult,
            infrastructure: infraResult,
          });
        } catch (error: any) {
          console.error(`❌ Failed to execute nuclear reset: ${error.message}`);
          await sendSMS(sms.from, `❌ Failed to reset: ${error.message}`, 'default-user');
          return reply.code(500).send({ success: false, error: error.message });
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
