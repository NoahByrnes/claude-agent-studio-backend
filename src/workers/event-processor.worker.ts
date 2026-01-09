import { createAgentEventWorker } from '../lib/queue.js';
import { AgentService } from '../services/agent.service.js';
import { AgentExecutorService } from '../services/agent-executor.service.js';
import { EventRouterService } from '../services/event-router.service.js';

const agentService = new AgentService();
const executorService = new AgentExecutorService();
const eventRouterService = new EventRouterService();

export interface EventProcessorJobData {
  eventId: string;
  agentId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

// Create the worker
export const eventProcessorWorker = createAgentEventWorker(async (job) => {
  const data: EventProcessorJobData = job.data;

  console.log(`Processing event ${data.eventId} for agent ${data.agentId}`);

  try {
    // Get agent details
    // Note: We need to get the agent, but we don't have userId here
    // TODO: Store userId in the event data or fetch from agent
    const agent = await agentService.getById(data.agentId, data.agentId); // Temporary workaround

    if (!agent) {
      throw new Error(`Agent ${data.agentId} not found`);
    }

    // Check if agent should process this event type
    const config = agent.config as any;
    const deploymentType = config.deployment?.type;

    if (deploymentType !== 'event-driven') {
      console.log(`Agent ${data.agentId} is not event-driven, skipping`);
      return;
    }

    // Generate session ID for this event
    const sessionId = `${data.agentId}-${data.eventId}`;

    // Execute the agent
    const result = await executorService.execute({
      agent,
      sessionId,
      event: {
        type: data.eventType,
        payload: data.payload,
      },
    });

    if (!result.success) {
      throw new Error(result.error || 'Agent execution failed');
    }

    // Mark event as processed
    await eventRouterService.markEventProcessed(data.eventId);

    console.log(`Event ${data.eventId} processed successfully`);
    console.log(`Output: ${result.output}`);
    console.log(`Tools used: ${result.toolsUsed?.join(', ') || 'none'}`);
    console.log(`Turns: ${result.turnsCompleted}`);

  } catch (error: any) {
    console.error(`Error processing event ${data.eventId}:`, error);
    throw error; // Re-throw to trigger BullMQ retry logic
  }
});

// Handle worker errors
eventProcessorWorker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed with error:`, err);
});

eventProcessorWorker.on('completed', (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

eventProcessorWorker.on('error', (err) => {
  console.error('Worker error:', err);
});

console.log('Event processor worker started');
