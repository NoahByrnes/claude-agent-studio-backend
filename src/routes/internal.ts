import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db.js';
import { auditLogs, type NewAuditLog } from '../../db/schema.js';
import { LogPublisherService } from '../services/log-publisher.service.js';
import { eq, and, desc } from 'drizzle-orm';
import * as verificationCodeService from '../services/verification-code.service.js';
import * as memoryService from '../services/memory.service.js';
import { clearConductorState } from '../services/conductor-state.service.js';

const logPublisher = LogPublisherService.getInstance();

/**
 * Internal API routes for container-to-backend communication
 *
 * These endpoints are used by containers to write logs and output
 * directly to PostgreSQL and Redis pub/sub.
 *
 * Authentication: Internal API key (different from user auth)
 */
export async function internalRoutes(fastify: FastifyInstance) {
  // Internal API key authentication
  fastify.addHook('onRequest', async (request, reply) => {
    const apiKey = request.headers.authorization?.replace('Bearer ', '');
    const expectedKey = process.env.INTERNAL_API_KEY;

    if (!expectedKey) {
      return reply.code(500).send({
        error: 'InternalError',
        message: 'Internal API key not configured',
      });
    }

    if (apiKey !== expectedKey) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid internal API key',
      });
    }
  });

  /**
   * Write agent output to storage
   * Called by containers during agent execution
   */
  fastify.post<{
    Body: {
      agentId: string;
      sessionId: string;
      key: string;
      value: string;
      timestamp: string;
    };
  }>('/api/internal/logs', async (request, reply) => {
    const { agentId, sessionId, key, value, timestamp } = request.body;

    // Store in audit logs
    const [log] = await db
      .insert(auditLogs)
      .values({
        agent_id: agentId,
        session_id: sessionId,
        action_type: 'agent_output',
        tool_name: 'runtime',
        input_data: { key },
        output_data: { value },
        timestamp: new Date(timestamp),
      })
      .returning();

    // Publish for real-time streaming
    await logPublisher.publishLog(log);

    return reply.send({ success: true, logId: log.id });
  });

  /**
   * Append to existing agent output
   * Called by containers to stream output in chunks
   */
  fastify.post<{
    Body: {
      agentId: string;
      sessionId: string;
      key: string;
      chunk: string;
      timestamp: string;
    };
  }>('/api/internal/logs/append', async (request, reply) => {
    const { agentId, sessionId, key, chunk, timestamp } = request.body;

    // Get the most recent log entry for this session
    const existingLogs = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.agent_id, agentId),
          eq(auditLogs.action_type, 'agent_output')
        )
      )
      .orderBy(desc(auditLogs.timestamp))
      .limit(1);

    let log;

    if (existingLogs.length > 0 && existingLogs[0].output_data) {
      // Append to existing log
      const existing = existingLogs[0];
      const currentValue = (existing.output_data as any).value || '';
      const newValue = currentValue + chunk;

      [log] = await db
        .update(auditLogs)
        .set({
          output_data: { value: newValue },
          timestamp: new Date(timestamp),
        })
        .where(eq(auditLogs.id, existing.id))
        .returning();
    } else {
      // Create new log entry
      [log] = await db
        .insert(auditLogs)
        .values({
          agent_id: agentId,
          session_id: sessionId,
          action_type: 'agent_output',
          tool_name: 'runtime',
          input_data: { key },
          output_data: { value: chunk },
          timestamp: new Date(timestamp),
        })
        .returning();
    }

    // Publish for real-time streaming
    await logPublisher.publishLog(log);

    return reply.send({ success: true, logId: log.id });
  });

  /**
   * Update agent session status
   * Called by containers to mark sessions as completed/failed
   */
  fastify.post<{
    Body: {
      agentId: string;
      sessionId: string;
      status: 'started' | 'completed' | 'failed' | 'error';
      error?: string;
    };
  }>('/api/internal/sessions/status', async (request, reply) => {
    const { agentId, sessionId, status, error } = request.body;

    const [log] = await db
      .insert(auditLogs)
      .values({
        agent_id: agentId,
        session_id: sessionId,
        action_type: 'session_status',
        tool_name: 'runtime',
        input_data: { status },
        output_data: { error: error || null },
        timestamp: new Date(),
      })
      .returning();

    // Publish for real-time streaming
    await logPublisher.publishLog(log);

    return reply.send({ success: true, logId: log.id });
  });

  /**
   * Health check for internal API
   */
  fastify.get('/api/internal/health', async (request, reply) => {
    return reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'internal-api',
    });
  });

  /**
   * Get latest verification code (for Stu's autonomous 2FA)
   * GET /api/internal/verification-code/latest
   */
  fastify.get('/api/internal/verification-code/latest', async (request, reply) => {
    try {
      const code = await verificationCodeService.getLatestVerificationCode();

      if (!code) {
        return reply.code(404).send({
          success: false,
          message: 'No verification code available',
        });
      }

      return reply.send({
        success: true,
        code: code.code,
        source: code.source,
        sender: code.sender,
        detectedAt: code.detectedAt,
        expiresAt: code.expiresAt,
        fullMessage: code.fullMessage,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Get verification code from specific sender
   * GET /api/internal/verification-code/sender/:sender
   */
  fastify.get<{
    Params: { sender: string };
  }>('/api/internal/verification-code/sender/:sender', async (request, reply) => {
    try {
      const { sender } = request.params;
      const code = await verificationCodeService.getVerificationCodeFromSender(sender);

      if (!code) {
        return reply.code(404).send({
          success: false,
          message: `No verification code from sender: ${sender}`,
        });
      }

      return reply.send({
        success: true,
        code: code.code,
        source: code.source,
        sender: code.sender,
        detectedAt: code.detectedAt,
        expiresAt: code.expiresAt,
        fullMessage: code.fullMessage,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Clear all verification codes
   * DELETE /api/internal/verification-code/all
   */
  fastify.delete('/api/internal/verification-code/all', async (request, reply) => {
    try {
      await verificationCodeService.clearVerificationCodes();

      return reply.send({
        success: true,
        message: 'All verification codes cleared',
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Clear conductor state and force fresh session
   * POST /api/internal/conductor/clear
   */
  fastify.post('/api/internal/conductor/clear', async (request, reply) => {
    try {
      console.log('🔄 API: Clearing conductor state...');

      // Clear memory backups (PostgreSQL + Redis)
      await memoryService.clearMemoryBackups('default');

      // Clear in-memory conductor state
      await clearConductorState();

      console.log('✅ API: Conductor state cleared successfully');

      return reply.send({
        success: true,
        message: 'Conductor state cleared - next SMS will create fresh session with new system prompt',
      });
    } catch (error: any) {
      console.error('❌ API: Failed to clear conductor state:', error.message);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
}
