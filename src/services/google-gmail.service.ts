/**
 * Google Gmail Service
 *
 * Handles Gmail API operations: reading, sending, searching emails.
 * Used by workers via backend API endpoints.
 */

import { google } from 'googleapis';
import { getAuthenticatedClient } from './google-auth.service.js';
import { db } from '../lib/db.js';
import { googleEmailThreads, googleWatchedResources } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import crypto from 'crypto';

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  date: string;
  labels: string[];
  attachments?: GmailAttachment[];
}

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

export interface GmailThread {
  id: string;
  messages: GmailMessage[];
  subject: string;
  participants: string[];
}

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    mimeType?: string;
  }>;
}

/**
 * List messages with optional query filter
 */
export async function listMessages(
  userId: string = 'default-user',
  query: string = '',
  maxResults: number = 50
): Promise<GmailMessage[]> {
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  const response = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });

  const messages = response.data.messages || [];

  // Fetch full message details for each
  const fullMessages = await Promise.all(
    messages.map(async (msg) => {
      if (!msg.id) return null;
      return await getMessage(userId, msg.id);
    })
  );

  return fullMessages.filter((msg): msg is GmailMessage => msg !== null);
}

/**
 * Get a specific message by ID
 */
export async function getMessage(
  userId: string = 'default-user',
  messageId: string
): Promise<GmailMessage> {
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  const response = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const msg = response.data;
  const headers = msg.payload?.headers || [];

  const getHeader = (name: string): string => {
    const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
    return header?.value || '';
  };

  const parseAddresses = (headerValue: string): string[] => {
    if (!headerValue) return [];
    return headerValue.split(',').map((addr) => addr.trim()).filter(Boolean);
  };

  // Extract body
  let body = '';
  let bodyHtml = '';

  const extractBody = (parts: any[]): void => {
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        body = Buffer.from(part.body.data, 'base64').toString('utf-8');
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        bodyHtml = Buffer.from(part.body.data, 'base64').toString('utf-8');
      } else if (part.parts) {
        extractBody(part.parts);
      }
    }
  };

  if (msg.payload?.body?.data) {
    body = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
  } else if (msg.payload?.parts) {
    extractBody(msg.payload.parts);
  }

  // Extract attachments
  const attachments: GmailAttachment[] = [];
  const extractAttachments = (parts: any[]): void => {
    for (const part of parts) {
      if (part.filename && part.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType || 'application/octet-stream',
          size: part.body.size || 0,
          attachmentId: part.body.attachmentId,
        });
      } else if (part.parts) {
        extractAttachments(part.parts);
      }
    }
  };

  if (msg.payload?.parts) {
    extractAttachments(msg.payload.parts);
  }

  return {
    id: msg.id || '',
    threadId: msg.threadId || '',
    from: getHeader('from'),
    to: parseAddresses(getHeader('to')),
    cc: parseAddresses(getHeader('cc')),
    subject: getHeader('subject'),
    body,
    bodyHtml,
    date: getHeader('date'),
    labels: msg.labelIds || [],
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

/**
 * Get email thread with all messages
 */
export async function getThread(
  userId: string = 'default-user',
  threadId: string
): Promise<GmailThread> {
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  const response = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  });

  const thread = response.data;
  const messages = await Promise.all(
    (thread.messages || []).map(async (msg) => {
      if (!msg.id) return null;
      return await getMessage(userId, msg.id);
    })
  );

  const validMessages = messages.filter((msg): msg is GmailMessage => msg !== null);

  // Extract unique participants
  const participantsSet = new Set<string>();
  validMessages.forEach((msg) => {
    participantsSet.add(msg.from);
    msg.to.forEach((addr) => participantsSet.add(addr));
    msg.cc?.forEach((addr) => participantsSet.add(addr));
  });

  return {
    id: thread.id || '',
    messages: validMessages,
    subject: validMessages[0]?.subject || '',
    participants: Array.from(participantsSet),
  };
}

/**
 * Send a new email
 */
