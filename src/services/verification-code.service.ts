/**
 * Verification Code Service
 *
 * Detects and stores verification codes from SMS/Email for Stu's autonomous 2FA handling.
 * Enables Stu to manage his own Google account authentication without human intervention.
 */

import { redis as redisClient } from '../lib/redis.js';

interface VerificationCode {
  code: string;
  source: 'SMS' | 'EMAIL';
  sender: string;
  fullMessage: string;
  detectedAt: string;
  expiresAt: string;
}

const VERIFICATION_CODE_TTL = 300; // 5 minutes
const REDIS_KEY_PREFIX = 'verification_code:';

/**
 * Common patterns for verification codes in messages
 */
const VERIFICATION_PATTERNS = [
  // Google patterns
  /verification code is[:\s]+(\d{6})/i,
  /your code is[:\s]+(\d{6})/i,
  /google code[:\s]+(\d{6})/i,
  /G-(\d{6})/,

  // Generic patterns
  /code[:\s]+(\d{4,8})/i,
  /(\d{6})\s+is your/i,
  /use code[:\s]+(\d{4,8})/i,
  /enter code[:\s]+(\d{4,8})/i,
  /authentication code[:\s]+(\d{4,8})/i,
  /verify with[:\s]+(\d{4,8})/i,
  /confirmation code[:\s]+(\d{4,8})/i,
  /security code[:\s]+(\d{4,8})/i,

  // Specific services
  /twilio.*code[:\s]+(\d{6})/i,
  /twitter.*code[:\s]+(\d{6})/i,
  /github.*code[:\s]+(\d{6})/i,

  // Standalone 6-digit codes (only if message contains verification-related keywords)
  /(?:verification|verify|code|authenticate|2fa|two.factor).*?(\d{6})/i,
];

/**
 * Keywords that suggest a message contains a verification code
 */
const VERIFICATION_KEYWORDS = [
  'verification',
  'verify',
  'code',
  'authenticate',
  'authentication',
  '2fa',
  'two-factor',
  'two factor',
  'security',
  'confirm',
  'confirmation',
  'otp',
  'one-time',
  'passcode',
];

/**
 * Detect if message contains a verification code
 */
export function detectVerificationCode(message: string): string | null {
  // Try each pattern
  for (const pattern of VERIFICATION_PATTERNS) {
    const match = message.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Check if message is likely a verification code message
 */
export function isVerificationMessage(message: string): boolean {
  const lowerMessage = message.toLowerCase();

  // Check for verification keywords
  const hasKeyword = VERIFICATION_KEYWORDS.some(keyword =>
    lowerMessage.includes(keyword)
  );

  // Check if it contains a code-like pattern
  const hasCodePattern = /\d{4,8}/.test(message);

  return hasKeyword && hasCodePattern;
}

/**
 * Store verification code in Redis
 */
export async function storeVerificationCode(
  code: string,
  source: 'SMS' | 'EMAIL',
  sender: string,
  fullMessage: string
): Promise<void> {
  if (!redisClient) {
    console.warn('⚠️  Redis not available, cannot store verification code');
    return;
  }

  const verificationCode: VerificationCode = {
    code,
    source,
    sender,
    fullMessage,
    detectedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL * 1000).toISOString(),
  };

  const key = `${REDIS_KEY_PREFIX}latest`;

  try {
    await redisClient.setex(
      key,
      VERIFICATION_CODE_TTL,
      JSON.stringify(verificationCode)
    );

    // Also store by sender for specific retrieval
    const senderKey = `${REDIS_KEY_PREFIX}sender:${sender.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    await redisClient.setex(
      senderKey,
      VERIFICATION_CODE_TTL,
      JSON.stringify(verificationCode)
    );

    console.log(`✅ Verification code stored: ${code} from ${sender} (${source})`);
  } catch (error: any) {
    console.error('❌ Failed to store verification code:', error.message);
  }
}

/**
 * Get the most recent verification code
 */
export async function getLatestVerificationCode(): Promise<VerificationCode | null> {
  if (!redisClient) {
    return null;
  }

  try {
    const data = await redisClient.get(`${REDIS_KEY_PREFIX}latest`);

    if (!data) {
      return null;
    }

    return JSON.parse(data) as VerificationCode;
  } catch (error: any) {
    console.error('❌ Failed to get verification code:', error.message);
    return null;
  }
}

/**
 * Get verification code from specific sender
 */
export async function getVerificationCodeFromSender(sender: string): Promise<VerificationCode | null> {
  if (!redisClient) {
    return null;
  }

  try {
    const senderKey = `${REDIS_KEY_PREFIX}sender:${sender.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const data = await redisClient.get(senderKey);

    if (!data) {
      return null;
    }

    return JSON.parse(data) as VerificationCode;
  } catch (error: any) {
    console.error('❌ Failed to get verification code from sender:', error.message);
    return null;
  }
}

/**
 * Clear all verification codes
 */
export async function clearVerificationCodes(): Promise<void> {
  if (!redisClient) {
    return;
  }

  try {
    const keys = await redisClient.keys(`${REDIS_KEY_PREFIX}*`);

    if (keys.length > 0) {
      await redisClient.del(...keys);
      console.log(`✅ Cleared ${keys.length} verification code(s)`);
    }
  } catch (error: any) {
    console.error('❌ Failed to clear verification codes:', error.message);
  }
}

/**
 * Process incoming message and handle verification codes automatically
 */
export async function processIncomingMessage(
  message: string,
  source: 'SMS' | 'EMAIL',
  sender: string
): Promise<{
  isVerificationCode: boolean;
  code?: string;
  shouldRouteToStu: boolean;
}> {
  // Check if this is a verification code message
  if (!isVerificationMessage(message)) {
    return {
      isVerificationCode: false,
      shouldRouteToStu: true, // Route normal messages to Stu
    };
  }

  // Try to extract the code
  const code = detectVerificationCode(message);

  if (code) {
    // Store the code
    await storeVerificationCode(code, source, sender, message);

    console.log(`🔐 Verification code detected and stored: ${code}`);

    return {
      isVerificationCode: true,
      code,
      shouldRouteToStu: false, // Don't route to Stu - it's just a verification code
    };
  }

  // Looks like verification message but couldn't extract code
  return {
    isVerificationCode: true,
    shouldRouteToStu: false, // Don't route to Stu
  };
}

/**
 * Format verification code info for Stu's context (when he needs it)
 */
export function formatVerificationCodeForStu(verificationCode: VerificationCode): string {
  return [
    `[VERIFICATION CODE AVAILABLE]`,
    `Code: ${verificationCode.code}`,
    `Source: ${verificationCode.source}`,
    `From: ${verificationCode.sender}`,
    `Received: ${new Date(verificationCode.detectedAt).toLocaleString()}`,
    `Expires: ${new Date(verificationCode.expiresAt).toLocaleString()}`,
    ``,
    `Use this code for authentication if needed.`,
  ].join('\n');
}
