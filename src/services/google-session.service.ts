/**
 * Google Session Service
 *
 * Provides OAuth access tokens for Playwright-based workers.
 * Workers use these tokens in their own Playwright instances to authenticate.
 */

import { redis as redisClient } from '../lib/redis.js';
import { getAccessToken } from './google-auth.service.js';

interface GoogleWebSession {
  accessToken: string;
  tokenType: string;
  expiresAt: string;
  createdAt: string;
}

const REDIS_SESSION_KEY = 'google:web_session';
const SESSION_TTL = 50 * 60; // 50 minutes (tokens expire in ~1 hour)

/**
 * Create a web session (simplified - just returns OAuth token)
 * Workers will use this token in their own Playwright instances
 */
export async function createWebSession(
  userId: string = 'default-user'
): Promise<GoogleWebSession> {
  // Get valid OAuth access token (auto-refreshed if needed)
  const accessToken = await getAccessToken(userId);

  if (!accessToken) {
    throw new Error('No access token available');
  }

  const session: GoogleWebSession = {
    accessToken,
    tokenType: 'Bearer',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL * 1000).toISOString(),
  };

  // Store in Redis
  await storeSession(userId, session);

  console.log(`✅ Google web session created for user: ${userId}`);

  return session;
}

/**
 * Get stored web session from Redis
 */
export async function getWebSession(
  userId: string = 'default-user'
): Promise<GoogleWebSession | null> {
  if (!redisClient) {
    return null;
  }

  try {
    const sessionData = await redisClient.get(`${REDIS_SESSION_KEY}:${userId}`);

    if (!sessionData) {
      return null;
    }

    const session = JSON.parse(sessionData) as GoogleWebSession;

    // Check if expired
    if (new Date(session.expiresAt) < new Date()) {
      console.log('⏰ Google web session expired, will recreate');
      return null;
    }

    return session;
  } catch (error: any) {
    console.error('❌ Failed to get web session from Redis:', error.message);
    return null;
  }
}

/**
 * Get or create web session (ensures workers always have valid session)
 */
export async function ensureWebSession(
  userId: string = 'default-user'
): Promise<GoogleWebSession> {
  // Try to get existing session
  let session = await getWebSession(userId);

  if (!session) {
    // Create new session
    console.log('🔄 Creating new Google web session...');
    session = await createWebSession(userId);
  }

  return session;
}

/**
 * Store session in Redis
 */
async function storeSession(
  userId: string,
  session: GoogleWebSession
): Promise<void> {
  if (!redisClient) {
    throw new Error('Redis not available - cannot store web session');
  }

  try {
    await redisClient.setex(
      `${REDIS_SESSION_KEY}:${userId}`,
      SESSION_TTL,
      JSON.stringify(session)
    );

    console.log(`✅ Web session stored in Redis for user: ${userId}`);
  } catch (error: any) {
    console.error('❌ Failed to store web session in Redis:', error.message);
    throw error;
  }
}

/**
 * Clear web session
 */
export async function clearWebSession(
  userId: string = 'default-user'
): Promise<void> {
  if (!redisClient) {
    return;
  }

  try {
    await redisClient.del(`${REDIS_SESSION_KEY}:${userId}`);
    console.log(`✅ Web session cleared for user: ${userId}`);
  } catch (error: any) {
    console.error('❌ Failed to clear web session:', error.message);
  }
}

/**
 * Export session data for workers
 * Workers will use the access token to authenticate their Playwright sessions
 */
export function exportSessionForWorker(session: GoogleWebSession) {
  return {
    accessToken: session.accessToken,
    tokenType: session.tokenType,
    expiresAt: session.expiresAt,
    usage: 'Use this access token in your Playwright authentication flow',
  };
}
