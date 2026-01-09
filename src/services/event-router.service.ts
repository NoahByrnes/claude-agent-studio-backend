import { agentEventsQueue } from '../lib/queue.js';
import { db } from '../lib/db.js';
import { agentEvents, type NewAgentEvent } from '../../db/schema.js';

export interface IncomingEvent {
  agentId: string;
  eventType: 'email' | 'sms' | 'webhook' | 'scheduled';
  payload: Record<string, unknown>;
}

export class EventRouterService {
  async routeEvent(event: IncomingEvent): Promise<void> {
    // Save event to database
    const newEvent: NewAgentEvent = {
      agent_id: event.agentId,
      event_type: event.eventType,
      payload: event.payload as any,
    };

    const [savedEvent] = await db.insert(agentEvents).values(newEvent).returning();

    // Add to queue for processing
    await agentEventsQueue.add('process-event', {
      eventId: savedEvent.id,
      agentId: event.agentId,
      eventType: event.eventType,
      payload: event.payload,
    });
  }

  async markEventProcessed(eventId: string): Promise<void> {
    await db
      .update(agentEvents)
      .set({ processed: new Date() })
      .where({ id: eventId } as any);
  }
}
