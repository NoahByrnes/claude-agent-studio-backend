/**
 * Template Configuration Service
 *
 * Manages E2B template IDs dynamically in Redis/PostgreSQL.
 * Allows workers to update template IDs autonomously after rebuilds.
 */

import { redis as redisClient } from '../lib/redis.js';
import postgres from 'postgres';

const REDIS_TEMPLATE_KEY = 'e2b:templates';

// Create postgres client for raw SQL queries
const connectionString = process.env.DATABASE_URL || '';
let sql: ReturnType<typeof postgres> | null = null;

if (process.env.DATABASE_URL) {
  try {
    sql = postgres(process.env.DATABASE_URL, {
      ssl: 'require',
      connect_timeout: 10,
      prepare: false,
    });
  } catch (error: any) {
    console.warn('⚠️  Failed to connect to PostgreSQL:', error.message);
  }
}

// Use a more compatible variable name
const sqlClient = sql;

export interface TemplateConfig {
  conductor: string;
  worker: string;
  infrastructure: string;
  lastUpdated: string;
  updatedBy: string; // 'manual' | 'worker' | 'infrastructure-worker'
}

/**
 * Get current template configuration
 * Priority: Redis > PostgreSQL > Environment Variables (fallback)
 */
export async function getTemplateConfig(): Promise<TemplateConfig> {
  // Try Redis first (fast cache)
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

  // Try PostgreSQL
  if (sqlClient) {
    try {
      const result = await sqlClient`
        SELECT config FROM template_config WHERE id = 'default'
      `;

      if (result.length > 0) {
        const config = result[0].config as TemplateConfig;

        // Cache in Redis for next time
        if (redisClient) {
          await redisClient.setex(REDIS_TEMPLATE_KEY, 3600, JSON.stringify(config));
        }

        return config;
      }
    } catch (error: any) {
      console.warn('⚠️  PostgreSQL template config read failed:', error.message);
    }
  }

  // Fallback to environment variables
  console.log('ℹ️  Using environment variable fallback for template config');
  return {
    conductor: process.env.E2B_CONDUCTOR_TEMPLATE_ID || '',
    worker: process.env.E2B_TEMPLATE_ID || '',
    infrastructure: process.env.E2B_INFRASTRUCTURE_TEMPLATE_ID || '',
    lastUpdated: new Date().toISOString(),
    updatedBy: 'manual',
  };
}

/**
 * Update template configuration
 * Stores in both Redis (cache) and PostgreSQL (persistent)
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

  // Validate template IDs (must start with e2b_ or be empty)
  for (const [key, value] of Object.entries(newConfig)) {
    if (key !== 'lastUpdated' && key !== 'updatedBy' && value) {
      if (!value.match(/^[a-z0-9_]+$/i)) {
        throw new Error(`Invalid template ID format for ${key}: ${value}`);
      }
    }
  }

  // Update PostgreSQL (persistent storage)
  if (sqlClient) {
    try {
      const configJson = JSON.stringify(newConfig);
      await sqlClient`
        INSERT INTO template_config (id, config, updated_at)
        VALUES ('default', ${configJson}::jsonb, NOW())
        ON CONFLICT (id)
        DO UPDATE SET config = ${configJson}::jsonb, updated_at = NOW()
      `;
      console.log('✅ Template config saved to PostgreSQL');
    } catch (error: any) {
      console.error('❌ Failed to save template config to PostgreSQL:', error.message);
      throw error;
    }
  }

  // Update Redis (fast cache)
  if (redisClient) {
    try {
      await redisClient.setex(REDIS_TEMPLATE_KEY, 3600, JSON.stringify(newConfig));
      console.log('✅ Template config cached in Redis');
    } catch (error: any) {
      console.warn('⚠️  Failed to cache template config in Redis:', error.message);
    }
  }

  console.log('✅ Template config updated:', {
    conductor: newConfig.conductor,
    worker: newConfig.worker,
    infrastructure: newConfig.infrastructure,
    updatedBy: newConfig.updatedBy,
  });

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
 * Initialize template config table in PostgreSQL
 */
export async function initializeTemplateConfigTable(): Promise<void> {
  if (!sqlClient) {
    console.log('ℹ️  PostgreSQL not available, skipping template_config table initialization');
    return;
  }

  try {
    await sqlClient`
      CREATE TABLE IF NOT EXISTS template_config (
        id TEXT PRIMARY KEY,
        config JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('✅ template_config table initialized');

    // Initialize with current env vars if no config exists
    const result = await sqlClient`
      SELECT id FROM template_config WHERE id = 'default'
    `;

    if (result.length === 0) {
      const initialConfig: TemplateConfig = {
        conductor: process.env.E2B_CONDUCTOR_TEMPLATE_ID || '',
        worker: process.env.E2B_TEMPLATE_ID || '',
        infrastructure: process.env.E2B_INFRASTRUCTURE_TEMPLATE_ID || '',
        lastUpdated: new Date().toISOString(),
        updatedBy: 'manual',
      };

      const configJson = JSON.stringify(initialConfig);
      await sqlClient`
        INSERT INTO template_config (id, config)
        VALUES ('default', ${configJson}::jsonb)
      `;
      console.log('✅ Template config initialized with environment variables');
    }
  } catch (error: any) {
    console.error('❌ Failed to initialize template_config table:', error.message);
  }
}
