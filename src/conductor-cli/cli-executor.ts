/**
 * CLI Executor
 *
 * Executes claude CLI commands and parses responses.
 * Uses -p (print mode) with --resume for session management.
 */

import { spawn } from 'child_process';
import type { CLIResponse, CLIStreamMessage } from './types';

export interface ExecuteOptions {
  sessionId?: string;        // Resume specific session
  outputFormat?: 'json' | 'stream-json' | 'text';
  workingDirectory?: string;
  timeout?: number;          // ms
  appendSystemPrompt?: string;
}

export class CLIExecutor {
  private defaultWorkingDirectory: string;

  constructor(workingDirectory?: string) {
    this.defaultWorkingDirectory = workingDirectory || process.cwd();
  }

  /**
   * Execute a prompt and get structured response.
   */
  async execute(prompt: string, options: ExecuteOptions = {}): Promise<CLIResponse> {
    const args = this.buildArgs(prompt, { ...options, outputFormat: 'json' });
    const result = await this.runCommand(args, options);

    try {
      return JSON.parse(result) as CLIResponse;
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
        result: result,
      };
    }
  }

  /**
   * Execute and stream all messages.
   */
  async *executeStream(
    prompt: string,
    options: ExecuteOptions = {}
  ): AsyncGenerator<CLIStreamMessage> {
    const args = this.buildArgs(prompt, { ...options, outputFormat: 'stream-json' });
    const cwd = options.workingDirectory || this.defaultWorkingDirectory;

    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env },
    });

    let buffer = '';

    for await (const chunk of proc.stdout) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

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

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer) as CLIStreamMessage;
      } catch {
        // Skip
      }
    }

    // Wait for process to exit
    await new Promise<void>((resolve, reject) => {
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`claude exited with code ${code}`));
      });
    });
  }

  /**
   * Start a new session and return its ID.
   */
  async startSession(systemPrompt: string, options: ExecuteOptions = {}): Promise<string> {
    const response = await this.execute(systemPrompt, options);
    return response.session_id;
  }

  /**
   * Send a message to an existing session.
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

    // The prompt itself
    args.push(prompt);

    return args;
  }

  /**
   * Run the claude command and return stdout.
   */
  private async runCommand(args: string[], options: ExecuteOptions): Promise<string> {
    const cwd = options.workingDirectory || this.defaultWorkingDirectory;
    const timeout = options.timeout || 300000; // 5 minutes default

    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, {
        cwd,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`claude exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
