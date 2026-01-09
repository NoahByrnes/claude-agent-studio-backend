import type { FastifyInstance } from 'fastify';
import { EventRouterService } from '../services/event-router.service.js';

const eventRouter = new EventRouterService();

export async function webhookRoutes(fastify: FastifyInstance) {
  // Generic webhook endpoint for incoming events
  fastify.post<{
    Body: {
      agent_id: string;
      event_type: 'email' | 'sms' | 'webhook' | 'scheduled';
      payload: Record<string, unknown>;
    };
  }>('/api/webhooks/event', async (request, reply) => {
    try {
      const { agent_id, event_type, payload } = request.body;

      if (!agent_id || !event_type || !payload) {
        return reply.code(400).send({
          error: 'ValidationError',
          message: 'Missing required fields: agent_id, event_type, payload',
        });
      }

      await eventRouter.routeEvent({
        agentId: agent_id,
        eventType: event_type,
        payload,
      });

      return reply.code(202).send({
        message: 'Event received and queued for processing',
      });
    } catch (error: any) {
      return reply.code(500).send({
        error: 'EventRoutingError',
        message: error.message,
      });
    }
  });

  // Email-specific webhook (for email service providers)
  fastify.post<{
    Body: {
      agent_id: string;
      from: string;
      to: string;
      subject: string;
      body: string;
      attachments?: Array<{ filename: string; url: string }>;
    };
  }>('/api/webhooks/email', async (request, reply) => {
    try {
      const { agent_id, ...emailData } = request.body;

      await eventRouter.routeEvent({
        agentId: agent_id,
        eventType: 'email',
        payload: emailData,
      });

      return reply.code(202).send({
        message: 'Email event received and queued',
      });
    } catch (error: any) {
      return reply.code(500).send({
        error: 'EventRoutingError',
        message: error.message,
      });
    }
  });
}