export async function sendEmail(
  userId: string = 'default-user',
  options: SendEmailOptions
): Promise<string> {
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  // Build email content
  const toAddresses = Array.isArray(options.to) ? options.to.join(', ') : options.to;
  const ccAddresses = options.cc ? (Array.isArray(options.cc) ? options.cc.join(', ') : options.cc) : '';
  const bccAddresses = options.bcc ? (Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc) : '';

  const emailLines: string[] = [
    `To: ${toAddresses}`,
    ccAddresses ? `Cc: ${ccAddresses}` : '',
    bccAddresses ? `Bcc: ${bccAddresses}` : '',
    `Subject: ${options.subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.body,
  ].filter(Boolean);

  const email = emailLines.join('\r\n');
  const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedEmail,
    },
  });

  console.log(`✅ Email sent: ${options.subject} to ${toAddresses}`);

  return response.data.id || '';
}

/**
 * Reply to an existing thread
 */
export async function replyToThread(
  userId: string = 'default-user',
  threadId: string,
  body: string,
  replyAll: boolean = false
): Promise<string> {
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  // Get original thread to extract recipients
  const thread = await getThread(userId, threadId);
  const originalMessage = thread.messages[thread.messages.length - 1];

  if (!originalMessage) {
    throw new Error('Thread has no messages');
  }

  // Build reply
  const toAddresses = originalMessage.from;
  const ccAddresses = replyAll ? originalMessage.to.filter((addr) => addr !== originalMessage.from) : [];

  const emailLines: string[] = [
    `To: ${toAddresses}`,
    ccAddresses.length > 0 ? `Cc: ${ccAddresses.join(', ')}` : '',
    `Subject: Re: ${originalMessage.subject.replace(/^Re: /, '')}`,
    `In-Reply-To: <${originalMessage.id}>`,
    `References: <${originalMessage.id}>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].filter(Boolean);

  const email = emailLines.join('\r\n');
  const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedEmail,
      threadId: threadId,
    },
  });

  console.log(`✅ Reply sent to thread: ${threadId}`);

  return response.data.id || '';
}

/**
 * Search emails with Gmail query syntax
 */
export async function searchEmails(
  userId: string = 'default-user',
  query: string,
  maxResults: number = 50
): Promise<GmailMessage[]> {
  return await listMessages(userId, query, maxResults);
}

/**
 * Watch mailbox for push notifications (via Pub/Sub)
 */
export async function watchMailbox(
  userId: string = 'default-user',
  topicName: string = process.env.GOOGLE_PUBSUB_TOPIC || ''
): Promise<{ historyId: string; expiration: number }> {
  if (!topicName) {
    throw new Error('GOOGLE_PUBSUB_TOPIC not configured');
  }

  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  const response = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName,
      labelIds: ['INBOX', 'UNREAD'],
    },
  });

  const historyId = response.data.historyId || '';
  const expiration = response.data.expiration ? parseInt(response.data.expiration) : 0;

  // Store watch info in database
  const channelId = crypto.randomUUID();
  const channelToken = crypto.randomBytes(32).toString('hex');

  await db.insert(googleWatchedResources).values({
    user_id: userId,
    resource_type: 'gmail',
    resource_id: 'me',
    channel_id: channelId,
    channel_token: channelToken,
    expiration: new Date(expiration),
  });

  console.log(`✅ Gmail watch set up for user: ${userId} (expires: ${new Date(expiration).toISOString()})`);

  return { historyId, expiration };
}

/**
 * Stop watching mailbox
 */
export async function stopWatch(
  userId: string = 'default-user',
  channelId: string
): Promise<void> {
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  await gmail.users.stop({
    userId: 'me',
  });

  // Remove from database
  await db.delete(googleWatchedResources)
    .where(and(
      eq(googleWatchedResources.user_id, userId),
      eq(googleWatchedResources.channel_id, channelId)
    ));

  console.log(`✅ Gmail watch stopped: ${channelId}`);
}

/**
 * Get message history since a historyId (for processing push notifications)
 */
export async function getHistorySince(
  userId: string = 'default-user',
  historyId: string
): Promise<GmailMessage[]> {
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  const response = await gmail.users.history.list({
    userId: 'me',
    startHistoryId: historyId,
    historyTypes: ['messageAdded'],
  });

  const history = response.data.history || [];
  const messageIds = new Set<string>();

  // Extract unique message IDs from history
  history.forEach((record) => {
    record.messagesAdded?.forEach((msgAdded) => {
      if (msgAdded.message?.id) {
        messageIds.add(msgAdded.message.id);
      }
    });
  });

  // Fetch full message details
  const messages = await Promise.all(
    Array.from(messageIds).map(async (msgId) => {
      try {
        return await getMessage(userId, msgId);
      } catch (error) {
        console.error(`Failed to fetch message ${msgId}:`, error);
        return null;
      }
    })
  );

  return messages.filter((msg): msg is GmailMessage => msg !== null);
}

/**
 * Track email thread in database
 */
export async function trackEmailThread(
  userId: string = 'default-user',
  threadId: string,
  subject: string,
  participants: string[],
  workerId?: string
): Promise<void> {
  // Check if thread already exists
  const existing = await db.select()
    .from(googleEmailThreads)
    .where(eq(googleEmailThreads.thread_id, threadId))
    .limit(1);

  if (existing.length > 0) {
    // Update existing
    await db.update(googleEmailThreads)
      .set({
        last_message_at: new Date(),
        worker_id: workerId || existing[0].worker_id,
      })
      .where(eq(googleEmailThreads.thread_id, threadId));
  } else {
    // Insert new
    await db.insert(googleEmailThreads).values({
      user_id: userId,
      thread_id: threadId,
      subject,
      participants,
      last_message_at: new Date(),
      worker_id: workerId,
      status: 'active',
    });
  }
}
