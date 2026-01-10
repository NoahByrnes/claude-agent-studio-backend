import type { FastifyInstance } from 'fastify';
import { E2BSandboxService } from '../services/e2b-sandbox.service.js';
import { authMiddleware } from '../middleware/auth.js';

const sandboxService = new E2BSandboxService();

/**
 * Sandbox management routes for E2B deployment
 */
export async function sandboxRoutes(fastify: FastifyInstance) {
  // All routes require authentication
  fastify.addHook('onRequest', authMiddleware);

  /**
   * Deploy agent to E2B sandbox
   */
  fastify.post<{
    Params: { id: string };
  }>('/api/agents/:id/deploy', async (request, reply) => {
    try {
      const deployment = await sandboxService.deploy(
        request.params.id,
        request.user!.id
      );

      return reply.send({
        success: true,
        deployment,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Execute prompt in agent sandbox
   */
  fastify.post<{
    Params: { id: string };
    Body: {
      prompt: string;
      env?: Record<string, string>;
    };
  }>('/api/agents/:id/execute', async (request, reply) => {
    try {
      const { prompt, env } = request.body;

      if (!prompt) {
        return reply.code(400).send({
          success: false,
          error: 'Prompt is required',
        });
      }

      // Generate session ID
      const sessionId = `${request.params.id}-${Date.now()}`;

      const result = await sandboxService.execute(
        request.params.id,
        sessionId,
        prompt,
        env
      );

      return reply.send({
        success: true,
        ...result,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Stop agent sandbox
   */
  fastify.post<{
    Params: { id: string };
  }>('/api/agents/:id/stop', async (request, reply) => {
    try {
      await sandboxService.stop(request.params.id, request.user!.id);

      return reply.send({
        success: true,
        message: 'Sandbox stopped successfully',
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Get sandbox deployment info
   */
  fastify.get<{
    Params: { id: string };
  }>('/api/agents/:id/sandbox', async (request, reply) => {
    try {
      const deployment = await sandboxService.getDeployment(request.params.id);

      if (!deployment) {
        return reply.code(404).send({
          success: false,
          error: 'No sandbox deployment found',
        });
      }

      return reply.send({
        success: true,
        deployment,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Upload files to sandbox
   */
  fastify.post<{
    Params: { id: string };
    Body: {
      files: { path: string; content: string }[];
    };
  }>('/api/agents/:id/sandbox/files', async (request, reply) => {
    try {
      const { files } = request.body;

      if (!files || !Array.isArray(files)) {
        return reply.code(400).send({
          success: false,
          error: 'Files array is required',
        });
      }

      await sandboxService.uploadFiles(request.params.id, files);

      return reply.send({
        success: true,
        message: `${files.length} files uploaded successfully`,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Install npm packages in sandbox
   */
  fastify.post<{
    Params: { id: string };
    Body: {
      packages: string[];
    };
  }>('/api/agents/:id/sandbox/packages', async (request, reply) => {
    try {
      const { packages } = request.body;

      if (!packages || !Array.isArray(packages)) {
        return reply.code(400).send({
          success: false,
          error: 'Packages array is required',
        });
      }

      await sandboxService.installPackages(request.params.id, packages);

      return reply.send({
        success: true,
        message: `Packages installed: ${packages.join(', ')}`,
      });
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Execute command in sandbox
   */
  fastify.post<{
    Params: { id: string };
    Body: {
      command: string;
      timeout?: number;
    };
  }>('/api/agents/:id/sandbox/exec', async (request, reply) => {
    try {
      const { command, timeout } = request.body;

      if (!command) {
        return reply.code(400).send({
          success: false,
          error: 'Command is required',
        });
      }

      const result = await sandboxService.exec(request.params.id, command, {
        timeout,
      });

      return reply.send(result);
    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
}
