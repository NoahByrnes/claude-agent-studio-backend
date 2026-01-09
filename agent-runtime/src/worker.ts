import { Worker, Job } from 'bullmq';
import { AgentRuntime } from './index.js';
import type { AgentConfig } from './shared-types/index.js';
import dotenv from 'dotenv';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Store agent runtime instances
const agentRuntimes = new Map<string, AgentRuntime>();

async function getOrCreateAgentRuntime(agentId: string): Promise<AgentRuntime> {
  if (agentRuntimes.has(agentId)) {
    return agentRuntimes.get(agentId)!;
  }

  // Fetch agent config from backend
  const response = await fetch(`${BACKEND_URL}/api/agents/${agentId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch agent ${agentId}: ${response.statusText}`);
  }

  const agent = (await response.json()) as { config: AgentConfig };
  const config = agent.config;

  const runtime = new AgentRuntime({
    config,
    apiKey: ANTHROPIC_API_KEY,
    backendUrl: BACKEND_URL,
    agentId,
  });

  agentRuntimes.set(agentId, runtime);
  return runtime;
}

// Create worker
const worker = new Worker(
  'agent-events',
  async (job: Job) => {
    console.log(`📥 Processing job ${job.id}:`, job.data);

    const { agentId, eventId, eventType, payload } = job.data;

    try {
      // Get or create agent runtime
      const runtime = await getOrCreateAgentRuntime(agentId);

      // Process the event
      await runtime.processEvent({
        eventId,
        eventType,
        payload,
      });

      // Mark event as processed in backend
      await fetch(`${BACKEND_URL}/api/events/${eventId}/processed`, {
        method: 'POST',
      });

      console.log(`✅ Job ${job.id} completed successfully`);
    } catch (error) {
      console.error(`❌ Job ${job.id} failed:`, error);
      throw error;
    }
  },
  {
    connection: {
      url: REDIS_URL,
    },
    concurrency: 5, // Process up to 5 jobs in parallel
    removeOnComplete: { count: 100 }, // Keep last 100 completed jobs
    removeOnFail: { count: 500 }, // Keep last 500 failed jobs
  }
);

worker.on('ready', () => {
  console.log('🚀 Agent worker is ready and waiting for jobs');
});

worker.on('active', (job) => {
  console.log(`⚙️  Processing job ${job.id}`);
});

worker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down worker gracefully...');
  await worker.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down worker gracefully...');
  await worker.close();
  process.exit(0);
});
