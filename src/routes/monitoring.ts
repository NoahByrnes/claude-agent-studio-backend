/**
 * Monitoring Routes
 *
 * Provides real-time status and metrics for the conductor/worker system.
 * Used by the frontend dashboard for monitoring and visualization.
 */

import type { FastifyInstance } from 'fastify';
import { getMessagingStatus } from '../services/messaging.service.js';

// Reference to global conductor service (initialized in webhooks.ts)
// We'll import the singleton instance
let getConductorService: (() => any) | null = null;

export function setConductorServiceGetter(getter: () => any) {
  getConductorService = getter;
}

// CLI Output Buffer - stores recent CLI messages for the feed
interface CLIMessage {
  timestamp: Date;
  source: 'conductor' | 'worker';
  sourceId: string;
  content: string;
  type: 'input' | 'output' | 'system';
}

const cliOutputBuffer: CLIMessage[] = [];
const MAX_BUFFER_SIZE = 500; // Keep last 500 messages

// WebSocket clients for real-time CLI feed broadcasting
const cliWebSocketClients = new Set<(message: CLIMessage) => void>();

export function addCLIOutput(message: CLIMessage) {
  cliOutputBuffer.push(message);
  if (cliOutputBuffer.length > MAX_BUFFER_SIZE) {
    cliOutputBuffer.shift(); // Remove oldest
  }

  // Broadcast to all connected WebSocket clients
  for (const broadcast of cliWebSocketClients) {
    try {
      broadcast(message);
    } catch (error) {
      // Client disconnected or error - will be cleaned up on 'close' event
    }
  }
}

// Worker Detail Messages - captures full CLI stream per worker
interface WorkerDetailMessage {
  timestamp: Date;
  workerId: string;
  sandboxId: string;
  messageType: 'init' | 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'result';
  content: any;
}

const workerDetailBuffers = new Map<string, WorkerDetailMessage[]>();
const workerWebSocketClients = new Map<string, Set<(message: WorkerDetailMessage) => void>>();
const MAX_WORKER_BUFFER_SIZE = 500; // 500 messages per worker
const WORKER_HISTORY_TTL = 15 * 60 * 1000; // Keep history for 15 minutes after worker killed

// Cleanup timers for killed workers
const workerCleanupTimers = new Map<string, NodeJS.Timeout>();

export function addWorkerDetailMessage(message: WorkerDetailMessage) {
  // Get or create buffer for this worker
  let buffer = workerDetailBuffers.get(message.workerId);
  if (!buffer) {
    buffer = [];
    workerDetailBuffers.set(message.workerId, buffer);
  }

  buffer.push(message);
  if (buffer.length > MAX_WORKER_BUFFER_SIZE) {
    buffer.shift(); // Remove oldest
  }

  // Broadcast to WebSocket clients subscribed to this worker
  const clients = workerWebSocketClients.get(message.workerId);
  if (clients) {
    for (const broadcast of clients) {
      try {
        broadcast(message);
      } catch (error) {
        // Client disconnected
      }
    }
  }
}

