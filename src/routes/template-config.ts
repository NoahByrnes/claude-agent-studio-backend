/**
 * Template Configuration Routes
 *
 * API endpoints for managing E2B template IDs
 */

import type { FastifyPluginAsync } from 'fastify';
import {
  getTemplateConfig,
  updateTemplateId,
  updateTemplateConfig,
} from '../services/template-config.service.js';
import { reloadTemplates } from '../config/templates.js';

const templateConfigRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/template-config - Get current template configuration
  fastify.get('/api/template-config', async (request, reply) => {
    try {
      const config = await getTemplateConfig();
      return reply.send({
        success: true,
        config,
      });
    } catch (error: any) {
      fastify.log.error('Failed to get template config:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // POST /api/template-config - Update template configuration
  fastify.post<{
    Body: {
      type?: 'conductor' | 'worker' | 'infrastructure';
      templateId?: string;
      conductor?: string;
      worker?: string;
      infrastructure?: string;
      updatedBy?: string;
    };
  }>('/api/template-config', async (request, reply) => {
    try {
      const { type, templateId, conductor, worker, infrastructure, updatedBy } = request.body;

      // Validate request
      if (!type && !conductor && !worker && !infrastructure) {
        return reply.code(400).send({
          success: false,
          error: 'Must provide either type+templateId or direct template IDs',
        });
      }

      let config;

      // Update single template type
      if (type && templateId) {
        config = await updateTemplateId(type, templateId, updatedBy || 'api');
      }
      // Update multiple template types
      else {
        const updates: any = {};
        if (conductor) updates.conductor = conductor;
        if (worker) updates.worker = worker;
        if (infrastructure) updates.infrastructure = infrastructure;

        config = await updateTemplateConfig(updates, updatedBy || 'api');
      }

      // Reload templates in memory
      await reloadTemplates();

      return reply.send({
        success: true,
        config,
        message: 'Template configuration updated successfully',
      });
    } catch (error: any) {
      fastify.log.error('Failed to update template config:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // POST /api/template-config/worker - Shorthand for updating worker template
  fastify.post<{
    Body: {
      templateId: string;
      updatedBy?: string;
    };
  }>('/api/template-config/worker', async (request, reply) => {
    try {
      const { templateId, updatedBy } = request.body;

      if (!templateId) {
        return reply.code(400).send({
          success: false,
          error: 'templateId is required',
        });
      }

      const config = await updateTemplateId('worker', templateId, updatedBy || 'api');

      // Reload templates in memory
      await reloadTemplates();

      return reply.send({
        success: true,
        config,
        message: 'Worker template ID updated successfully',
      });
    } catch (error: any) {
      fastify.log.error('Failed to update worker template:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // POST /api/template-config/infrastructure - Shorthand for updating infrastructure template
  fastify.post<{
    Body: {
      templateId: string;
      updatedBy?: string;
    };
  }>('/api/template-config/infrastructure', async (request, reply) => {
    try {
      const { templateId, updatedBy } = request.body;

      if (!templateId) {
        return reply.code(400).send({
          success: false,
          error: 'templateId is required',
        });
      }

      const config = await updateTemplateId('infrastructure', templateId, updatedBy || 'api');

      // Reload templates in memory
      await reloadTemplates();

      return reply.send({
        success: true,
        config,
        message: 'Infrastructure template ID updated successfully',
      });
    } catch (error: any) {
      fastify.log.error('Failed to update infrastructure template:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // POST /api/template-config/conductor - Shorthand for updating conductor template
  fastify.post<{
    Body: {
      templateId: string;
      updatedBy?: string;
    };
  }>('/api/template-config/conductor', async (request, reply) => {
    try {
      const { templateId, updatedBy } = request.body;

      if (!templateId) {
        return reply.code(400).send({
          success: false,
          error: 'templateId is required',
        });
      }

      const config = await updateTemplateId('conductor', templateId, updatedBy || 'api');

      // Reload templates in memory
      await reloadTemplates();

      return reply.send({
        success: true,
        config,
        message: 'Conductor template ID updated successfully',
      });
    } catch (error: any) {
      fastify.log.error('Failed to update conductor template:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
};

export default templateConfigRoutes;
