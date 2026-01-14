import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import { agentRoutes } from './routes/agents.js';
import { logRoutes } from './routes/logs.js';
import { webhookRoutes, getConductorService } from './routes/webhooks.js';
import { internalRoutes } from './routes/internal.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { monitoringRoutes, setConductorServiceGetter } from './routes/monitoring.js';
import { configRoutes } from './routes/config.js';
import templateConfigRoutes from './routes/template-config.js';
import googleAuthRoutes from './routes/google-auth.js';
import googleWebhookRoutes from './routes/google-webhooks.js';
import googleWorkerRoutes from './routes/google-worker.js';
import { initializeTemplateConfig } from './services/template-config.service.js';
import { loadTemplates } from './config/templates.js';
// Worker disabled until Redis is configured
// import './workers/event-processor.worker.js';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'warn', // Reduced from 'info' to reduce log clutter
  },
});

// Register plugins
await fastify.register(cors, {
  origin: process.env.CORS_ORIGIN || '*',
});

await fastify.register(websocket);
await fastify.register(formbody);

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Set up monitoring to access conductor service
setConductorServiceGetter(getConductorService);

// Initialize template configuration system (Redis-based)
await initializeTemplateConfig();
await loadTemplates();

// Register routes
await fastify.register(agentRoutes);
await fastify.register(logRoutes);
await fastify.register(webhookRoutes);
await fastify.register(monitoringRoutes);
await fastify.register(configRoutes);
await fastify.register(templateConfigRoutes);
await fastify.register(internalRoutes);
await fastify.register(sandboxRoutes);
await fastify.register(googleAuthRoutes);
await fastify.register(googleWebhookRoutes);
await fastify.register(googleWorkerRoutes);

// Start server
try {
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`🚀 Backend API running on http://${HOST}:${PORT}`);
  console.log(`📊 Health check: http://${HOST}:${PORT}/health`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await fastify.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await fastify.close();
  process.exit(0);
});
