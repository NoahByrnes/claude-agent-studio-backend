import { Queue, Worker } from 'bullmq';

const redisUrl = process.env.REDIS_URL;

// Parse Redis URL for BullMQ connection
function getRedisConnection() {
  if (!redisUrl) {
    throw new Error('Redis not configured - queues unavailable');
  }
  return {
    connection: {
      url: redisUrl,
    },
  };
}

// Agent Events Queue (nullable)
export let agentEventsQueue: Queue | null = null;

if (redisUrl) {
  agentEventsQueue = new Queue('agent-events', getRedisConnection());
} else {
  console.warn('⚠️  Redis not configured - agent events queue disabled');
}

// Export function to create a worker (will be implemented in event-router service)
export function createAgentEventWorker(
  processor: (job: any) => Promise<void>
) {
  if (!redisUrl) {
    throw new Error('Redis not configured - cannot create workers');
  }
  return new Worker('agent-events', processor, getRedisConnection());
}
