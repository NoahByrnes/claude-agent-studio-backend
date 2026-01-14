/**
 * Conductor State Persistence Service
 *
 * Manages conductor session state with PostgreSQL as primary storage and Redis as cache.
 * Allows reconnecting to existing E2B sandboxes after backend restarts.
 */

import { redis as redisClient } from '../lib/redis.js';
import { db } from '../lib/db.js';
import { conductorSessions, type ConductorSession, type NewConductorSession } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { Sandbox } from 'e2b';

const REDIS_STATE_KEY = 'conductor:state';
const REDIS_CACHE_TTL = 3600; // 1 hour (match E2B sandbox lifetime)

export interface ConductorState {
  sandboxId: string;
  sessionId: string;
  createdAt: string;
  lastActivityAt: string;
}

/**
 * Save conductor state to PostgreSQL (primary) and Redis (cache)
 */
export async function saveConductorState(state: ConductorState): Promise<void> {
  const conductorId = 'default'; // Using 'default' as the primary conductor

  try {
    // Calculate expiration (1 hour from now)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // Save to PostgreSQL (primary storage)
    const existing = await db.select()
      .from(conductorSessions)
      .where(eq(conductorSessions.conductor_id, conductorId))
      .limit(1);

    if (existing.length > 0) {
      // Update existing
      await db.update(conductorSessions)
        .set({
          sandbox_id: state.sandboxId,
          session_id: state.sessionId,
          last_activity_at: new Date(state.lastActivityAt),
          expires_at: expiresAt,
        })
        .where(eq(conductorSessions.conductor_id, conductorId));
    } else {
      // Insert new
      await db.insert(conductorSessions).values({
        conductor_id: conductorId,
        sandbox_id: state.sandboxId,
        session_id: state.sessionId,
        created_at: new Date(state.createdAt),
        last_activity_at: new Date(state.lastActivityAt),
        expires_at: expiresAt,
      });
    }

    console.log(`✅ Conductor state saved to PostgreSQL (sandbox: ${state.sandboxId.substring(0, 12)}...)`);

    // Cache in Redis for fast access
    if (redisClient) {
      try {
        await redisClient.setex(
          REDIS_STATE_KEY,
          REDIS_CACHE_TTL,
          JSON.stringify(state)
        );
        console.log(`   Cached in Redis (${REDIS_CACHE_TTL}s TTL)`);
      } catch (redisError: any) {
        console.warn('⚠️  Failed to cache in Redis (non-critical):', redisError.message);
      }
    }
  } catch (error: any) {
    console.error('❌ Failed to save conductor state:', error.message);
    throw error;
  }
}

/**
 * Load conductor state from PostgreSQL (checks Redis cache first for speed)
 */
export async function loadConductorState(): Promise<ConductorState | null> {
  const conductorId = 'default';

  // Try Redis cache first (fast path)
  if (redisClient) {
    try {
      const cached = await redisClient.get(REDIS_STATE_KEY);
      if (cached) {
        const state = JSON.parse(cached) as ConductorState;
        console.log(`📥 Loaded conductor state from Redis cache (sandbox: ${state.sandboxId.substring(0, 12)}...)`);
        return state;
      }
    } catch (error: any) {
      console.warn('⚠️  Redis cache read failed:', error.message);
    }
  }

  // Load from PostgreSQL (primary storage)
  try {
    const result = await db.select()
      .from(conductorSessions)
      .where(eq(conductorSessions.conductor_id, conductorId))
      .limit(1);

    if (result.length === 0) {
      console.log('ℹ️  No existing conductor state in PostgreSQL');
      return null;
    }

    const session = result[0];

    // Check if expired (E2B sandboxes die after 1 hour)
    if (new Date(session.expires_at) < new Date()) {
      console.log('⚠️  Conductor state expired, cleaning up');
      await clearConductorState();
      return null;
    }

    const state: ConductorState = {
      sandboxId: session.sandbox_id,
      sessionId: session.session_id,
      createdAt: session.created_at.toISOString(),
      lastActivityAt: session.last_activity_at.toISOString(),
    };

    console.log(`📥 Loaded conductor state from PostgreSQL (sandbox: ${state.sandboxId.substring(0, 12)}...)`);

    // Cache in Redis for future fast access
    if (redisClient) {
      try {
        await redisClient.setex(REDIS_STATE_KEY, REDIS_CACHE_TTL, JSON.stringify(state));
      } catch (error: any) {
        console.warn('⚠️  Failed to cache in Redis (non-critical):', error.message);
      }
    }

    return state;
  } catch (error: any) {
    console.error('❌ Failed to load conductor state from PostgreSQL:', error.message);
    return null;
  }
}

/**
 * Clear conductor state from both PostgreSQL and Redis
 */
export async function clearConductorState(): Promise<void> {
  const conductorId = 'default';

  // Clear from PostgreSQL
  try {
    await db.delete(conductorSessions)
      .where(eq(conductorSessions.conductor_id, conductorId));
    console.log('✅ Conductor state cleared from PostgreSQL');
  } catch (error: any) {
    console.error('❌ Failed to clear conductor state from PostgreSQL:', error.message);
  }

  // Clear from Redis cache
  if (redisClient) {
    try {
      await redisClient.del(REDIS_STATE_KEY);
      console.log('   Cleared from Redis cache');
    } catch (error: any) {
      console.warn('⚠️  Failed to clear from Redis cache (non-critical):', error.message);
    }
  }
}

/**
 * Update last activity timestamp
 */
export async function updateConductorActivity(): Promise<void> {
  const conductorId = 'default';

  try {
    const now = new Date();

    // Update PostgreSQL
    await db.update(conductorSessions)
      .set({ last_activity_at: now })
      .where(eq(conductorSessions.conductor_id, conductorId));

    // Update Redis cache if exists
    if (redisClient) {
      try {
        const cached = await redisClient.get(REDIS_STATE_KEY);
        if (cached) {
          const state = JSON.parse(cached) as ConductorState;
          state.lastActivityAt = now.toISOString();
          await redisClient.setex(REDIS_STATE_KEY, REDIS_CACHE_TTL, JSON.stringify(state));
        }
      } catch (error: any) {
        console.warn('⚠️  Failed to update Redis cache (non-critical):', error.message);
      }
    }
  } catch (error: any) {
    console.error('❌ Failed to update conductor activity:', error.message);
  }
}

/**
 * Try to reconnect to existing conductor sandbox
 * Returns the sandbox if successful, null if failed
 */
export async function reconnectToConductor(
  sandboxId: string,
  apiKey: string
): Promise<Sandbox | null> {
  try {
    console.log(`🔌 Attempting to reconnect to conductor sandbox: ${sandboxId}...`);

    // Try to connect to the existing sandbox
    const sandbox = await Sandbox.connect(sandboxId, {
      apiKey,
      requestTimeoutMs: 30000, // 30 seconds timeout
    });

    // Verify the sandbox is responsive
    const result = await sandbox.commands.run('echo "alive"', { timeoutMs: 5000 });
    if (result.exitCode === 0) {
      console.log(`✅ Successfully reconnected to conductor sandbox: ${sandboxId}`);
      return sandbox;
    } else {
      console.log(`⚠️  Conductor sandbox unresponsive, creating new one`);
      return null;
    }
  } catch (error: any) {
    console.log(`⚠️  Failed to reconnect to conductor: ${error.message}`);
    console.log(`   Creating new conductor instead`);
    return null;
  }
}
