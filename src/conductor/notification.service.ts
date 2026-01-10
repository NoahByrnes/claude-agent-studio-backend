/**
 * Notification Service
 *
 * Handles sending responses back through various channels:
 * - Email (via Resend, SendGrid, etc.)
 * - Slack (via Slack API)
 * - Webhooks (HTTP callbacks)
 */

import type {
  IncomingEvent,
  WorkerResult,
  EmailEvent,
  SlackEvent,
} from "./types";

interface EmailProvider {
  send(params: {
    to: string;
    from: string;
    subject: string;
    body: string;
    html?: string;
    replyTo?: string;
    inReplyTo?: string;
  }): Promise<{ messageId: string }>;
}

interface SlackProvider {
  postMessage(params: {
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: any[];
  }): Promise<{ ts: string }>;
}

export class NotificationService {
  private emailProvider?: EmailProvider;
  private slackProvider?: SlackProvider;
  private defaultFromEmail: string;

  constructor(options?: {
    emailProvider?: EmailProvider;
    slackProvider?: SlackProvider;
    defaultFromEmail?: string;
  }) {
    this.emailProvider = options?.emailProvider;
    this.slackProvider = options?.slackProvider;
    this.defaultFromEmail = options?.defaultFromEmail || "agent@example.com";
  }

  /**
   * Send a response based on the original event type.
   */
  async respond(event: IncomingEvent, result: WorkerResult): Promise<void> {
    switch (event.type) {
      case "email":
        await this.respondToEmail(event.payload as EmailEvent, result);
        break;

      case "slack":
        await this.respondToSlack(event.payload as SlackEvent, result);
        break;

      case "webhook":
        // Webhooks typically don't need a response sent back
        console.log(`Webhook event ${event.id} completed, no response needed`);
        break;

      case "scheduled":
        // Scheduled events might trigger a notification
        await this.notifyScheduledComplete(event, result);
        break;

      default:
        console.log(`Unknown event type ${event.type}, no response sent`);
    }
  }

  /**
   * Send an email reply.
   */
  private async respondToEmail(
    originalEmail: EmailEvent,
    result: WorkerResult
  ): Promise<void> {
    if (!this.emailProvider) {
      console.warn("No email provider configured, skipping email response");
      this.logWouldSendEmail(originalEmail, result);
      return;
    }

    // Use the suggested response if available, otherwise generate one
    const responseBody = result.suggestedResponse?.body || this.generateEmailResponse(result);
    const responseSubject = result.suggestedResponse?.subject ||
      (originalEmail.subject.startsWith("Re:")
        ? originalEmail.subject
        : `Re: ${originalEmail.subject}`);

    try {
      const { messageId } = await this.emailProvider.send({
        to: originalEmail.from,
        from: this.defaultFromEmail,
        subject: responseSubject,
        body: responseBody,
        replyTo: this.defaultFromEmail,
        inReplyTo: originalEmail.threadId,
      });

      console.log(`Sent email response: ${messageId}`);
    } catch (error) {
      console.error("Failed to send email response:", error);
      throw error;
    }
  }

  /**
   * Post a Slack reply.
   */
  private async respondToSlack(
    originalMessage: SlackEvent,
    result: WorkerResult
  ): Promise<void> {
    if (!this.slackProvider) {
      console.warn("No Slack provider configured, skipping Slack response");
      this.logWouldSendSlack(originalMessage, result);
      return;
    }

    const responseText = result.suggestedResponse?.body || this.generateSlackResponse(result);

    try {
      const { ts } = await this.slackProvider.postMessage({
        channel: originalMessage.channel,
        text: responseText,
        threadTs: originalMessage.threadTs, // Reply in thread if applicable
      });

      console.log(`Posted Slack response: ${ts}`);
    } catch (error) {
      console.error("Failed to post Slack response:", error);
      throw error;
    }
  }

  /**
   * Notify about a completed scheduled task.
   */
  private async notifyScheduledComplete(
    event: IncomingEvent,
    result: WorkerResult
  ): Promise<void> {
    // Could send to a designated notification channel
    console.log(`Scheduled task ${event.id} completed: ${result.summary}`);

    // If there's an email configured for notifications, send it
    if (process.env.NOTIFICATION_EMAIL && this.emailProvider) {
      await this.emailProvider.send({
        to: process.env.NOTIFICATION_EMAIL,
        from: this.defaultFromEmail,
        subject: `Scheduled Task Completed: ${result.summary.substring(0, 50)}`,
        body: `A scheduled task has been completed.\n\n${result.summary}\n\nArtifacts: ${result.artifacts.length}`,
      });
    }
  }

  /**
   * Generate a default email response from the result.
   */
  private generateEmailResponse(result: WorkerResult): string {
    let response = `${result.summary}\n\n`;

    if (result.artifacts.length > 0) {
      response += "Attachments/Links:\n";
      for (const artifact of result.artifacts) {
        if (artifact.url) {
          response += `- ${artifact.name}: ${artifact.url}\n`;
        } else {
          response += `- ${artifact.name} (${artifact.type})\n`;
        }
      }
      response += "\n";
    }

    if (result.actions.length > 0) {
      response += "Actions taken:\n";
      for (const action of result.actions) {
        response += `- ${action.action}: ${action.result}\n`;
      }
    }

    return response;
  }

  /**
   * Generate a default Slack response from the result.
   */
  private generateSlackResponse(result: WorkerResult): string {
    let response = result.summary;

    if (result.artifacts.length > 0) {
      response += "\n\n*Artifacts:*";
      for (const artifact of result.artifacts) {
        if (artifact.url) {
          response += `\n• <${artifact.url}|${artifact.name}>`;
        } else {
          response += `\n• ${artifact.name}`;
        }
      }
    }

    return response;
  }

  /**
   * Log what would be sent (for debugging when no provider is configured).
   */
  private logWouldSendEmail(original: EmailEvent, result: WorkerResult): void {
    console.log("=== Would Send Email ===");
    console.log(`To: ${original.from}`);
    console.log(`Subject: Re: ${original.subject}`);
    console.log(`Body:\n${this.generateEmailResponse(result)}`);
    console.log("========================");
  }

  private logWouldSendSlack(original: SlackEvent, result: WorkerResult): void {
    console.log("=== Would Send Slack ===");
    console.log(`Channel: ${original.channel}`);
    console.log(`Thread: ${original.threadTs || "new thread"}`);
    console.log(`Message:\n${this.generateSlackResponse(result)}`);
    console.log("========================");
  }

  // ============================================================================
  // Direct Send Methods (for conductor to use directly)
  // ============================================================================

  /**
   * Send an email directly (not as a response to an event).
   */
  async sendEmail(params: {
    to: string;
    subject: string;
    body: string;
    html?: string;
  }): Promise<void> {
    if (!this.emailProvider) {
      console.warn("No email provider configured");
      console.log(`Would send email to ${params.to}: ${params.subject}`);
      return;
    }

    await this.emailProvider.send({
      ...params,
      from: this.defaultFromEmail,
    });
  }

  /**
   * Post to Slack directly (not as a response to an event).
   */
  async postSlack(params: {
    channel: string;
    text: string;
    threadTs?: string;
  }): Promise<void> {
    if (!this.slackProvider) {
      console.warn("No Slack provider configured");
      console.log(`Would post to ${params.channel}: ${params.text}`);
      return;
    }

    await this.slackProvider.postMessage(params);
  }
}
