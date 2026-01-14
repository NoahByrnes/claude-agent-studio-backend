/**
 * Google Auth Service
 *
 * Handles OAuth2 flow, token management, and refresh for Google Workspace APIs.
 * Uses encrypted storage in PostgreSQL with Redis caching.
 */

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { db } from '../lib/db.js';
import { connectorConfigs } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { redis as redisClient } from '../lib/redis.js';
import { encrypt, decrypt } from './config.service.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/google/auth/callback';

// Google API Scopes
export const GOOGLE_SCOPES = {
  // User info
  USERINFO_EMAIL: 'https://www.googleapis.com/auth/userinfo.email',
  USERINFO_PROFILE: 'https://www.googleapis.com/auth/userinfo.profile',
  // Gmail
  GMAIL_READ: 'https://www.googleapis.com/auth/gmail.readonly',
  GMAIL_SEND: 'https://www.googleapis.com/auth/gmail.send',
  GMAIL_MODIFY: 'https://www.googleapis.com/auth/gmail.modify',
  // Docs
  DOCS_READ: 'https://www.googleapis.com/auth/documents.readonly',
  DOCS_WRITE: 'https://www.googleapis.com/auth/documents',
  // Drive
  DRIVE_READ: 'https://www.googleapis.com/auth/drive.readonly',
  DRIVE_FILE: 'https://www.googleapis.com/auth/drive.file',
  // Calendar
  CALENDAR_READ: 'https://www.googleapis.com/auth/calendar.readonly',
  CALENDAR_WRITE: 'https://www.googleapis.com/auth/calendar.events',
};

// Default scopes for Stu's Google account
const DEFAULT_SCOPES = [
  GOOGLE_SCOPES.USERINFO_EMAIL,
  GOOGLE_SCOPES.USERINFO_PROFILE,
  GOOGLE_SCOPES.GMAIL_READ,
  GOOGLE_SCOPES.GMAIL_SEND,
  GOOGLE_SCOPES.GMAIL_MODIFY,
  GOOGLE_SCOPES.DOCS_WRITE,
  GOOGLE_SCOPES.DRIVE_READ,
  GOOGLE_SCOPES.CALENDAR_READ,
  GOOGLE_SCOPES.CALENDAR_WRITE,
];

interface GoogleCredentials {
  access_token: string;
  refresh_token: string;
  token_expiry: string;
  scopes: string[];
  account_email?: string;
}

interface GoogleAuthStatus {
  authenticated: boolean;
  account_email?: string;
  scopes?: string[];
  token_expires_at?: string;
}

/**
 * Create OAuth2 client
 */
function createOAuth2Client(): OAuth2Client {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

/**
 * Generate authorization URL for OAuth flow
 */
export async function generateAuthUrl(
  userId: string = 'default-user',
  scopes: string[] = DEFAULT_SCOPES
): Promise<string> {
  const oauth2Client = createOAuth2Client();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Get refresh token
    scope: scopes,
    prompt: 'consent', // Force consent screen to get refresh token
    state: userId, // Pass userId in state for callback
  });

  return authUrl;
}

/**
 * Handle OAuth callback and exchange code for tokens
 */
export async function handleCallback(
  code: string,
  userId: string = 'default-user'
): Promise<GoogleCredentials> {
  const oauth2Client = createOAuth2Client();

  // Exchange authorization code for tokens
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('Failed to obtain tokens from Google');
  }

  // Get user's email address
  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const userInfo = await oauth2.userinfo.get();

  const credentials: GoogleCredentials = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : new Date(Date.now() + 3600000).toISOString(),
    scopes: tokens.scope?.split(' ') || DEFAULT_SCOPES,
    account_email: userInfo.data.email || undefined,
  };

  // Store encrypted credentials in database
  await saveCredentials(userId, credentials);

  // Cache in Redis
  await cacheCredentials(userId, credentials);

  console.log(`✅ Google account authenticated for user: ${userId} (${credentials.account_email})`);

  return credentials;
}

/**
 * Get valid access token (auto-refresh if expired)
 */
