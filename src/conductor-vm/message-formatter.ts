/**
 * Message Formatter
 *
 * Formats incoming events into the CLI message format that the conductor reads.
 */

import type {
  IncomingMessage,
  EmailContent,
  SMSContent,
  UserContent,
  WorkerContent,
  SystemContent,
} from './types';

export class MessageFormatter {
  /**
   * Format any message for CLI injection.
   */
  format(message: IncomingMessage): string {
    const content = message.content;

    switch (content.type) {
      case 'EMAIL':
        return this.formatEmail(content);
      case 'SMS':
        return this.formatSMS(content);
      case 'USER':
        return this.formatUser(content);
      case 'WORKER':
        return this.formatWorker(content);
      case 'SYSTEM':
        return this.formatSystem(content);
      default:
        return `[UNKNOWN]\n${JSON.stringify(content)}\n---\n`;
    }
  }

  /**
   * Format email webhook into CLI message.
   */
  formatEmail(email: EmailContent): string {
    let msg = `[EMAIL]\n`;
    msg += `From: ${email.from}\n`;
    msg += `To: ${email.to}\n`;
    msg += `Subject: ${email.subject}\n`;

    if (email.threadId) {
      msg += `Thread-ID: ${email.threadId}\n`;
    }

    msg += `Body:\n${email.body}\n`;

    if (email.attachments && email.attachments.length > 0) {
      msg += `Attachments:\n`;
      for (const att of email.attachments) {
        msg += `  - ${att.filename}: ${att.url}\n`;
      }
    }

    msg += `---\n`;
    return msg;
  }

  /**
   * Format SMS webhook into CLI message.
   */
  formatSMS(sms: SMSContent): string {
    return `[SMS]\nFrom: ${sms.from}\nMessage: ${sms.message}\n---\n`;
  }

  /**
   * Format user prompt from web UI.
   */
  formatUser(user: UserContent): string {
    let msg = `[USER]\n`;
    if (user.username) {
      msg += `From: ${user.username} (${user.userId})\n`;
    } else {
      msg += `From: ${user.userId}\n`;
    }
    msg += `Message: ${user.message}\n`;
    msg += `---\n`;
    return msg;
  }

  /**
   * Format worker output for conductor.
   */
  formatWorker(worker: WorkerContent): string {
    let msg = `[WORKER:${worker.workerId}]\n`;
    msg += `Status: ${worker.status}\n`;
    msg += `Summary: ${worker.summary}\n`;

    if (worker.details) {
      msg += `Details:\n${worker.details}\n`;
    }

    if (worker.artifacts && worker.artifacts.length > 0) {
      msg += `Artifacts:\n`;
      for (const art of worker.artifacts) {
        if (art.url) {
          msg += `  - ${art.name}: ${art.url}\n`;
        } else {
          msg += `  - ${art.name}${art.description ? ` - ${art.description}` : ''}\n`;
        }
      }
    }

    msg += `---\n`;
    return msg;
  }

  /**
   * Format system messages (confirmations, errors).
   */
  formatSystem(system: SystemContent): string {
    let msg = `[SYSTEM]\n`;
    msg += `Event: ${system.event}\n`;
    msg += `Message: ${system.message}\n`;

    if (system.data) {
      msg += `Data: ${JSON.stringify(system.data)}\n`;
    }

    msg += `---\n`;
    return msg;
  }

  /**
   * Create email message from webhook payload.
   */
  static createEmailMessage(webhook: {
    from: string;
    to: string;
    subject: string;
    body: string;
    attachments?: { filename: string; url: string }[];
    threadId?: string;
  }): IncomingMessage {
    return {
      source: 'EMAIL',
      timestamp: new Date(),
      content: {
        type: 'EMAIL',
        ...webhook,
      },
    };
  }

  /**
   * Create SMS message from webhook payload.
   */
  static createSMSMessage(webhook: {
    from: string;
    message: string;
  }): IncomingMessage {
    return {
      source: 'SMS',
      timestamp: new Date(),
      content: {
        type: 'SMS',
        ...webhook,
      },
    };
  }

  /**
   * Create user message from web UI.
   */
  static createUserMessage(
    userId: string,
    message: string,
    username?: string
  ): IncomingMessage {
    return {
      source: 'USER',
      timestamp: new Date(),
      content: {
        type: 'USER',
        userId,
        username,
        message,
      },
    };
  }

  /**
   * Create worker output message.
   */
  static createWorkerMessage(
    workerId: string,
    status: WorkerContent['status'],
    summary: string,
    details?: string,
    artifacts?: WorkerContent['artifacts']
  ): IncomingMessage {
    return {
      source: 'WORKER',
      timestamp: new Date(),
      content: {
        type: 'WORKER',
        workerId,
        status,
        summary,
        details,
        artifacts,
      },
    };
  }

  /**
   * Create system confirmation message.
   */
  static createSystemMessage(
    event: SystemContent['event'],
    message: string,
    data?: Record<string, unknown>
  ): IncomingMessage {
    return {
      source: 'SYSTEM',
      timestamp: new Date(),
      content: {
        type: 'SYSTEM',
        event,
        message,
        data,
      },
    };
  }
}
