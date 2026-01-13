/**
 * Conductor State Persistence Service
 *
 * Manages conductor session state in Redis for persistence across deployments.
 * Allows reconnecting to existing E2B sandboxes after backend restarts.
 */

import { redis as redisClient } from '../lib/redis.js';
import { Sandbox } from 'e2b';

const REDIS_STATE_KEY = 'conductor:state';
const CONDUCTOR_TTL = 60 * 60; // 1 hour (match E2B sandbox lifetime)

export interface ConductorState {
  sandboxId: string;
  sessionId: string;
  createdAt: string;
  lastActivityAt: string;
}

/**
 * Save conductor state to Redis
 */
export async function saveConductorState(state: ConductorState): Promise<void> {
  if (!redisClient) {
    console.warn('⚠️  Redis not available, conductor state will not persist across deployments');
    return;
  }

  try {
    await redisClient.setex(
      REDIS_STATE_KEY,
      CONDUCTOR_TTL,
      JSON.stringify(state)
    );
    console.log(`✅ Conductor state saved to Redis (expires in ${CONDUCTOR_TTL}s)`);
  } catch (error: any) {
    console.error('❌ Failed to save conductor state:', error.message);
  }
}

/**
 * Load conductor state from Redis
 */
export async function loadConductorState(): Promise<ConductorState | null> {
  if (!redisClient) {
    return null;
  }

  try {
    const data = await redisClient.get(REDIS_STATE_KEY);
    if (!data) {
      console.log('ℹ️  No existing conductor state in Redis');
      return null;
    }

    const state = JSON.parse(data) as ConductorState;
    console.log(`📥 Found conductor state in Redis (sandbox: ${state.sandboxId.substring(0, 12)}...)`);
    return state;
  } catch (error: any) {
    console.error('❌ Failed to load conductor state:', error.message);
    return null;
  }
}

/**
 * Clear conductor state from Redis
 */
export async function clearConductorState(): Promise<void> {
  if (!redisClient) {
    return;
  }

  try {
    await redisClient.del(REDIS_STATE_KEY);
    console.log('✅ Conductor state cleared from Redis');
  } catch (error: any) {
    console.error('❌ Failed to clear conductor state:', error.message);
  }
}

/**
 * Update last activity timestamp
 */
export async function updateConductorActivity(): Promise<void> {
  if (!redisClient) {
    return;
  }

  try {
    const state = await loadConductorState();
    if (state) {
      state.lastActivityAt = new Date().toISOString();
      await saveConductorState(state);
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
