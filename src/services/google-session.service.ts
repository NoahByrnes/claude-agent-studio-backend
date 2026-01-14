/**
 * Google Session Service
 *
 * Manages Google web session cookies for Playwright-based workers.
 * Allows workers to authenticate to Google's web UI using stored sessions.
 */

import { redis as redisClient } from '../lib/redis.js';
import { getAuthenticatedClient } from './google-auth.service.js';
import { chromium } from 'playwright';

interface GoogleWebSession {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  createdAt: string;
  expiresAt: string;
}

const REDIS_SESSION_KEY = 'google:web_session';
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days

/**
 * Create a web session by logging in via Playwright
 * This generates cookies that workers can reuse
 */
export async function createWebSession(
  userId: string = 'default-user'
): Promise<GoogleWebSession> {
  // Get OAuth client to extract access token
  const oauth2Client = await getAuthenticatedClient(userId);
  const credentials = await oauth2Client.getAccessToken();

  if (!credentials.token) {
    throw new Error('No access token available');
  }

  // Launch headless browser
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Method 1: Set OAuth token as cookie and navigate
    // Google will recognize the OAuth session
    await context.addCookies([
      {
        name: 'oauth_token',
        value: credentials.token,
        domain: '.google.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
    ]);

    // Navigate to Google to establish session
    await page.goto('https://accounts.google.com/signin/oauth');
    await page.waitForTimeout(3000);

    // Extract all Google cookies
    const cookies = await context.cookies();

    // Filter for Google domains
    const googleCookies = cookies.filter((cookie) =>
      cookie.domain.includes('google.com') ||
      cookie.domain.includes('gmail.com') ||
      cookie.domain.includes('docs.google.com')
    );

    const session: GoogleWebSession = {
      cookies: googleCookies as any,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL * 1000).toISOString(),
    };

    // Store in Redis
    await storeSession(userId, session);

    console.log(`✅ Google web session created for user: ${userId}`);

    return session;
  } finally {
    await browser.close();
  }
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
 * Export session cookies in Playwright-compatible format
 */
export function exportCookiesForPlaywright(session: GoogleWebSession): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}> {
  return session.cookies;
}
