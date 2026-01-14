/**
 * Template Configuration Service
 *
 * Manages E2B template IDs with PostgreSQL as primary storage and Redis as cache.
 * Allows workers to update template IDs autonomously after rebuilds.
 */

import { redis as redisClient } from '../lib/redis.js';
import { db } from '../lib/db.js';
import { templateConfigurations, type TemplateConfiguration, type NewTemplateConfiguration } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

const REDIS_TEMPLATE_KEY = 'e2b:templates';
const REDIS_CACHE_TTL = 86400; // 24 hours

export interface TemplateConfig {
  conductor: string;
  worker: string;
  infrastructure: string;
  lastUpdated: string;
  updatedBy: string; // 'manual' | 'worker' | 'infrastructure-worker'
}

/**
 * Get current template configuration
 * Checks Redis cache first, then PostgreSQL, falls back to environment variables
 */
export async function getTemplateConfig(): Promise<TemplateConfig> {
  const configKey = 'default';

  // Try Redis cache first (fast path)
  if (redisClient) {
    try {
      const cached = await redisClient.get(REDIS_TEMPLATE_KEY);
      if (cached) {
        const config = JSON.parse(cached) as TemplateConfig;
        console.log('📥 Loaded template config from Redis cache');
        return config;
      }
    } catch (error: any) {
      console.warn('⚠️  Redis cache read failed:', error.message);
    }
  }

  // Try PostgreSQL (primary storage)
  try {
    const result = await db.select()
      .from(templateConfigurations)
      .where(eq(templateConfigurations.config_key, configKey))
      .limit(1);

    if (result.length > 0) {
      const dbConfig = result[0];
      const config: TemplateConfig = {
        conductor: dbConfig.conductor_template,
        worker: dbConfig.worker_template,
        infrastructure: dbConfig.infrastructure_template,
        lastUpdated: dbConfig.updated_at.toISOString(),
        updatedBy: dbConfig.updated_by,
      };

      console.log('📥 Loaded template config from PostgreSQL');

      // Cache in Redis for future fast access
      if (redisClient) {
        try {
          await redisClient.setex(REDIS_TEMPLATE_KEY, REDIS_CACHE_TTL, JSON.stringify(config));
        } catch (error: any) {
          console.warn('⚠️  Failed to cache in Redis (non-critical):', error.message);
        }
      }

      return config;
    }
  } catch (error: any) {
    console.error('❌ PostgreSQL read failed:', error.message);
  }

  // Fallback to environment variables and initialize in database
  console.log('ℹ️  Using environment variable fallback for template config');
  const config: TemplateConfig = {
    conductor: process.env.E2B_CONDUCTOR_TEMPLATE_ID || '',
    worker: process.env.E2B_TEMPLATE_ID || '',
    infrastructure: process.env.E2B_INFRASTRUCTURE_TEMPLATE_ID || '',
    lastUpdated: new Date().toISOString(),
    updatedBy: 'manual',
  };

  // Try to save to database for next time
  try {
    await db.insert(templateConfigurations).values({
      config_key: configKey,
      conductor_template: config.conductor,
      worker_template: config.worker,
      infrastructure_template: config.infrastructure,
      updated_by: config.updatedBy,
    });
    console.log('✅ Initialized template config in PostgreSQL from environment variables');
  } catch (error: any) {
    console.warn('⚠️  Failed to initialize in PostgreSQL:', error.message);
  }

  // Cache in Redis
  if (redisClient) {
    try {
      await redisClient.setex(REDIS_TEMPLATE_KEY, REDIS_CACHE_TTL, JSON.stringify(config));
    } catch (error: any) {
      console.warn('⚠️  Failed to cache in Redis (non-critical):', error.message);
    }
  }

  return config;
}

/**
 * Update template configuration
 * Stores in PostgreSQL (primary) and Redis (cache)
 */
export async function updateTemplateConfig(
  updates: Partial<Omit<TemplateConfig, 'lastUpdated'>>,
  updatedBy: string = 'manual'
): Promise<TemplateConfig> {
  const configKey = 'default';

  // Get current config
  const current = await getTemplateConfig();

  // Merge updates
  const newConfig: TemplateConfig = {
    ...current,
    ...updates,
    lastUpdated: new Date().toISOString(),
    updatedBy,
  };

  // Validate template IDs (must be alphanumeric with underscores or empty)
  for (const [key, value] of Object.entries(newConfig)) {
    if (key !== 'lastUpdated' && key !== 'updatedBy' && value) {
      if (!value.match(/^[a-z0-9_]+$/i)) {
        throw new Error(`Invalid template ID format for ${key}: ${value}`);
      }
    }
  }

  // Update PostgreSQL (primary storage)
  try {
    const existing = await db.select()
      .from(templateConfigurations)
      .where(eq(templateConfigurations.config_key, configKey))
      .limit(1);

    if (existing.length > 0) {
      // Update existing
      await db.update(templateConfigurations)
        .set({
          conductor_template: newConfig.conductor,
          worker_template: newConfig.worker,
          infrastructure_template: newConfig.infrastructure,
          updated_by: newConfig.updatedBy,
          updated_at: new Date(),
        })
        .where(eq(templateConfigurations.config_key, configKey));
    } else {
      // Insert new
      await db.insert(templateConfigurations).values({
        config_key: configKey,
        conductor_template: newConfig.conductor,
        worker_template: newConfig.worker,
        infrastructure_template: newConfig.infrastructure,
        updated_by: newConfig.updatedBy,
      });
    }

    console.log('✅ Template config saved to PostgreSQL:', {
      conductor: newConfig.conductor,
      worker: newConfig.worker,
      infrastructure: newConfig.infrastructure,
      updatedBy: newConfig.updatedBy,
    });
  } catch (error: any) {
    console.error('❌ Failed to save template config to PostgreSQL:', error.message);
    throw error;
  }

  // Update Redis cache
  if (redisClient) {
    try {
      await redisClient.setex(REDIS_TEMPLATE_KEY, REDIS_CACHE_TTL, JSON.stringify(newConfig));
      console.log('   Cached in Redis (24h TTL)');
    } catch (error: any) {
      console.warn('⚠️  Failed to cache in Redis (non-critical):', error.message);
    }
  }

  return newConfig;
}

/**
 * Update a specific template ID
 */
export async function updateTemplateId(
  type: 'conductor' | 'worker' | 'infrastructure',
  templateId: string,
  updatedBy: string = 'manual'
): Promise<TemplateConfig> {
  console.log(`📝 Updating ${type} template ID to: ${templateId}`);

  return await updateTemplateConfig(
    { [type]: templateId },
    updatedBy
  );
}

/**
 * Get template ID for a specific type
 */
export async function getTemplateId(
  type: 'conductor' | 'worker' | 'infrastructure'
): Promise<string> {
  const config = await getTemplateConfig();
  return config[type];
}

/**
 * Initialize template config in database from environment variables
 * (Called on startup if not exists)
 */
export async function initializeTemplateConfig(): Promise<void> {
  try {
    // Try to get existing config (will initialize if not exists)
    await getTemplateConfig();
    console.log('✅ Template configuration initialized');
  } catch (error: any) {
    console.warn('⚠️  Failed to initialize template config:', error.message);
  }
}
