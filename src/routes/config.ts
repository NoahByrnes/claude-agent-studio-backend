/**
 * Configuration Routes
 *
 * API endpoints for managing connector configurations.
 */

import type { FastifyInstance } from 'fastify';
import {
  saveConnectorConfig,
  getConnectorConfig,
  getAllConnectorConfigs,
  deleteConnectorConfig,
} from '../services/config.service.js';

export async function configRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/config/connectors
   * Get all connector configurations for current user
   */
  fastify.get('/api/config/connectors', async (request, reply) => {
    try {
      // For MVP, use a default user ID (in production, get from auth)
      const userId = 'default-user';

      const configs = await getAllConnectorConfigs(userId);

      // Mask sensitive fields in response
      const maskSensitive = (settings: any) => {
        if (!settings) return settings;
        const masked = { ...settings };
        if (masked.apiKey) {
          masked.apiKey = masked.apiKey.substring(0, 8) + '...' + masked.apiKey.slice(-4);
        }
        if (masked.authToken) {
          masked.authToken = masked.authToken.substring(0, 8) + '...' + masked.authToken.slice(-4);
        }
        if (masked.accountSid) {
          masked.accountSid =
            masked.accountSid.substring(0, 8) + '...' + masked.accountSid.slice(-4);
        }
        return masked;
      };

      return reply.send({
        email: configs.email
          ? {
              enabled: configs.email.enabled,
              settings: maskSensitive(configs.email.settings),
              updatedAt: configs.email.updatedAt,
            }
          : null,
        sms: configs.sms
          ? {
              enabled: configs.sms.enabled,
              settings: maskSensitive(configs.sms.settings),
              updatedAt: configs.sms.updatedAt,
            }
          : null,
      });
    } catch (error: any) {
      return reply.code(500).send({
        error: 'Failed to get connector configs',
        message: error.message,
      });
    }
  });

  /**
   * POST /api/config/connectors/email
   * Save email connector configuration
   */
  fastify.post('/api/config/connectors/email', async (request, reply) => {
    try {
      const { apiKey, fromEmail } = request.body as any;

      if (!apiKey || !fromEmail) {
        return reply.code(400).send({
          error: 'Missing required fields',
          message: 'apiKey and fromEmail are required',
        });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(fromEmail)) {
        return reply.code(400).send({
          error: 'Invalid email format',
          message: 'fromEmail must be a valid email address',
        });
      }

      // Validate SendGrid API key format
      if (!apiKey.startsWith('SG.')) {
        return reply.code(400).send({
          error: 'Invalid API key format',
          message: 'SendGrid API key must start with "SG."',
        });
      }

      const userId = 'default-user';

      await saveConnectorConfig(userId, 'email', {
        apiKey,
        fromEmail,
      });

      return reply.send({
        success: true,
        message: 'Email connector configured successfully',
      });
    } catch (error: any) {
      return reply.code(500).send({
        error: 'Failed to save email config',
        message: error.message,
      });
    }
  });

  /**
   * POST /api/config/connectors/sms
   * Save SMS connector configuration
   */
  fastify.post('/api/config/connectors/sms', async (request, reply) => {
    try {
      const { accountSid, authToken, phoneNumber } = request.body as any;

      if (!accountSid || !authToken || !phoneNumber) {
        return reply.code(400).send({
          error: 'Missing required fields',
          message: 'accountSid, authToken, and phoneNumber are required',
        });
      }

      // Validate Twilio Account SID format
      if (!accountSid.startsWith('AC')) {
        return reply.code(400).send({
          error: 'Invalid Account SID format',
          message: 'Twilio Account SID must start with "AC"',
        });
      }

      // Validate phone number format (basic check)
      if (!phoneNumber.startsWith('+')) {
        return reply.code(400).send({
          error: 'Invalid phone number format',
          message: 'Phone number must be in E.164 format (e.g., +1234567890)',
        });
      }

      const userId = 'default-user';

      await saveConnectorConfig(userId, 'sms', {
        accountSid,
        authToken,
        phoneNumber,
      });

      return reply.send({
        success: true,
        message: 'SMS connector configured successfully',
      });
    } catch (error: any) {
      return reply.code(500).send({
        error: 'Failed to save SMS config',
        message: error.message,
      });
    }
  });

  /**
   * DELETE /api/config/connectors/:type
   * Delete connector configuration
   */
  fastify.delete('/api/config/connectors/:type', async (request, reply) => {
    try {
      const { type } = request.params as { type: string };

      if (type !== 'email' && type !== 'sms') {
        return reply.code(400).send({
          error: 'Invalid connector type',
          message: 'Type must be "email" or "sms"',
        });
      }

      const userId = 'default-user';

      await deleteConnectorConfig(userId, type as 'email' | 'sms');

      return reply.send({
        success: true,
        message: `${type} connector deleted successfully`,
      });
    } catch (error: any) {
      return reply.code(500).send({
        error: 'Failed to delete connector config',
        message: error.message,
      });
    }
  });

  /**
   * POST /api/config/connectors/test/:type
   * Test connector configuration
   */
  fastify.post('/api/config/connectors/test/:type', async (request, reply) => {
    try {
      const { type } = request.params as { type: string };
      const { testEmail, testPhone } = request.body as any;

      if (type === 'email') {
        if (!testEmail) {
          return reply.code(400).send({
            error: 'Missing test email',
            message: 'testEmail is required for email connector test',
          });
        }

        // TODO: Send test email using connector config
        return reply.send({
          success: true,
          message: `Test email would be sent to ${testEmail}`,
        });
      } else if (type === 'sms') {
        if (!testPhone) {
          return reply.code(400).send({
            error: 'Missing test phone',
            message: 'testPhone is required for SMS connector test',
          });
        }

        // TODO: Send test SMS using connector config
        return reply.send({
          success: true,
          message: `Test SMS would be sent to ${testPhone}`,
        });
      } else {
        return reply.code(400).send({
          error: 'Invalid connector type',
          message: 'Type must be "email" or "sms"',
        });
      }
    } catch (error: any) {
      return reply.code(500).send({
        error: 'Failed to test connector',
        message: error.message,
      });
    }
  });
}
