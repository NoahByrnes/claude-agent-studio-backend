import { eq, desc, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { auditLogs, type NewAuditLog, type AuditLog } from '../../db/schema.js';
import { LogPublisherService } from './log-publisher.service.js';

export class AuditService {
  private logPublisher: LogPublisherService;

  constructor() {
    this.logPublisher = LogPublisherService.getInstance();
  }

  async log(data: Omit<NewAuditLog, 'id' | 'timestamp'>): Promise<AuditLog> {
    const [log] = await db.insert(auditLogs).values(data).returning();

    // Publish log for real-time streaming
    await this.logPublisher.publishLog(log);

    return log;
  }

  async getLogsForAgent(
    agentId: string,
    options: {
      limit?: number;
      offset?: number;
      actionType?: string;
      toolName?: string;
    } = {}
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const { limit = 100, offset = 0, actionType, toolName } = options;

    const conditions = [eq(auditLogs.agent_id, agentId)];

    if (actionType) {
      conditions.push(eq(auditLogs.action_type, actionType));
    }

    if (toolName) {
      conditions.push(eq(auditLogs.tool_name, toolName));
    }

    const logs = await db
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.timestamp))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select()
      .from(auditLogs)
      .where(and(...conditions));

    return {
      logs,
      total: countResult.length,
    };
  }

  async getRecentLogs(agentId: string, limit: number = 50): Promise<AuditLog[]> {
    return db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.agent_id, agentId))
      .orderBy(desc(auditLogs.timestamp))
      .limit(limit);
  }
}
