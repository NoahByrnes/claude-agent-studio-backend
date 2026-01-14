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
  model?: string;            // Claude model to use (default: claude-sonnet-4-5)
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

    // Log command structure (but not full prompt to avoid spam)
    const argsSummary = args.filter(a => !a.includes(prompt.substring(0, 50))).join(' ');
    console.log(`   🚀 Executing: claude ${argsSummary} '<prompt ${prompt.length} chars>'`);

    // No command-level timeout - let conductor manage worker lifecycle
    // Use sandbox lifetime as timeout (1 hour for Hobby tier)
    const timeout = options.timeout || 3600000; // 1 hour, matches sandbox lifetime

    let result;
    try {
      result = await this.sandbox.commands.run(command, {
        envs: {
          ANTHROPIC_API_KEY: this.apiKey,
        },
        timeoutMs: timeout,
      });
    } catch (error: any) {
      // E2B throws CommandExitError for non-zero exit codes
      console.error(`❌ CLI command failed with CommandExitError`);
      console.error(`   Command: ${command}`);
      console.error(`   Error:`, error);
      console.error(`   Error result:`, error.result);
      if (error.result) {
        console.error(`   Stderr: ${error.result.stderr || 'none'}`);
        console.error(`   Stdout: ${error.result.stdout || 'none'}`);
        console.error(`   Exit code: ${error.result.exitCode || 'unknown'}`);
        throw new Error(`CLI command failed (exit ${error.result.exitCode}): ${error.result.stderr || error.result.stdout || error.message}`);
      }
      throw error;
    }

    if (result.exitCode !== 0) {
      console.error(`❌ CLI command failed with exit code ${result.exitCode}`);
      console.error(`   Command: ${command}`);
      console.error(`   Stderr: ${result.stderr}`);
      console.error(`   Stdout: ${result.stdout}`);
      console.error(`   Full result:`, JSON.stringify(result, null, 2));
      throw new Error(`CLI command failed (exit ${result.exitCode}): ${result.stderr || result.stdout || 'Unknown error'}`);
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
   *
   * IMPORTANT: If no sessionId is provided, creates a NEW session that will END when stream completes.
   * To keep session alive, pass sessionId from startSession().
   */
  async *executeStream(
    prompt: string,
    options: ExecuteOptions = {}
  ): AsyncGenerator<CLIStreamMessage> {
    const args = this.buildArgs(prompt, { ...options, outputFormat: 'stream-json' });
    const command = `claude ${args.join(' ')}`;

    // No command-level timeout - let conductor manage worker lifecycle
    // Use sandbox lifetime as timeout (1 hour for Hobby tier)
    const timeout = options.timeout || 3600000; // 1 hour, matches sandbox lifetime

    const isNewSession = !options.sessionId;
    console.log(`   🚀 Starting CLI stream command (${isNewSession ? 'NEW session' : 'resume session ' + options.sessionId?.substring(0, 8)})`);

    // Start command in background
    const handle = await this.sandbox.commands.run(command, {
      background: true,
      envs: {
        ANTHROPIC_API_KEY: this.apiKey,
      },
      timeoutMs: timeout,
    });

    console.log(`   ⏳ Waiting for CLI command to complete...`);

    // Wait for completion
    let result;
    try {
      result = await handle.wait();
    } catch (error: any) {
      // E2B throws CommandExitError for non-zero exit codes
      console.error(`❌ CLI stream command failed with CommandExitError`);
      console.error(`   Command: ${command}`);
      console.error(`   Error:`, error);
      console.error(`   Error result:`, error.result);
      if (error.result) {
        console.error(`   Stderr: ${error.result.stderr || 'none'}`);
        console.error(`   Stdout: ${error.result.stdout || 'none'}`);
        console.error(`   Exit code: ${error.result.exitCode || 'unknown'}`);
        throw new Error(`CLI command failed (exit ${error.result.exitCode}): ${error.result.stderr || error.result.stdout || error.message}`);
      }
      throw error;
    }

    if (result.exitCode !== 0) {
      console.error(`❌ CLI stream command failed with exit code ${result.exitCode}`);
      console.error(`   Command: ${command}`);
      console.error(`   Stderr: ${result.stderr}`);
      console.error(`   Stdout: ${result.stdout}`);
      throw new Error(`CLI command failed (exit ${result.exitCode}): ${result.stderr || result.stdout || 'Unknown error'}`);
    }

    // Parse NDJSON output
    const lines = result.stdout.split('\n');
    console.log(`   📜 CLI stream returned ${lines.length} lines`);

    let validMessages = 0;
    for (const line of lines) {
      if (line.trim()) {
        try {
          const parsed = JSON.parse(line) as CLIStreamMessage;
          validMessages++;
          yield parsed;
        } catch (error) {
          console.log(`   ⚠️  Skipping non-JSON line: ${line.substring(0, 100)}`);
        }
      }
    }

    console.log(`   ✅ Parsed ${validMessages} valid JSON messages from stream`);
  }

  /**
   * Start a new CLI session and return its ID.
   */
  async startSession(systemPrompt: string, options: ExecuteOptions = {}): Promise<string> {
    console.log(`   📋 Starting CLI session with system prompt (${systemPrompt.length} chars)`);
    console.log(`   First 200 chars: ${systemPrompt.substring(0, 200)}...`);
    console.log(`   Last 200 chars: ...${systemPrompt.substring(systemPrompt.length - 200)}`);

    const response = await this.execute(systemPrompt, options);
    console.log(`   ✅ CLI session started: ${response.session_id}`);
    return response.session_id;
  }

  /**
   * Start a new CLI session with streaming, keeping session alive for follow-ups.
   * Returns an async generator that yields: [sessionId, ...stream messages]
   *
   * Usage for workers:
   *   for await (const message of executor.startSessionWithStream(prompt, options)) {
   *     if (message.type === 'init' && message.session_id) {
   *       sessionId = message.session_id; // Save for follow-ups!
   *     }
   *     // Process other messages...
   *   }
   *   // Session remains alive! Use sendToSession() for follow-ups
   */
  async *startSessionWithStream(
    systemPrompt: string,
    options: ExecuteOptions = {}
  ): AsyncGenerator<CLIStreamMessage> {
    console.log(`   📋 Starting CLI session WITH STREAMING (${systemPrompt.length} chars)`);
    console.log(`   Session will remain alive after stream completes`);

    // Use executeStream WITHOUT sessionId to create new session
    // But we'll track the session ID from the stream and document it stays alive
    for await (const message of this.executeStream(systemPrompt, options)) {
      yield message;
    }

    console.log(`   ✅ Session stream completed. Session remains ALIVE for follow-ups`);
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

    // Model selection (default to Sonnet 4-5)
    const model = options.model || 'claude-sonnet-4-5';
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
      // stream-json requires --verbose in print mode
      if (options.outputFormat === 'stream-json') {
        args.push('--verbose');
      }
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
