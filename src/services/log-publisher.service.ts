import { Redis } from 'ioredis';
import type { AuditLog } from '../../db/schema.js';

export class LogPublisherService {
  private redis: Redis | null = null;
  private static instance: LogPublisherService;
  private enabled: boolean = false;

  private constructor() {
    const redisUrl = process.env.REDIS_URL;

    if (redisUrl) {
      this.redis = new Redis(redisUrl);
      this.enabled = true;

      this.redis.on('error', (err) => {
        console.error('Redis publisher error:', err);
      });

      this.redis.on('connect', () => {
        console.log('✅ Redis publisher connected');
      });
    } else {
      console.warn('⚠️  Redis not configured - log publishing disabled');
    }
  }

  static getInstance(): LogPublisherService {
    if (!LogPublisherService.instance) {
      LogPublisherService.instance = new LogPublisherService();
    }
    return LogPublisherService.instance;
  }

  async publishLog(log: AuditLog): Promise<void> {
    if (!this.enabled || !this.redis) {
      return; // Silently skip if Redis not configured
    }

    try {
      const channel = `agent:${log.agent_id}:logs`;
      await this.redis.publish(channel, JSON.stringify(log));
    } catch (error) {
      console.error('Error publishing log:', error);
    }
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}
