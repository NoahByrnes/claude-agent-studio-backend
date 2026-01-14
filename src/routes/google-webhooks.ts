/**
 * Google Webhooks Routes
 *
 * Handles push notifications from Google (Gmail, Drive, Calendar).
 * Routes events to conductor and stores in database.
 */

import type { FastifyPluginAsync } from 'fastify';
import * as gmailService from '../services/google-gmail.service.js';
import { db } from '../lib/db.js';
import { googleEvents } from '../../db/schema.js';

// Import conductor service for routing
import { getConductorService } from './webhooks.js';

interface GmailPushNotification {
  message: {
    data: string; // Base64 encoded
    messageId: string;
    publishTime: string;
  };
  subscription: string;
}

const googleWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Gmail push notification
   * POST /api/google/webhooks/gmail
   */
  fastify.post<{
    Body: GmailPushNotification;
  }>('/api/google/webhooks/gmail', async (request, reply) => {
    try {
      const notification = request.body;

      fastify.log.info({
        messageId: notification.message.messageId,
        publishTime: notification.message.publishTime,
      }, 'Gmail push notification received');

      // Decode base64 payload
      const decodedData = Buffer.from(notification.message.data, 'base64').toString('utf-8');
      const data = JSON.parse(decodedData);

      const userId = 'default-user'; // TODO: Get from subscription metadata
      const historyId = data.historyId;

      if (!historyId) {
        fastify.log.warn('No historyId in Gmail notification');
        return reply.send({ success: true });
      }

      // Fetch new messages since last historyId
      const messages = await gmailService.getHistorySince(userId, historyId);

      fastify.log.info(`Fetched ${messages.length} new messages from history`);

      // Store events in database and route to conductor
      for (const message of messages) {
        // Store in database
        await db.insert(googleEvents).values({
          user_id: userId,
          event_type: 'email_received',
          resource_id: message.id,
          payload: {
            messageId: message.id,
            threadId: message.threadId,
            from: message.from,
            to: message.to,
            subject: message.subject,
            body: message.body.substring(0, 500), // Truncate for storage
            date: message.date,
          },
        });

        // Route to conductor
        const conductorService = getConductorService();

        if (conductorService) {
          const emailContent = [
            `[EMAIL] New email received`,
            `From: ${message.from}`,
            `To: ${message.to.join(', ')}`,
            `Subject: ${message.subject}`,
            `Thread ID: ${message.threadId}`,
            '',
            message.body.substring(0, 1000), // Truncate body
          ].join('\n');

          try {
            await conductorService.sendToConductor({
              source: 'EMAIL',
              content: emailContent,
            });

            fastify.log.info(`Email routed to conductor: ${message.subject}`);
          } catch (error: any) {
            fastify.log.error('Failed to route email to conductor:', error.message);
          }
        }

        // Mark event as processed
        // Note: We mark it immediately since we routed it
        // In production, you might want to mark after conductor processes it
      }

      return reply.send({ success: true, processed: messages.length });
    } catch (error: any) {
      fastify.log.error('Failed to process Gmail notification:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Google Drive push notification (for Docs, Drive files)
   * POST /api/google/webhooks/drive
   *
   * This will be used for @mentions in Google Docs and file sharing notifications.
   * Implementation coming in Phase 2.
   */
  fastify.post('/api/google/webhooks/drive', async (request, reply) => {
    try {
      fastify.log.info('Drive push notification received (Phase 2 - not yet implemented)');

      // TODO: Phase 2 - Implement Drive Activity API integration
      // - Detect @stu mentions in docs
      // - Detect file sharing events
      // - Route to conductor

      return reply.send({ success: true, message: 'Phase 2 implementation' });
    } catch (error: any) {
      fastify.log.error('Failed to process Drive notification:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Google Calendar push notification
   * POST /api/google/webhooks/calendar
   *
   * Implementation coming in Phase 3.
   */
  fastify.post('/api/google/webhooks/calendar', async (request, reply) => {
    try {
      fastify.log.info('Calendar push notification received (Phase 3 - not yet implemented)');

      // TODO: Phase 3 - Implement Calendar webhook processing
      // - Detect event changes
      // - Route to conductor if relevant

      return reply.send({ success: true, message: 'Phase 3 implementation' });
    } catch (error: any) {
      fastify.log.error('Failed to process Calendar notification:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
};

export default googleWebhookRoutes;
