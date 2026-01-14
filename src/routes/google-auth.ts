/**
 * Google Auth Routes
 *
 * Handles OAuth2 flow for connecting Google Workspace accounts.
 */

import type { FastifyPluginAsync } from 'fastify';
import * as googleAuthService from '../services/google-auth.service.js';
import * as gmailService from '../services/google-gmail.service.js';

const googleAuthRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Start OAuth flow
   * GET /api/google/auth/start
   *
   * Redirects user to Google consent screen
   */
  fastify.get('/api/google/auth/start', async (request, reply) => {
    try {
      const userId = 'default-user'; // TODO: Get from session/auth

      const authUrl = await googleAuthService.generateAuthUrl(userId);

      // Redirect to Google consent screen
      return reply.redirect(authUrl);
    } catch (error: any) {
      fastify.log.error('Failed to start OAuth flow:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * OAuth callback
   * GET /api/google/auth/callback?code=...&state=...
   *
   * Handles redirect from Google after user authorizes
   */
  fastify.get<{
    Querystring: {
      code?: string;
      state?: string;
      error?: string;
    };
  }>('/api/google/auth/callback', async (request, reply) => {
    try {
      const { code, state, error } = request.query;

      // Check for authorization errors
      if (error) {
        fastify.log.error('OAuth error:', error);
        return reply.code(400).send({
          success: false,
          error: `Authorization failed: ${error}`,
        });
      }

      if (!code) {
        return reply.code(400).send({
          success: false,
          error: 'Missing authorization code',
        });
      }

      const userId = state || 'default-user'; // State contains userId

      // Exchange code for tokens
      const credentials = await googleAuthService.handleCallback(code, userId);

      // Set up Gmail watch for push notifications
      try {
        await gmailService.watchMailbox(userId);
        fastify.log.info('✅ Gmail watch set up successfully');
      } catch (watchError: any) {
        fastify.log.error('⚠️  Failed to set up Gmail watch:', watchError.message);
        // Don't fail the whole auth flow if watch setup fails
      }

      // Success! Redirect to frontend with success message
      return reply.send({
        success: true,
        message: 'Google account connected successfully',
        account_email: credentials.account_email,
        scopes: credentials.scopes,
      });
    } catch (error: any) {
      fastify.log.error('Failed to handle OAuth callback:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Check authentication status
   * GET /api/google/auth/status
   */
  fastify.get('/api/google/auth/status', async (request, reply) => {
    try {
      const userId = 'default-user'; // TODO: Get from session/auth

      const status = await googleAuthService.getAuthStatus(userId);

      return reply.send({
        success: true,
        status,
      });
    } catch (error: any) {
      fastify.log.error('Failed to get auth status:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Revoke Google access
   * POST /api/google/auth/revoke
   */
  fastify.post('/api/google/auth/revoke', async (request, reply) => {
    try {
      const userId = 'default-user'; // TODO: Get from session/auth

      await googleAuthService.revokeAccess(userId);

      return reply.send({
        success: true,
        message: 'Google access revoked successfully',
      });
    } catch (error: any) {
      fastify.log.error('Failed to revoke access:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Refresh access token (manual trigger for testing)
   * POST /api/google/auth/refresh
   */
  fastify.post('/api/google/auth/refresh', async (request, reply) => {
    try {
      const userId = 'default-user'; // TODO: Get from session/auth

      const newToken = await googleAuthService.refreshAccessToken(userId);

      return reply.send({
        success: true,
        message: 'Access token refreshed',
        token: newToken.substring(0, 20) + '...', // Don't expose full token
      });
    } catch (error: any) {
      fastify.log.error('Failed to refresh token:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
};

export default googleAuthRoutes;
