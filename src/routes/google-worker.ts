/**
 * Google Worker API Routes
 *
 * API endpoints for E2B workers to access Google services.
 * Secured with INTERNAL_API_KEY (same as /api/internal/* routes).
 * Workers call these endpoints; backend proxies to Google APIs with encrypted tokens.
 */

import type { FastifyPluginAsync } from 'fastify';
import * as gmailService from '../services/google-gmail.service.js';
import * as sessionService from '../services/google-session.service.js';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

/**
 * Verify INTERNAL_API_KEY from Authorization header
 */
function verifyInternalApiKey(authHeader: string | undefined): boolean {
  if (!authHeader) return false;

  const token = authHeader.replace(/^Bearer\s+/i, '');
  return token === INTERNAL_API_KEY;
}

const googleWorkerRoutes: FastifyPluginAsync = async (fastify) => {
  // Hook to verify API key on all routes
  fastify.addHook('onRequest', async (request, reply) => {
    const authHeader = request.headers.authorization;

    if (!verifyInternalApiKey(authHeader)) {
      return reply.code(401).send({
        success: false,
        error: 'Unauthorized: Invalid or missing INTERNAL_API_KEY',
      });
    }
  });

  // ============================================================================
  // WEB SESSION ENDPOINTS (for Playwright-based workers)
  // ============================================================================

  /**
   * Get Google web session cookies for Playwright
   * GET /api/google/worker/session/cookies?userId=...
   *
   * Returns cookies that workers can inject into Playwright browser context
   * to access Google's web UI (Docs, Gmail, Drive, etc.)
   */
  fastify.get<{
    Querystring: { userId?: string };
  }>('/api/google/worker/session/cookies', async (request, reply) => {
    try {
      const { userId = 'default-user' } = request.query;

      // Get or create web session
      const session = await sessionService.ensureWebSession(userId);

      // Export session data for worker
      const sessionData = sessionService.exportSessionForWorker(session);

      return reply.send({
        success: true,
        ...sessionData,
      });
    } catch (error: any) {
      fastify.log.error('Failed to get web session:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // ============================================================================
  // GMAIL ENDPOINTS
  // ============================================================================

  /**
   * Send email
   * POST /api/google/worker/gmail/send
   */
  fastify.post<{
    Body: {
      to: string | string[];
      subject: string;
      body: string;
      cc?: string | string[];
      bcc?: string | string[];
      userId?: string;
    };
  }>('/api/google/worker/gmail/send', async (request, reply) => {
    try {
      const { to, subject, body, cc, bcc, userId = 'default-user' } = request.body;

      // Validate required fields
      if (!to || !subject || !body) {
        return reply.code(400).send({
          success: false,
          error: 'Missing required fields: to, subject, body',
        });
      }

      // TODO: Check permission via google-permissions.service
      // For now, allow all email sends (approval handled by conductor)

      const messageId = await gmailService.sendEmail(userId, {
        to,
        subject,
        body,
        cc,
        bcc,
      });

      return reply.send({
        success: true,
        messageId,
        message: 'Email sent successfully',
      });
    } catch (error: any) {
      fastify.log.error('Failed to send email:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Reply to email thread
   * POST /api/google/worker/gmail/reply/:threadId
   */
  fastify.post<{
    Params: { threadId: string };
    Body: {
      body: string;
      replyAll?: boolean;
      userId?: string;
    };
  }>('/api/google/worker/gmail/reply/:threadId', async (request, reply) => {
    try {
      const { threadId } = request.params;
      const { body, replyAll = false, userId = 'default-user' } = request.body;

      if (!body) {
        return reply.code(400).send({
          success: false,
          error: 'Missing required field: body',
        });
      }

      const messageId = await gmailService.replyToThread(userId, threadId, body, replyAll);

      return reply.send({
        success: true,
        messageId,
        threadId,
        message: 'Reply sent successfully',
      });
    } catch (error: any) {
      fastify.log.error('Failed to reply to thread:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Search emails
   * GET /api/google/worker/gmail/search?query=...&maxResults=...&userId=...
   */
  fastify.get<{
    Querystring: {
      query: string;
      maxResults?: number;
      userId?: string;
    };
  }>('/api/google/worker/gmail/search', async (request, reply) => {
    try {
      const { query, maxResults = 50, userId = 'default-user' } = request.query;

      if (!query) {
        return reply.code(400).send({
          success: false,
          error: 'Missing required query parameter: query',
        });
      }

      const messages = await gmailService.searchEmails(userId, query, maxResults);

      return reply.send({
        success: true,
        messages,
        count: messages.length,
      });
    } catch (error: any) {
      fastify.log.error('Failed to search emails:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Get specific message
   * GET /api/google/worker/gmail/messages/:messageId?userId=...
   */
  fastify.get<{
    Params: { messageId: string };
    Querystring: { userId?: string };
  }>('/api/google/worker/gmail/messages/:messageId', async (request, reply) => {
    try {
      const { messageId } = request.params;
      const { userId = 'default-user' } = request.query;

      const message = await gmailService.getMessage(userId, messageId);

      return reply.send({
        success: true,
        message,
      });
    } catch (error: any) {
      fastify.log.error('Failed to get message:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Get email thread
   * GET /api/google/worker/gmail/threads/:threadId?userId=...
   */
  fastify.get<{
    Params: { threadId: string };
    Querystring: { userId?: string };
  }>('/api/google/worker/gmail/threads/:threadId', async (request, reply) => {
    try {
      const { threadId } = request.params;
      const { userId = 'default-user' } = request.query;

      const thread = await gmailService.getThread(userId, threadId);

      return reply.send({
        success: true,
        thread,
      });
    } catch (error: any) {
      fastify.log.error('Failed to get thread:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * List recent messages
   * GET /api/google/worker/gmail/messages?query=...&maxResults=...&userId=...
   */
  fastify.get<{
    Querystring: {
      query?: string;
      maxResults?: number;
      userId?: string;
    };
  }>('/api/google/worker/gmail/messages', async (request, reply) => {
    try {
      const { query = '', maxResults = 50, userId = 'default-user' } = request.query;

      const messages = await gmailService.listMessages(userId, query, maxResults);

      return reply.send({
        success: true,
        messages,
        count: messages.length,
      });
    } catch (error: any) {
      fastify.log.error('Failed to list messages:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // ============================================================================
  // GOOGLE DOCS ENDPOINTS (Placeholder - to be implemented in Phase 2)
  // ============================================================================

  /**
   * Get document content
   * GET /api/google/worker/docs/:documentId?userId=...
   */
  fastify.get<{
    Params: { documentId: string };
    Querystring: { userId?: string };
  }>('/api/google/worker/docs/:documentId', async (request, reply) => {
    try {
      // TODO: Implement google-docs.service.ts
      return reply.code(501).send({
        success: false,
        error: 'Google Docs integration coming in Phase 2',
      });
    } catch (error: any) {
      fastify.log.error('Failed to get document:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Append to document
   * POST /api/google/worker/docs/:documentId/append
   */
  fastify.post<{
    Params: { documentId: string };
    Body: {
      content: string;
      userId?: string;
    };
  }>('/api/google/worker/docs/:documentId/append', async (request, reply) => {
    try {
      // TODO: Implement google-docs.service.ts
      return reply.code(501).send({
        success: false,
        error: 'Google Docs integration coming in Phase 2',
      });
    } catch (error: any) {
      fastify.log.error('Failed to append to document:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // ============================================================================
  // GOOGLE DRIVE ENDPOINTS (Placeholder - to be implemented in Phase 2)
  // ============================================================================

  /**
   * List files
   * GET /api/google/worker/drive/files?query=...&userId=...
   */
  fastify.get<{
    Querystring: {
      query?: string;
      userId?: string;
    };
  }>('/api/google/worker/drive/files', async (request, reply) => {
    try {
      // TODO: Implement google-drive.service.ts
      return reply.code(501).send({
        success: false,
        error: 'Google Drive integration coming in Phase 2',
      });
    } catch (error: any) {
      fastify.log.error('Failed to list files:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Download file
   * GET /api/google/worker/drive/files/:fileId/download?userId=...
   */
  fastify.get<{
    Params: { fileId: string };
    Querystring: { userId?: string };
  }>('/api/google/worker/drive/files/:fileId/download', async (request, reply) => {
    try {
      // TODO: Implement google-drive.service.ts
      return reply.code(501).send({
        success: false,
        error: 'Google Drive integration coming in Phase 2',
      });
    } catch (error: any) {
      fastify.log.error('Failed to download file:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // ============================================================================
  // GOOGLE CALENDAR ENDPOINTS (Placeholder - to be implemented in Phase 3)
  // ============================================================================

  /**
   * List calendar events
   * GET /api/google/worker/calendar/events?timeMin=...&timeMax=...&userId=...
   */
  fastify.get<{
    Querystring: {
      timeMin?: string;
      timeMax?: string;
      userId?: string;
    };
  }>('/api/google/worker/calendar/events', async (request, reply) => {
    try {
      // TODO: Implement google-calendar.service.ts
      return reply.code(501).send({
        success: false,
        error: 'Google Calendar integration coming in Phase 3',
      });
    } catch (error: any) {
      fastify.log.error('Failed to list events:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Create calendar event (requires approval)
   * POST /api/google/worker/calendar/events/create
   */
  fastify.post<{
    Body: {
      summary: string;
      start: string;
      end: string;
      description?: string;
      userId?: string;
    };
  }>('/api/google/worker/calendar/events/create', async (request, reply) => {
    try {
      // TODO: Implement google-calendar.service.ts with approval flow
      return reply.code(501).send({
        success: false,
        error: 'Google Calendar integration coming in Phase 3',
      });
    } catch (error: any) {
      fastify.log.error('Failed to create event:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
};

export default googleWorkerRoutes;
