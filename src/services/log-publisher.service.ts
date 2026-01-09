import { Redis } from 'ioredis';
import type { AuditLog } from '../../db/schema.js';

export class LogPublisherService {
  private redis: Redis;
  private static instance: LogPublisherService;

  private constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redis = new Redis(redisUrl);

    this.redis.on('error', (err) => {
      console.error('Redis publisher error:', err);
    });

    this.redis.on('connect', () => {
      console.log('✅ Redis publisher connected');
    });
  }

  static getInstance(): LogPublisherService {
    if (!LogPublisherService.instance) {
      LogPublisherService.instance = new LogPublisherService();
    }
    return LogPublisherService.instance;
  }

  async publishLog(log: AuditLog): Promise<void> {
    try {
      const channel = `agent:${log.agent_id}:logs`;
      await this.redis.publish(channel, JSON.stringify(log));
    } catch (error) {
      console.error('Error publishing log:', error);
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
