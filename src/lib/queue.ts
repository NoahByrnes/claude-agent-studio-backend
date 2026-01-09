import { Queue, Worker } from 'bullmq';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Parse Redis URL for BullMQ connection
function getRedisConnection() {
  return {
    connection: {
      url: redisUrl,
    },
  };
}

// Agent Events Queue
export const agentEventsQueue = new Queue('agent-events', getRedisConnection());

// Export function to create a worker (will be implemented in event-router service)
export function createAgentEventWorker(
  processor: (job: any) => Promise<void>
) {
  return new Worker('agent-events', processor, getRedisConnection());
}
