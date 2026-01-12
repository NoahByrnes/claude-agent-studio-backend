/**
 * Configuration Service
 *
 * Manages connector configurations stored in database.
 * Provides secure storage and retrieval of API keys and credentials.
 */

import crypto from 'crypto';

// In-memory storage for MVP (replace with Supabase later)
const configs: Map<string, any> = new Map();

// Encryption key (should be in env var for production)
const ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY || 'default-key-change-in-production-32b';
const ALGORITHM = 'aes-256-cbc';

/**
 * Encrypt sensitive data
 */
function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt sensitive data
 */
function decrypt(text: string): string {
  const parts = text.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = parts[1];
  const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export interface ConnectorConfig {
  type: 'email' | 'sms';
  enabled: boolean;
  settings: Record<string, any>;
  updatedAt: Date;
}

/**
 * Save connector configuration
 */
export async function saveConnectorConfig(
  userId: string,
  type: 'email' | 'sms',
  settings: Record<string, any>
): Promise<void> {
  // Encrypt sensitive fields
  const encryptedSettings: Record<string, any> = {};
  const sensitiveFields = ['apiKey', 'authToken', 'accountSid'];

  for (const [key, value] of Object.entries(settings)) {
    if (sensitiveFields.includes(key) && typeof value === 'string') {
      encryptedSettings[key] = encrypt(value);
    } else {
      encryptedSettings[key] = value;
    }
  }

  const config: ConnectorConfig = {
    type,
    enabled: true,
    settings: encryptedSettings,
    updatedAt: new Date(),
  };

  // Store in memory (replace with database)
  configs.set(`${userId}:${type}`, config);

  console.log(`✅ Saved ${type} connector config for user ${userId}`);
}

/**
 * Get connector configuration
 */
export async function getConnectorConfig(
  userId: string,
  type: 'email' | 'sms'
): Promise<ConnectorConfig | null> {
  const config = configs.get(`${userId}:${type}`);

  if (!config) {
    return null;
  }

  // Decrypt sensitive fields
  const decryptedSettings: Record<string, any> = {};
  const sensitiveFields = ['apiKey', 'authToken', 'accountSid'];

  for (const [key, value] of Object.entries(config.settings)) {
    if (sensitiveFields.includes(key) && typeof value === 'string') {
      try {
        decryptedSettings[key] = decrypt(value);
      } catch (error) {
        console.error(`Failed to decrypt ${key}:`, error);
        decryptedSettings[key] = value; // Fallback to original
      }
    } else {
      decryptedSettings[key] = value;
    }
  }

  return {
    ...config,
    settings: decryptedSettings,
  };
}

/**
 * Get all connector configs for user
 */
export async function getAllConnectorConfigs(
  userId: string
): Promise<{ email: ConnectorConfig | null; sms: ConnectorConfig | null }> {
  const email = await getConnectorConfig(userId, 'email');
  const sms = await getConnectorConfig(userId, 'sms');
  return { email, sms };
}

/**
 * Delete connector configuration
 */
export async function deleteConnectorConfig(
  userId: string,
  type: 'email' | 'sms'
): Promise<void> {
  configs.delete(`${userId}:${type}`);
  console.log(`✅ Deleted ${type} connector config for user ${userId}`);
}

/**
 * Check if connector is configured (for backward compatibility with env vars)
 */
export function isConnectorConfigured(type: 'email' | 'sms'): boolean {
  if (type === 'email') {
    return !!process.env.SENDGRID_API_KEY;
  } else {
    return !!(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER
    );
  }
}

/**
 * Get connector config (from database or env vars)
 */
export async function getEffectiveConnectorConfig(
  userId: string | undefined,
  type: 'email' | 'sms'
): Promise<any | null> {
  // Try to get from database first (if userId provided)
  if (userId) {
    const config = await getConnectorConfig(userId, type);
    if (config && config.enabled) {
      return config.settings;
    }
  }

  // Fallback to environment variables
  if (type === 'email' && process.env.SENDGRID_API_KEY) {
    return {
      apiKey: process.env.SENDGRID_API_KEY,
      fromEmail: process.env.SENDGRID_FROM_EMAIL || 'agent@noahbyrnes.com',
    };
  }

  if (type === 'sms' && process.env.TWILIO_ACCOUNT_SID) {
    return {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    };
  }

  return null;
}
