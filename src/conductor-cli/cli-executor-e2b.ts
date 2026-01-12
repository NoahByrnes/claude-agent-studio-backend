/**
 * E2B CLI Executor
 *
 * Executes claude CLI commands inside E2B sandboxes.
 * Adapted from original CLI executor to work with E2B infrastructure.
 */

import { Sandbox } from 'e2b';
import type { CLIResponse, CLIStreamMessage } from './types.js';

export interface ExecuteOptions {
  sessionId?: string;        // Resume specific CLI session
  outputFormat?: 'json' | 'stream-json' | 'text';
  timeout?: number;          // ms
  appendSystemPrompt?: string;
  skipPermissions?: boolean; // Skip permission checks (for autonomous workers in sandboxes)
  model?: string;            // Claude model to use (default: claude-sonnet-4.5)
}

export class E2BCLIExecutor {
  private sandbox: Sandbox;
  private apiKey: string;

  constructor(sandbox: Sandbox, apiKey?: string) {
    this.sandbox = sandbox;
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
  }

  /**
   * Execute a prompt and get structured response.
   */
  async execute(prompt: string, options: ExecuteOptions = {}): Promise<CLIResponse> {
    const args = this.buildArgs(prompt, { ...options, outputFormat: 'json' });
    const command = `claude ${args.join(' ')}`;

    // Default timeout: 10 minutes for workers doing research/complex tasks
    const timeout = options.timeout || 600000;

    const result = await this.sandbox.commands.run(command, {
      envs: {
        ANTHROPIC_API_KEY: this.apiKey,
      },
      timeoutMs: timeout,
    });

    if (result.exitCode !== 0) {
      throw new Error(`CLI command failed: ${result.stderr}`);
    }

    try {
      return JSON.parse(result.stdout) as CLIResponse;
    } catch {
      // If parsing fails, construct a response
      return {
        type: 'result',
        subtype: 'success',
        session_id: '',
        total_cost_usd: 0,
        is_error: false,
        duration_ms: 0,
        num_turns: 1,
        result: result.stdout,
      };
    }
  }

  /**
   * Execute and stream all messages.
   * Note: Streaming in E2B is limited - we get full output at end.
   * For true streaming, use WebSocket to E2B sandbox.
   */
  async *executeStream(
    prompt: string,
    options: ExecuteOptions = {}
  ): AsyncGenerator<CLIStreamMessage> {
    const args = this.buildArgs(prompt, { ...options, outputFormat: 'stream-json' });
    const command = `claude ${args.join(' ')}`;

    // Default timeout: 10 minutes for workers doing research/complex tasks
    const timeout = options.timeout || 600000;

    // Start command in background
    const handle = await this.sandbox.commands.run(command, {
      background: true,
      envs: {
        ANTHROPIC_API_KEY: this.apiKey,
      },
      timeoutMs: timeout,
    });

    // Wait for completion
    const result = await handle.wait();

    if (result.exitCode !== 0) {
      throw new Error(`CLI command failed: ${result.stderr}`);
    }

    // Parse NDJSON output
    const lines = result.stdout.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        try {
          yield JSON.parse(line) as CLIStreamMessage;
        } catch {
          // Skip non-JSON lines
        }
      }
    }
  }

  /**
   * Start a new CLI session and return its ID.
   */
  async startSession(systemPrompt: string, options: ExecuteOptions = {}): Promise<string> {
    const response = await this.execute(systemPrompt, options);
    return response.session_id;
  }

  /**
   * Send a message to an existing CLI session.
   */
  async sendToSession(
    sessionId: string,
    message: string,
    options: ExecuteOptions = {}
  ): Promise<CLIResponse> {
    return this.execute(message, { ...options, sessionId });
  }

  /**
   * Build CLI arguments.
   */
  private buildArgs(prompt: string, options: ExecuteOptions): string[] {
    const args: string[] = ['-p']; // Print mode (non-interactive)

    // Model selection (default to Sonnet 4.5)
    const model = options.model || 'claude-sonnet-4.5';
    args.push('--model', model);

    // Skip permissions for autonomous workers in sandboxes
    if (options.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    // Resume session if specified
    if (options.sessionId) {
      args.push('--resume', options.sessionId);
    }

    // Output format
    if (options.outputFormat) {
      args.push('--output-format', options.outputFormat);
    }

    // Append system prompt
    if (options.appendSystemPrompt) {
      args.push('--append-system-prompt', options.appendSystemPrompt);
    }

    // The prompt itself (escape for shell)
    const escaped = prompt.replace(/'/g, "'\"'\"'");
    args.push(`'${escaped}'`);

    return args;
  }

  /**
   * Get the E2B sandbox this executor is using.
   */
  getSandbox(): Sandbox {
    return this.sandbox;
  }
}
