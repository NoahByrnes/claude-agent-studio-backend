import Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from './shared-types/index.js';
import { createAuditHook } from './hooks.js';

export interface AgentRuntimeOptions {
  config: AgentConfig;
  apiKey: string;
  backendUrl: string;
  agentId: string;
}

export class AgentRuntime {
  private client: Anthropic;
  private config: AgentConfig;
  private backendUrl: string;
  private agentId: string;

  constructor(options: AgentRuntimeOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
    });
    this.config = options.config;
    this.backendUrl = options.backendUrl;
    this.agentId = options.agentId;
  }

  async processEvent(event: any): Promise<void> {
    console.log(`🤖 Processing event for agent ${this.agentId}:`, event);

    try {
      // Build the messages for Claude
      const messages: Anthropic.MessageParam[] = [
        {
          role: 'user',
          content: this.formatEventAsMessage(event),
        },
      ];

      // Call Claude API
      const response = await this.client.messages.create({
        model: this.config.model || 'claude-sonnet-4-5',
        max_tokens: 4096,
        temperature: this.config.temperature || 0.2,
        system: this.config.system_prompt,
        messages,
      });

      console.log('✅ Claude response:', response);

      // Log the response via audit hook
      await this.auditLog('agent_response', {
        event,
        response: response.content,
      });
    } catch (error) {
      console.error('❌ Error processing event:', error);
      await this.auditLog('agent_error', {
        event,
        error: String(error),
      });
      throw error;
    }
  }

  private formatEventAsMessage(event: any): string {
    switch (event.eventType) {
      case 'email':
        return `New email received:\nFrom: ${event.payload.from}\nSubject: ${event.payload.subject}\n\nBody:\n${event.payload.body}`;
      case 'sms':
        return `New SMS received:\nFrom: ${event.payload.from}\nMessage: ${event.payload.message}`;
      case 'webhook':
        return `Webhook event received:\n${JSON.stringify(event.payload, null, 2)}`;
      case 'scheduled':
        return `Scheduled task triggered:\n${JSON.stringify(event.payload, null, 2)}`;
      default:
        return `Event received:\n${JSON.stringify(event, null, 2)}`;
    }
  }

  private async auditLog(actionType: string, data: any): Promise<void> {
    try {
      await fetch(`${this.backendUrl}/api/agents/${this.agentId}/audit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action_type: actionType,
          input_data: data,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (error) {
      console.error('Failed to send audit log:', error);
    }
  }
}

// Example standalone usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = new AgentRuntime({
    config: {
      name: 'Test Agent',
      system_prompt: 'You are a helpful assistant.',
      model: 'claude-sonnet-4-5',
      temperature: 0.2,
      mcp_servers: [],
      deployment: {
        type: 'event-driven',
        sandbox: 'local',
        auto_restart: false,
      },
    },
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    backendUrl: process.env.BACKEND_URL || 'http://localhost:3000',
    agentId: 'test-agent-id',
  });

  // Test event
  await runtime.processEvent({
    eventType: 'email',
    payload: {
      from: 'test@example.com',
      subject: 'Test Email',
      body: 'This is a test email.',
    },
  });
}
