import { eq } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { sessions, type NewSession, type Session } from '../../db/schema.js';

export class SessionService {
  private getRedisKey(agentId: string): string {
    return `session:${agentId}`;
  }

  async saveSession(agentId: string, sessionId: string, state: Record<string, unknown>): Promise<Session> {
    // Save to Redis for fast access (if available)
    if (redis) {
      await redis.set(this.getRedisKey(agentId), JSON.stringify({ sessionId, state }), 'EX', 3600);
    }

    // Also save to database for persistence
    const [existing] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.agent_id, agentId));

    if (existing) {
      const [updated] = await db
        .update(sessions)
        .set({
          session_id: sessionId,
          state: state as any,
          last_active: new Date(),
        })
        .where(eq(sessions.agent_id, agentId))
        .returning();
      return updated;
    } else {
      const newSession: NewSession = {
        agent_id: agentId,
        session_id: sessionId,
        state: state as any,
      };
      const [created] = await db.insert(sessions).values(newSession).returning();
      return created;
    }
  }

  async getSession(agentId: string): Promise<{ sessionId: string; state: Record<string, unknown> } | null> {
    // Try Redis first (if available)
    if (redis) {
      const cached = await redis.get(this.getRedisKey(agentId));
      if (cached) {
        return JSON.parse(cached);
      }
    }

    // Fallback to database
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.agent_id, agentId));

    if (session) {
      const result = {
        sessionId: session.session_id,
        state: session.state as Record<string, unknown>,
      };

      // Warm up Redis cache (if available)
      if (redis) {
        await redis.set(this.getRedisKey(agentId), JSON.stringify(result), 'EX', 3600);
      }

      return result;
    }

    return null;
  }

  async deleteSession(agentId: string): Promise<void> {
    if (redis) {
      await redis.del(this.getRedisKey(agentId));
    }
    await db.delete(sessions).where(eq(sessions.agent_id, agentId));
  }
}
