/**
 * Messaging Service - Email & SMS
 *
 * Handles sending emails via SendGrid and SMS via Twilio
 */

import sgMail from '@sendgrid/mail';
import twilio from 'twilio';
import { getEffectiveConnectorConfig } from './config.service.js';

// Initialize SendGrid
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'agent@noahbyrnes.com';

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
  console.log('✅ SendGrid initialized');
} else {
  console.log('⚠️  SendGrid not configured (SENDGRID_API_KEY missing)');
}

// Initialize Twilio
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

let twilioClient: ReturnType<typeof twilio> | null = null;

if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log('✅ Twilio initialized');
} else {
  console.log('⚠️  Twilio not configured (credentials missing)');
}

/**
 * Send an email via Gmail (Stu's account: stutheagent@gmail.com)
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  attachments?: Array<{ filename: string; content: string; type?: string }>,
  userId?: string
): Promise<void> {
  // Use Google Gmail API to send from Stu's account
  const { sendEmail: gmailSendEmail } = await import('./google-gmail.service.js');

  try {
    await gmailSendEmail(userId || 'default-user', {
      to,
      subject,
      body,
    });
    console.log(`✅ Email sent from stutheagent@gmail.com to ${to}: ${subject}`);
  } catch (error: any) {
    console.error('❌ Gmail error:', error.message);
    throw new Error(`Failed to send email via Gmail: ${error.message}`);
  }
}

/**
 * Send an SMS via Twilio
 */
export async function sendSMS(to: string, message: string, userId?: string): Promise<void> {
  // Get config from database or env vars
  const config = await getEffectiveConnectorConfig(userId, 'sms');

  if (!config || !config.accountSid || !config.authToken || !config.phoneNumber) {
    throw new Error('Twilio not configured. Please configure SMS connector in Studio settings.');
  }

  try {
    // Initialize Twilio with config
    const client = twilio(config.accountSid, config.authToken);

    // Ensure phone number is in E.164 format
    const formattedTo = to.startsWith('+') ? to : `+1${to.replace(/\D/g, '')}`;

    await client.messages.create({
      body: message,
      from: config.phoneNumber,
      to: formattedTo,
    });

    console.log(`✅ SMS sent to ${to}`);
  } catch (error: any) {
    console.error('❌ Twilio error:', error.message);
    throw new Error(`Failed to send SMS: ${error.message}`);
  }
}

/**
 * Check if email service is configured
 */
export function isEmailConfigured(): boolean {
  return !!SENDGRID_API_KEY;
}

/**
 * Check if SMS service is configured
 */
export function isSMSConfigured(): boolean {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER);
}

/**
 * Get messaging configuration status
 */
export function getMessagingStatus() {
  return {
    email: {
      configured: isEmailConfigured(),
      fromAddress: SENDGRID_FROM_EMAIL,
    },
    sms: {
      configured: isSMSConfigured(),
      phoneNumber: TWILIO_PHONE_NUMBER,
    },
  };
}
