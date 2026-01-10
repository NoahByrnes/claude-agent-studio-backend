import Anthropic from '@anthropic-ai/sdk';
import type { Agent } from '../../db/schema.js';
import type { AgentConfig } from '../shared-types/index.js';
import { AuditService } from './audit.service.js';
import { SessionService } from './session.service.js';

export interface ExecutionContext {
  agent: Agent;
  sessionId: string;
  event?: {
    type: string;
    payload: Record<string, unknown>;
  };
}

export interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  toolsUsed?: string[];
  turnsCompleted?: number;
}

export class AgentExecutorService {
  private client: Anthropic;
  private auditService: AuditService;
  private sessionService: SessionService;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    this.client = new Anthropic({ apiKey });
    this.auditService = new AuditService();
    this.sessionService = new SessionService();
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const { agent, sessionId, event } = context;
    const config = agent.config as AgentConfig;

    try {
      // Log execution start
      await this.auditService.log({
        agent_id: agent.id,
        session_id: sessionId,
        action_type: 'execution_start',
        input_data: {
          event_type: event?.type,
          event_payload: event?.payload,
        },
      });

      // Get or create session state
      let session = await this.sessionService.getBySessionId(sessionId, agent.id);
      if (!session) {
        session = await this.sessionService.create(agent.id, sessionId);
      }

      // Build system prompt
      const systemPrompt = this.buildSystemPrompt(config, event);

      // Build initial user message if there's an event
      const userMessage = event ? this.buildEventMessage(event) : 'Ready to assist.';

      // Execute conversation with Claude
      const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: userMessage },
      ];

      let turnsCompleted = 0;
      const maxTurns = config.max_turns || 10;
      const toolsUsed: string[] = [];
      let finalResponse = '';

      while (turnsCompleted < maxTurns) {
        const response = await this.client.messages.create({
          model: config.model,
          max_tokens: 4096,
          temperature: config.temperature,
          system: systemPrompt,
          messages: messages,
          tools: this.buildTools(config),
        });

        turnsCompleted++;

        // Log the response
        await this.auditService.log({
          agent_id: agent.id,
          session_id: sessionId,
          action_type: 'llm_response',
          input_data: {
            turn: turnsCompleted,
            stop_reason: response.stop_reason,
          },
          output_data: {
            content: response.content,
          },
        });

        // Handle stop reason
        if (response.stop_reason === 'end_turn') {
          // Extract final text response
          const textContent = response.content.find((c) => c.type === 'text');
          if (textContent && 'text' in textContent) {
            finalResponse = textContent.text;
          }
          break;
        }

        if (response.stop_reason === 'tool_use') {
          // Process tool uses
          const toolResults: Anthropic.MessageParam[] = [];

          for (const content of response.content) {
            if (content.type === 'tool_use') {
              toolsUsed.push(content.name);

              // Log tool use
              await this.auditService.log({
                agent_id: agent.id,
                session_id: sessionId,
                action_type: 'tool_use',
                tool_name: content.name,
                input_data: content.input,
              });

              // Execute tool
              const toolResult = await this.executeTool(
                content.name,
                content.input,
                agent,
                sessionId
              );

              // Log tool result
              await this.auditService.log({
                agent_id: agent.id,
                session_id: sessionId,
                action_type: 'tool_result',
                tool_name: content.name,
                output_data: toolResult,
              });

              toolResults.push({
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: content.id,
                    content: JSON.stringify(toolResult),
                  },
                ],
              });
            }
          }

          // Add assistant response and tool results to conversation
          messages.push({
            role: 'assistant',
            content: response.content,
          });

          messages.push(...toolResults);

          continue;
        }

        if (response.stop_reason === 'max_tokens') {
          // Model hit token limit
          finalResponse = 'Response truncated due to token limit.';
          break;
        }

        // Unknown stop reason, break
        break;
      }

      // Update session state
      await this.sessionService.updateState(sessionId, agent.id, {
        last_execution: new Date().toISOString(),
        turns_completed: turnsCompleted,
        tools_used: toolsUsed,
      });

      // Log execution complete
      await this.auditService.log({
        agent_id: agent.id,
        session_id: sessionId,
        action_type: 'execution_complete',
        output_data: {
          turns_completed: turnsCompleted,
          tools_used: toolsUsed,
          response: finalResponse,
        },
      });

      return {
        success: true,
        output: finalResponse,
        toolsUsed,
        turnsCompleted,
      };
    } catch (error: any) {
      // Log execution error
      await this.auditService.log({
        agent_id: agent.id,
        session_id: sessionId,
        action_type: 'execution_error',
        output_data: {
          error: error.message,
          stack: error.stack,
        },
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }

  private buildSystemPrompt(config: AgentConfig, event?: ExecutionContext['event']): string {
    let prompt = config.system_prompt;

    if (event) {
      prompt += `\n\nYou have received a ${event.type} event. Process this event and take appropriate action.`;
    }

    return prompt;
  }

  private buildEventMessage(event: ExecutionContext['event']): string {
    return `New ${event.type} event received:\n\n${JSON.stringify(event.payload, null, 2)}`;
  }

  private buildTools(config: AgentConfig): Anthropic.Tool[] {
    // TODO: Implement MCP server integration to dynamically load tools
    // For now, return empty array
    return [];
  }

  private async executeTool(
    toolName: string,
    input: Record<string, unknown>,
    agent: Agent,
    sessionId: string
  ): Promise<Record<string, unknown>> {
    // TODO: Implement actual tool execution via MCP servers
    // For now, return a mock response
    return {
      success: true,
      message: `Tool ${toolName} executed successfully (mock)`,
      input,
    };
  }
}
