/**
 * Template Configuration Service
 *
 * Manages E2B template IDs dynamically in Redis.
 * Allows workers to update template IDs autonomously after rebuilds.
 */

import { redis as redisClient } from '../lib/redis.js';

const REDIS_TEMPLATE_KEY = 'e2b:templates';

export interface TemplateConfig {
  conductor: string;
  worker: string;
  infrastructure: string;
  lastUpdated: string;
  updatedBy: string; // 'manual' | 'worker' | 'infrastructure-worker'
}

/**
 * Get current template configuration
 * Priority: Redis > Environment Variables (fallback)
 */
export async function getTemplateConfig(): Promise<TemplateConfig> {
  // Try Redis
  if (redisClient) {
    try {
      const cached = await redisClient.get(REDIS_TEMPLATE_KEY);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error: any) {
      console.warn('⚠️  Redis template config read failed:', error.message);
    }
  }

  // Fallback to environment variables (and cache in Redis for next time)
  console.log('ℹ️  Using environment variable fallback for template config');
  const config: TemplateConfig = {
    conductor: process.env.E2B_CONDUCTOR_TEMPLATE_ID || '',
    worker: process.env.E2B_TEMPLATE_ID || '',
    infrastructure: process.env.E2B_INFRASTRUCTURE_TEMPLATE_ID || '',
    lastUpdated: new Date().toISOString(),
    updatedBy: 'manual',
  };

  // Cache in Redis
  if (redisClient) {
    try {
      await redisClient.setex(REDIS_TEMPLATE_KEY, 86400, JSON.stringify(config)); // 24 hour TTL
    } catch (error: any) {
      console.warn('⚠️  Failed to cache config in Redis:', error.message);
    }
  }

  return config;
}

/**
 * Update template configuration
 * Stores in Redis (persistent with 24h TTL)
 */
export async function updateTemplateConfig(
  updates: Partial<Omit<TemplateConfig, 'lastUpdated'>>,
  updatedBy: string = 'manual'
): Promise<TemplateConfig> {
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

  // Update Redis (24 hour TTL)
  if (!redisClient) {
    throw new Error('Redis not available - cannot update template config');
  }

  try {
    await redisClient.setex(REDIS_TEMPLATE_KEY, 86400, JSON.stringify(newConfig)); // 24 hour TTL
    console.log('✅ Template config saved to Redis:', {
      conductor: newConfig.conductor,
      worker: newConfig.worker,
      infrastructure: newConfig.infrastructure,
      updatedBy: newConfig.updatedBy,
    });
  } catch (error: any) {
    console.error('❌ Failed to save template config to Redis:', error.message);
    throw error;
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
 * Initialize template config in Redis from environment variables
 */
export async function initializeTemplateConfig(): Promise<void> {
  if (!redisClient) {
    console.log('ℹ️  Redis not available, template config will use environment variables only');
    return;
  }

  try {
    // Check if config already exists in Redis
    const existing = await redisClient.get(REDIS_TEMPLATE_KEY);
    if (existing) {
      console.log('✅ Template config already exists in Redis');
      return;
    }

    // Initialize from environment variables
    const initialConfig: TemplateConfig = {
      conductor: process.env.E2B_CONDUCTOR_TEMPLATE_ID || '',
      worker: process.env.E2B_TEMPLATE_ID || '',
      infrastructure: process.env.E2B_INFRASTRUCTURE_TEMPLATE_ID || '',
      lastUpdated: new Date().toISOString(),
      updatedBy: 'manual',
    };

    await redisClient.setex(REDIS_TEMPLATE_KEY, 86400, JSON.stringify(initialConfig)); // 24 hour TTL
    console.log('✅ Template config initialized in Redis from environment variables');
  } catch (error: any) {
    console.warn('⚠️  Failed to initialize template config in Redis:', error.message);
  }
}