export async function getAccessToken(userId: string = 'default-user'): Promise<string> {
  // Try Redis cache first
  if (redisClient) {
    try {
      const cached = await redisClient.get(`google:token:${userId}`);
      if (cached) {
        const creds = JSON.parse(cached) as GoogleCredentials;

        // Check if token is still valid (with 5 min buffer)
        const expiryTime = new Date(creds.token_expiry).getTime();
        const now = Date.now();
        const bufferTime = 5 * 60 * 1000; // 5 minutes

        if (expiryTime > now + bufferTime) {
          return creds.access_token;
        }
      }
    } catch (error: any) {
      console.warn('⚠️  Redis token cache read failed:', error.message);
    }
  }

  // Get from database and refresh if needed
  const credentials = await getCredentials(userId);

  if (!credentials) {
    throw new Error('Google account not connected. Please authenticate first.');
  }

  // Check if token is expired
  const expiryTime = new Date(credentials.token_expiry).getTime();
  const now = Date.now();
  const bufferTime = 5 * 60 * 1000; // 5 minutes

  if (expiryTime <= now + bufferTime) {
    console.log('🔄 Google token expired, refreshing...');
    const newToken = await refreshAccessToken(userId);
    return newToken;
  }

  // Cache valid token
  await cacheCredentials(userId, credentials);

  return credentials.access_token;
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(userId: string = 'default-user'): Promise<string> {
  const credentials = await getCredentials(userId);

  if (!credentials || !credentials.refresh_token) {
    throw new Error('No refresh token available. Please re-authenticate.');
  }

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    refresh_token: credentials.refresh_token,
  });

  try {
    const { credentials: newTokens } = await oauth2Client.refreshAccessToken();

    if (!newTokens.access_token) {
      throw new Error('Failed to refresh access token');
    }

    // Update stored credentials
    const updatedCredentials: GoogleCredentials = {
      ...credentials,
      access_token: newTokens.access_token,
      token_expiry: newTokens.expiry_date ? new Date(newTokens.expiry_date).toISOString() : new Date(Date.now() + 3600000).toISOString(),
    };

    await saveCredentials(userId, updatedCredentials);
    await cacheCredentials(userId, updatedCredentials);

    console.log(`✅ Google token refreshed for user: ${userId}`);

    return newTokens.access_token;
  } catch (error: any) {
    console.error('❌ Failed to refresh Google token:', error.message);

    // If refresh fails, token may be revoked - clear credentials
    if (error.message.includes('invalid_grant')) {
      console.log('⚠️  Refresh token invalid or revoked. Clearing credentials.');
      await revokeAccess(userId);
    }

    throw new Error('Failed to refresh Google access token. Please re-authenticate.');
  }
}

/**
 * Check if user has authenticated with Google
 */
export async function isAuthenticated(userId: string = 'default-user'): Promise<boolean> {
  try {
    const credentials = await getCredentials(userId);
    return !!credentials && !!credentials.refresh_token;
  } catch {
    return false;
  }
}

/**
 * Get authentication status
 */
export async function getAuthStatus(userId: string = 'default-user'): Promise<GoogleAuthStatus> {
  try {
    const credentials = await getCredentials(userId);

    if (!credentials) {
      return { authenticated: false };
    }

    return {
      authenticated: true,
      account_email: credentials.account_email,
      scopes: credentials.scopes,
      token_expires_at: credentials.token_expiry,
    };
  } catch {
    return { authenticated: false };
  }
}

/**
 * Revoke Google access and clear credentials
 */
export async function revokeAccess(userId: string = 'default-user'): Promise<void> {
  try {
    const credentials = await getCredentials(userId);

    if (credentials?.access_token) {
      // Revoke token with Google
      const oauth2Client = createOAuth2Client();
      oauth2Client.setCredentials({ access_token: credentials.access_token });
      await oauth2Client.revokeCredentials();
    }
  } catch (error: any) {
    console.warn('⚠️  Failed to revoke Google token:', error.message);
  }

  // Clear from database
  try {
    await db.delete(connectorConfigs)
      .where(and(
        eq(connectorConfigs.user_id, userId),
        eq(connectorConfigs.connector_type, 'google_workspace')
      ));
  } catch (error: any) {
    console.error('❌ Failed to delete Google credentials from database:', error.message);
  }

  // Clear from Redis cache
  if (redisClient) {
    try {
      await redisClient.del(`google:token:${userId}`);
    } catch (error: any) {
      console.warn('⚠️  Failed to clear Google token from Redis:', error.message);
    }
  }

  console.log(`✅ Google access revoked for user: ${userId}`);
}