export function scheduleWorkerCleanup(workerId: string) {
  // Clear existing timer if any
  const existingTimer = workerCleanupTimers.get(workerId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Schedule cleanup in 15 minutes
  const timer = setTimeout(() => {
    console.log(`🧹 Cleaning up worker ${workerId} history (15min TTL expired)`);
    workerDetailBuffers.delete(workerId);
    workerWebSocketClients.delete(workerId);
    workerCleanupTimers.delete(workerId);
  }, WORKER_HISTORY_TTL);

  workerCleanupTimers.set(workerId, timer);
}

export function getWorkerDetailMessages(workerId: string): WorkerDetailMessage[] {
  return workerDetailBuffers.get(workerId) || [];
}

export async function monitoringRoutes(fastify: FastifyInstance) {

  /**
   * GET /api/monitoring/status
   * Overall system status
   */
  fastify.get('/api/monitoring/status', async (request, reply) => {
    try {
      const conductor = getConductorService?.();

      if (!conductor || !conductor.isInitialized()) {
        return reply.send({
          status: 'offline',
          conductor: null,
          workers: [],
          message: 'Conductor not initialized',
        });
      }

      const session = conductor.getConductorSession();
      const workers = conductor.getActiveWorkers();

      return reply.send({
        status: 'online',
        conductor: {
          sessionId: session?.id,
          sandboxId: session?.sandboxId,
          uptime: session?.createdAt ? Date.now() - session.createdAt.getTime() : 0,
          lastActivity: session?.lastActivityAt,
          activeWorkerCount: session?.activeWorkers?.length || 0,
        },
        workers: workers.map((w: any) => ({
          id: w.id,
          sandboxId: w.sandboxId,
          task: w.task?.substring(0, 100),
          status: w.status,
          createdAt: w.createdAt,
          lastActivity: w.lastActivityAt,
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      return reply.code(500).send({
        error: 'Failed to get status',
        message: error.message,
      });
    }
  });

  /**
   * GET /api/monitoring/metrics
   * System metrics and statistics
   */
  fastify.get('/api/monitoring/metrics', async (request, reply) => {
    try {
      const conductor = getConductorService?.();

      if (!conductor || !conductor.isInitialized()) {
        return reply.send({
          messages_processed: 0,
          workers_spawned: 0,
          workers_active: 0,
          total_conversations: 0,
          uptime_seconds: 0,
        });
      }

      const session = conductor.getConductorSession();
      const workers = conductor.getActiveWorkers();
      const uptime = session?.createdAt ? Math.floor((Date.now() - session.createdAt.getTime()) / 1000) : 0;

      return reply.send({
        messages_processed: 0, // TODO: Add counter
        workers_spawned: 0, // TODO: Add counter
        workers_active: workers.length,
        total_conversations: 0, // TODO: Add counter
        uptime_seconds: uptime,
        last_activity: session?.lastActivityAt,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      return reply.code(500).send({
        error: 'Failed to get metrics',
        message: error.message,
      });
    }
  });

  /**
   * GET /api/monitoring/workers
   * List all active workers with details
   */
  fastify.get('/api/monitoring/workers', async (request, reply) => {
    try {
      const conductor = getConductorService?.();

      if (!conductor || !conductor.isInitialized()) {
        return reply.send({ workers: [] });
      }

      const workers = conductor.getActiveWorkers();

      return reply.send({
        workers: workers.map((w: any) => ({
          id: w.id,
          sandboxId: w.sandboxId,
          conductorId: w.conductorId,
          task: w.task,
          status: w.status,
          createdAt: w.createdAt,
          lastActivityAt: w.lastActivityAt,
        })),
        count: workers.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      return reply.code(500).send({
        error: 'Failed to get workers',
        message: error.message,
      });
    }
  });

  /**
   * POST /api/monitoring/test
   * Send a test message to the conductor (for frontend testing)
   */
  fastify.post('/api/monitoring/test', async (request, reply) => {
    try {
      const { message } = request.body as { message: string };

      if (!message) {
        return reply.code(400).send({ error: 'message is required' });
      }

      const conductor = getConductorService?.();

      if (!conductor) {
        return reply.code(503).send({
          error: 'Conductor not available',
          message: 'Conductor service not initialized',
        });
      }

      const response = await conductor.sendToConductor({
        source: 'USER',
        content: message,
      });

      return reply.send({
        success: true,
        response: response.result,
        sessionId: response.session_id,
      });
    } catch (error: any) {
      return reply.code(500).send({
        error: 'Failed to send test message',
        message: error.message,
      });
    }
  });

  /**
   * GET /api/monitoring/health
   * Simple health check for monitoring services
   */
  fastify.get('/api/monitoring/health', async (request, reply) => {
    const conductor = getConductorService?.();
    const isHealthy = conductor && conductor.isInitialized();

    return reply.code(isHealthy ? 200 : 503).send({
      status: isHealthy ? 'healthy' : 'unhealthy',
      conductor: isHealthy ? 'online' : 'offline',
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /api/monitoring/connectors
   * Check messaging connectors configuration status
   */
  fastify.get('/api/monitoring/connectors', async (request, reply) => {
    const status = getMessagingStatus();
    return reply.send(status);
  });

  /**
   * GET /api/monitoring/cli-feed
   * Get recent CLI output from conductor and workers
   */
  fastify.get('/api/monitoring/cli-feed', async (request, reply) => {
    try {
      const { limit } = request.query as { limit?: string };
      const maxMessages = limit ? parseInt(limit) : 100;

      // Return most recent messages
      const messages = cliOutputBuffer.slice(-maxMessages);

      return reply.send({
        messages,
        count: messages.length,
        totalBuffered: cliOutputBuffer.length,
      });
    } catch (error: any) {
      return reply.code(500).send({
        error: 'Failed to get CLI feed',
        message: error.message,
      });
    }
  });

  /**
   * WebSocket /api/monitoring/cli-feed/stream
   * Real-time CLI output stream
   */
  fastify.get('/api/monitoring/cli-feed/stream', { websocket: true }, (socket, req) => {
    console.log('📡 CLI feed WebSocket client connected');

    // Send initial buffer
    socket.send(JSON.stringify({
      type: 'history',
      messages: cliOutputBuffer.slice(-50), // Last 50 messages
    }));

    // Store connection for broadcasting
    const broadcast = (message: CLIMessage) => {
      if (socket.readyState === 1) { // OPEN
        socket.send(JSON.stringify({
          type: 'message',
          data: message,
        }));
      }
    };

    // Add to global broadcasters
    cliWebSocketClients.add(broadcast);

    socket.on('close', () => {
      console.log('📡 CLI feed WebSocket client disconnected');
      cliWebSocketClients.delete(broadcast);
    });
  });

  /**
   * GET /api/monitoring/workers/:workerId/details
   * Get detailed CLI messages for a specific worker
   */
  fastify.get('/api/monitoring/workers/:workerId/details', async (request, reply) => {
    try {
      const { workerId } = request.params as { workerId: string };
      const { limit } = request.query as { limit?: string };
      const maxMessages = limit ? parseInt(limit) : 500;

      const messages = getWorkerDetailMessages(workerId);
      const sliced = messages.slice(-maxMessages);

      return reply.send({
        workerId,
        messages: sliced,
        count: sliced.length,
        totalBuffered: messages.length,
      });
    } catch (error: any) {
      return reply.code(500).send({
        error: 'Failed to get worker details',
        message: error.message,
      });
    }
  });

  /**
   * WebSocket /api/monitoring/workers/:workerId/stream
   * Real-time CLI output stream for a specific worker
   */
  fastify.get('/api/monitoring/workers/:workerId/stream', { websocket: true }, (socket, req) => {
    const workerId = (req.params as any).workerId;

    console.log(`📡 Worker ${workerId} detail WebSocket client connected`);

    // Send initial buffer
    const history = getWorkerDetailMessages(workerId);
    socket.send(JSON.stringify({
      type: 'history',
      messages: history.slice(-50), // Last 50 messages
    }));

    // Store connection for broadcasting
    const broadcast = (message: WorkerDetailMessage) => {
      if (socket.readyState === 1) { // OPEN
        socket.send(JSON.stringify({
          type: 'message',
          data: message,
        }));
      }
    };

    // Add to worker-specific broadcasters
    let clients = workerWebSocketClients.get(workerId);
    if (!clients) {
      clients = new Set();
      workerWebSocketClients.set(workerId, clients);
    }
    clients.add(broadcast);

    socket.on('close', () => {
      console.log(`📡 Worker ${workerId} detail WebSocket client disconnected`);
      const clients = workerWebSocketClients.get(workerId);
      if (clients) {
        clients.delete(broadcast);
        if (clients.size === 0) {
          workerWebSocketClients.delete(workerId);
        }
      }
    });
  });
}
