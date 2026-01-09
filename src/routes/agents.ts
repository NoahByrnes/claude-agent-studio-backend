import type { FastifyInstance } from 'fastify';
import { AgentService } from '../services/agent.service.js';
import { SandboxService } from '../services/sandbox.service.js';
import { CreateAgentRequest, UpdateAgentRequest } from '../shared-types/index.js';
import { authMiddleware } from '../middleware/auth.js';

const agentService = new AgentService();
const sandboxService = new SandboxService();

export async function agentRoutes(fastify: FastifyInstance) {
  // All routes require authentication
  fastify.addHook('onRequest', authMiddleware);

  // Create agent
  fastify.post('/api/agents', async (request, reply) => {
    try {
      const validatedConfig = CreateAgentRequest.parse(request.body);
      const agent = await agentService.create(validatedConfig, request.user!.id);
      return reply.code(201).send(agent);
    } catch (error: any) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: error.message,
      });
    }
  });

  // Get all agents
  fastify.get('/api/agents', async (request, reply) => {
    const agents = await agentService.getAll(request.user!.id);
    return reply.send({
      agents,
      total: agents.length,
    });
  });

  // Get agent by ID
  fastify.get<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const agent = await agentService.getById(request.params.id, request.user!.id);
    if (!agent) {
      return reply.code(404).send({
        error: 'NotFound',
        message: 'Agent not found',
      });
    }
    return reply.send(agent);
  });

  // Update agent
  fastify.put<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    try {
      const validatedConfig = UpdateAgentRequest.parse(request.body);
      const agent = await agentService.update(request.params.id, request.user!.id, validatedConfig);
      if (!agent) {
        return reply.code(404).send({
          error: 'NotFound',
          message: 'Agent not found',
        });
      }
      return reply.send(agent);
    } catch (error: any) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: error.message,
      });
    }
  });

  // Delete agent
  fastify.delete<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const deleted = await agentService.delete(request.params.id, request.user!.id);
    if (!deleted) {
      return reply.code(404).send({
        error: 'NotFound',
        message: 'Agent not found',
      });
    }
    return reply.code(204).send();
  });

  // Deploy agent
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/deploy', async (request, reply) => {
    try {
      const deployment = await sandboxService.deploy(request.params.id, request.user!.id);
      return reply.send(deployment);
    } catch (error: any) {
      return reply.code(500).send({
        error: 'DeploymentError',
        message: error.message,
      });
    }
  });

  // Stop agent
  fastify.post<{ Params: { id: string } }>('/api/agents/:id/stop', async (request, reply) => {
    try {
      await sandboxService.stop(request.params.id, request.user!.id);
      return reply.code(204).send();
    } catch (error: any) {
      return reply.code(500).send({
        error: 'StopError',
        message: error.message,
      });
    }
  });

  // Get agent metrics
  fastify.get<{ Params: { id: string } }>('/api/agents/:id/metrics', async (request, reply) => {
    // Verify user owns this agent
    const agent = await agentService.getById(request.params.id, request.user!.id);
    if (!agent) {
      return reply.code(404).send({
        error: 'NotFound',
        message: 'Agent not found',
      });
    }

    // TODO: Implement actual metrics calculation
    return reply.send({
      agent_id: request.params.id,
      tasks_completed: 0,
      tasks_failed: 0,
      uptime_seconds: 0,
      last_active: null,
    });
  });
}
