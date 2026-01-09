import type { FastifyInstance } from 'fastify';
import { AuditService } from '../services/audit.service.js';
import { AgentService } from '../services/agent.service.js';
import { authMiddleware } from '../middleware/auth.js';

const auditService = new AuditService();
const agentService = new AgentService();

export async function logRoutes(fastify: FastifyInstance) {
  // All routes require authentication
  fastify.addHook('onRequest', authMiddleware);
  // Get logs for agent
  fastify.get<{
    Params: { id: string };
    Querystring: {
      limit?: string;
      offset?: string;
      action_type?: string;
      tool_name?: string;
    };
  }>('/api/agents/:id/logs', async (request, reply) => {
    // Verify user owns this agent
    const agent = await agentService.getById(request.params.id, request.user!.id);
    if (!agent) {
      return reply.code(404).send({
        error: 'NotFound',
        message: 'Agent not found',
      });
    }

    const { limit, offset, action_type, tool_name } = request.query;

    const result = await auditService.getLogsForAgent(request.params.id, {
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
      actionType: action_type,
      toolName: tool_name,
    });

    return reply.send(result);
  });

  // WebSocket endpoint for live log streaming
  fastify.get<{ Params: { id: string } }>(
    '/api/agents/:id/logs/stream',
    { websocket: true },
    async (connection, request) => {
      const agentId = (request.params as any).id;

      // Verify user owns this agent
      const agent = await agentService.getById(agentId, request.user!.id);
      if (!agent) {
        connection.terminate();
        return;
      }

      console.log(`WebSocket connected for agent ${agentId}`);

      // Send initial logs
      auditService.getRecentLogs(agentId, 50).then((logs) => {
        connection.send(
          JSON.stringify({
            type: 'initial',
            logs,
          })
        );
      });

      // TODO: Implement real-time log streaming using Redis pub/sub or similar
      // For now, we'll send a heartbeat every 10 seconds
      const interval = setInterval(() => {
        try {
          connection.send(
            JSON.stringify({
              type: 'heartbeat',
              timestamp: new Date().toISOString(),
            })
          );
        } catch (err) {
          clearInterval(interval);
        }
      }, 10000);

      connection.on('close', () => {
        console.log(`WebSocket disconnected for agent ${agentId}`);
        clearInterval(interval);
      });
    }
  );
}
