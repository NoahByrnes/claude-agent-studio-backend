/**
 * Messaging Service - Email & SMS
 *
 * Handles sending emails via SendGrid and SMS via Twilio
 */

import sgMail from '@sendgrid/mail';
import twilio from 'twilio';

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
 * Send an email via SendGrid
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  attachments?: Array<{ filename: string; content: string; type?: string }>
): Promise<void> {
  if (!SENDGRID_API_KEY) {
    throw new Error('SendGrid not configured. Set SENDGRID_API_KEY environment variable.');
  }

  try {
    const msg: any = {
      to,
      from: SENDGRID_FROM_EMAIL,
      subject,
      text: body,
      html: body.replace(/\n/g, '<br>'),
    };

    if (attachments && attachments.length > 0) {
      msg.attachments = attachments.map((att) => ({
        filename: att.filename,
        content: att.content,
        type: att.type || 'application/octet-stream',
        disposition: 'attachment',
      }));
    }

    await sgMail.send(msg);
    console.log(`✅ Email sent to ${to}: ${subject}`);
  } catch (error: any) {
    console.error('❌ SendGrid error:', error.response?.body || error.message);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

/**
 * Send an SMS via Twilio
 */
export async function sendSMS(to: string, message: string): Promise<void> {
  if (!twilioClient || !TWILIO_PHONE_NUMBER) {
    throw new Error(
      'Twilio not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.'
    );
  }

  try {
    // Ensure phone number is in E.164 format
    const formattedTo = to.startsWith('+') ? to : `+1${to.replace(/\D/g, '')}`;

    await twilioClient.messages.create({
      body: message,
      from: TWILIO_PHONE_NUMBER,
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