/**
 * Create authenticated OAuth2 client for API calls
 */
export async function getAuthenticatedClient(userId: string = 'default-user'): Promise<OAuth2Client> {
  // Get full credentials from database (includes refresh token)
  const credentials = await getCredentials(userId);

  if (!credentials) {
    throw new Error('Google account not connected. Please authenticate first.');
  }

  const oauth2Client = createOAuth2Client();

  // Set full credentials including refresh token for auto-refresh
  oauth2Client.setCredentials({
    access_token: credentials.access_token,
    refresh_token: credentials.refresh_token,
    expiry_date: new Date(credentials.token_expiry).getTime(),
    scope: credentials.scopes.join(' '),
  });

  return oauth2Client;
}

/**
 * Check if user has a specific scope
 */
export async function hasScope(userId: string = 'default-user', scope: string): Promise<boolean> {
  const credentials = await getCredentials(userId);

  if (!credentials || !credentials.scopes) {
    return false;
  }

  return credentials.scopes.includes(scope);
}

// ============================================================================
// Internal Helper Functions
// ============================================================================

/**
 * Save credentials to database (encrypted)
 */
async function saveCredentials(userId: string, credentials: GoogleCredentials): Promise<void> {
  const encryptedSettings = {
    access_token: encrypt(credentials.access_token),
    refresh_token: encrypt(credentials.refresh_token),
    token_expiry: credentials.token_expiry,
    scopes: credentials.scopes,
    account_email: credentials.account_email,
  };

  // Check if config exists
  const existing = await db.select()
    .from(connectorConfigs)
    .where(and(
      eq(connectorConfigs.user_id, userId),
      eq(connectorConfigs.connector_type, 'google_workspace')
    ))
    .limit(1);

  if (existing.length > 0) {
    // Update existing
    await db.update(connectorConfigs)
      .set({
        settings: encryptedSettings,
        enabled: 'true',
        updated_at: new Date(),
      })
      .where(and(
        eq(connectorConfigs.user_id, userId),
        eq(connectorConfigs.connector_type, 'google_workspace')
      ));
  } else {
    // Insert new
    await db.insert(connectorConfigs).values({
      user_id: userId,
      connector_type: 'google_workspace',
      settings: encryptedSettings,
      enabled: 'true',
    });
  }
}

/**
 * Get credentials from database (decrypted)
 */
async function getCredentials(userId: string): Promise<GoogleCredentials | null> {
  const result = await db.select()
    .from(connectorConfigs)
    .where(and(
      eq(connectorConfigs.user_id, userId),
      eq(connectorConfigs.connector_type, 'google_workspace')
    ))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const config = result[0];
  const settings = config.settings as any;

  try {
    return {
      access_token: decrypt(settings.access_token),
      refresh_token: decrypt(settings.refresh_token),
      token_expiry: settings.token_expiry,
      scopes: settings.scopes || DEFAULT_SCOPES,
      account_email: settings.account_email,
    };
  } catch (error: any) {
    console.error('❌ Failed to decrypt Google credentials:', error.message);
    throw new Error('Failed to decrypt Google credentials');
  }
}

/**
 * Cache credentials in Redis (50 min TTL)
 */
async function cacheCredentials(userId: string, credentials: GoogleCredentials): Promise<void> {
  if (!redisClient) {
    return;
  }

  try {
    // Cache for 50 minutes (tokens valid for 60 min, refresh before expiry)
    await redisClient.setex(
      `google:token:${userId}`,
      3000, // 50 minutes
      JSON.stringify(credentials)
    );
  } catch (error: any) {
    console.warn('⚠️  Failed to cache Google credentials in Redis:', error.message);
  }
}
