import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { agents, type NewAgent, type Agent } from '../../db/schema.js';
import type { AgentConfig, AgentStatus } from '../shared-types/index.js';

export class AgentService {
  async create(config: AgentConfig, userId: string): Promise<Agent> {
    const newAgent: NewAgent = {
      user_id: userId,
      name: config.name,
      status: 'idle',
      config: config as any,
    };

    const [agent] = await db.insert(agents).values(newAgent).returning();
    return agent;
  }

  async getAll(userId: string): Promise<Agent[]> {
    return db.select().from(agents).where(eq(agents.user_id, userId));
  }

  async getById(id: string, userId: string): Promise<Agent | undefined> {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.user_id, userId)));
    return agent;
  }

  async update(id: string, userId: string, config: Partial<AgentConfig>): Promise<Agent | undefined> {
    const existingAgent = await this.getById(id, userId);
    if (!existingAgent) {
      return undefined;
    }

    const updatedConfig = {
      ...(existingAgent.config as AgentConfig),
      ...config,
    };

    const [updated] = await db
      .update(agents)
      .set({
        config: updatedConfig as any,
        updated_at: new Date(),
      })
      .where(and(eq(agents.id, id), eq(agents.user_id, userId)))
      .returning();

    return updated;
  }

  async updateStatus(id: string, userId: string, status: AgentStatus): Promise<Agent | undefined> {
    const [updated] = await db
      .update(agents)
      .set({ status: status as any, updated_at: new Date() })
      .where(and(eq(agents.id, id), eq(agents.user_id, userId)))
      .returning();

    return updated;
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const result = await db.delete(agents).where(and(eq(agents.id, id), eq(agents.user_id, userId)));
    return result.count > 0;
  }
}
