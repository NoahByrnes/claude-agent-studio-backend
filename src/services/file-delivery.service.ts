/**
 * File Delivery Service
 *
 * Extracts files from worker sandboxes and delivers them to users.
 * Supports email delivery with attachments and future integrations.
 */

import type { Sandbox } from 'e2b';
import { sendEmail } from './messaging.service.js';

export interface FileDeliveryRequest {
  files: Array<{
    path: string; // Path in sandbox filesystem
    filename?: string; // Optional custom filename for delivery
  }>;
  recipient: string; // Email address
  subject?: string;
  message?: string;
}

/**
 * Extract files from a worker sandbox and deliver via email
 */
export async function deliverFilesFromSandbox(
  sandbox: Sandbox,
  request: FileDeliveryRequest
): Promise<void> {
  try {
    console.log(
      `📤 Delivering ${request.files.length} file(s) to ${request.recipient}...`
    );

    // Extract files from sandbox
    const attachments: Array<{ filename: string; content: string; type: string }> = [];

    for (const file of request.files) {
      try {
        // Read file from sandbox
        const fileData = await sandbox.files.read(file.path);

        // Convert to base64 for email attachment
        const base64Content = Buffer.from(fileData).toString('base64');

        // Determine filename
        const filename = file.filename || file.path.split('/').pop() || 'file';

        // Determine MIME type based on extension
        const mimeType = getMimeType(filename);

        attachments.push({
          filename,
          content: base64Content,
          type: mimeType,
        });

        console.log(`   ✅ Extracted: ${filename} (${fileData.length} bytes)`);
      } catch (error: any) {
        console.error(`   ❌ Failed to extract ${file.path}:`, error.message);
        // Continue with other files
      }
    }

    if (attachments.length === 0) {
      throw new Error('No files could be extracted');
    }

    // Send email with attachments
    const subject =
      request.subject ||
      `Agent Work Delivery: ${attachments.map((a) => a.filename).join(', ')}`;
    const body =
      request.message ||
      `Your agent has completed work and attached the following files:\n\n${attachments.map((a) => `- ${a.filename}`).join('\n')}\n\nThank you for using Claude Agent Studio.`;

    await sendEmail(request.recipient, subject, body, attachments);

    console.log(
      `✅ Delivered ${attachments.length} file(s) to ${request.recipient}`
    );
  } catch (error: any) {
    console.error('❌ File delivery failed:', error.message);
    throw new Error(`File delivery failed: ${error.message}`);
  }
}

/**
 * Parse DELIVER_FILE command from conductor output
 * Format: DELIVER_FILE: recipient@email.com | /path/to/file1, /path/to/file2 | Custom subject | Custom message
 */
export function parseDeliverFileCommand(commandText: string): FileDeliveryRequest | null {
  const match = commandText.match(
    /DELIVER_FILE:\s*([^\|]+)\s*\|\s*([^\|]+)\s*(?:\|\s*([^\|]*))?\s*(?:\|\s*(.*))?/
  );

  if (!match) {
    return null;
  }

  const [, recipient, filesStr, subject, message] = match;

  const files = filesStr
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .map((path) => ({ path }));

  if (files.length === 0) {
    return null;
  }

  return {
    recipient: recipient.trim(),
    files,
    subject: subject?.trim() || undefined,
    message: message?.trim() || undefined,
  };
}

/**
 * Determine MIME type from filename extension
 */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();

  const mimeTypes: Record<string, string> = {
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

    // Text
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    ts: 'application/typescript',

    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',

    // Archives
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    '7z': 'application/x-7z-compressed',

    // Other
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    wav: 'audio/wav',
  };

  return mimeTypes[ext || ''] || 'application/octet-stream';
}

/**
 * Get file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
