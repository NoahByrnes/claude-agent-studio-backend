/**
 * Command Parser
 *
 * Parses conductor output to extract infrastructure commands.
 * The conductor uses slash commands that our infrastructure executes.
 */

import type {
  ParsedCommand,
  SpawnWorkerCommand,
  MessageWorkerCommand,
  KillWorkerCommand,
  SendEmailCommand,
  SendSMSCommand,
  ListWorkersCommand,
  WorkerStatusCommand,
} from './types';

export class CommandParser {
  /**
   * Parse a line or block of output for commands.
   * Returns all commands found.
   */
  parseAll(output: string): ParsedCommand[] {
    const commands: ParsedCommand[] = [];
    const lines = output.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Try to parse each line as a command
      const command = this.parseLine(line, lines, i);
      if (command) {
        commands.push(command);
      }
    }

    return commands;
  }

  /**
   * Parse a single line for a command.
   */
  parseLine(line: string, allLines: string[], index: number): ParsedCommand | null {
    if (!line.startsWith('/')) {
      return null;
    }

    // /spawn-worker <task>
    if (line.startsWith('/spawn-worker ')) {
      return this.parseSpawnWorker(line, allLines, index);
    }

    // /message-worker <id> <message>
    if (line.startsWith('/message-worker ')) {
      return this.parseMessageWorker(line);
    }

    // /kill-worker <id>
    if (line.startsWith('/kill-worker ')) {
      return this.parseKillWorker(line);
    }

    // /send-email <to> "<subject>" "<body>"
    if (line.startsWith('/send-email ')) {
      return this.parseSendEmail(line, allLines, index);
    }

    // /send-sms <to> <message>
    if (line.startsWith('/send-sms ')) {
      return this.parseSendSMS(line);
    }

    // /list-workers
    if (line === '/list-workers') {
      return { type: 'list-workers', raw: line };
    }

    // /worker-status <id>
    if (line.startsWith('/worker-status ')) {
      return this.parseWorkerStatus(line);
    }

    return null;
  }

  /**
   * Parse /spawn-worker command.
   * Can be multi-line:
   * /spawn-worker Update pricing.
   *   Change Basic to $29.
   *   Create PR when done.
   */
  private parseSpawnWorker(
    line: string,
    allLines: string[],
    index: number
  ): SpawnWorkerCommand {
    const taskStart = '/spawn-worker '.length;
    let task = line.slice(taskStart);

    // Check for multi-line task (indented continuation)
    for (let i = index + 1; i < allLines.length; i++) {
      const nextLine = allLines[i];
      // If line starts with whitespace, it's a continuation
      if (nextLine.match(/^\s+\S/)) {
        task += '\n' + nextLine.trim();
      } else {
        break;
      }
    }

    return {
      type: 'spawn-worker',
      task: task.trim(),
      raw: line,
    };
  }

  /**
   * Parse /message-worker <id> <message>
   */
  private parseMessageWorker(line: string): MessageWorkerCommand {
    const rest = line.slice('/message-worker '.length);
    const spaceIndex = rest.indexOf(' ');

    if (spaceIndex === -1) {
      throw new Error(`Invalid /message-worker command: ${line}`);
    }

    const workerId = rest.slice(0, spaceIndex);
    const message = rest.slice(spaceIndex + 1);

    return {
      type: 'message-worker',
      workerId,
      message,
      raw: line,
    };
  }

  /**
   * Parse /kill-worker <id>
   */
  private parseKillWorker(line: string): KillWorkerCommand {
    const workerId = line.slice('/kill-worker '.length).trim();

    return {
      type: 'kill-worker',
      workerId,
      raw: line,
    };
  }

  /**
   * Parse /send-email <to> "<subject>" "<body>"
   * Also supports multi-line body:
   * /send-email client@example.com "Subject"
   *   Body line 1
   *   Body line 2
   */
  private parseSendEmail(
    line: string,
    allLines: string[],
    index: number
  ): SendEmailCommand {
    const rest = line.slice('/send-email '.length);

    // Extract email address (first token)
    const toMatch = rest.match(/^(\S+)\s+/);
    if (!toMatch) {
      throw new Error(`Invalid /send-email command: ${line}`);
    }

    const to = toMatch[1];
    const afterTo = rest.slice(toMatch[0].length);

    // Parse quoted subject and body
    const { subject, body } = this.parseQuotedArgs(afterTo, allLines, index);

    return {
      type: 'send-email',
      to,
      subject,
      body,
      raw: line,
    };
  }

  /**
   * Parse /send-sms <to> <message>
   */
  private parseSendSMS(line: string): SendSMSCommand {
    const rest = line.slice('/send-sms '.length);
    const spaceIndex = rest.indexOf(' ');

    if (spaceIndex === -1) {
      throw new Error(`Invalid /send-sms command: ${line}`);
    }

    const to = rest.slice(0, spaceIndex);
    const message = rest.slice(spaceIndex + 1);

    return {
      type: 'send-sms',
      to,
      message: this.unquote(message),
      raw: line,
    };
  }

  /**
   * Parse /worker-status <id>
   */
  private parseWorkerStatus(line: string): WorkerStatusCommand {
    const workerId = line.slice('/worker-status '.length).trim();

    return {
      type: 'worker-status',
      workerId,
      raw: line,
    };
  }

  /**
   * Parse quoted arguments like "subject" "body"
   */
  private parseQuotedArgs(
    input: string,
    allLines: string[],
    index: number
  ): { subject: string; body: string } {
    const tokens = this.tokenizeQuoted(input);

    if (tokens.length >= 2) {
      return {
        subject: tokens[0],
        body: tokens[1],
      };
    }

    if (tokens.length === 1) {
      // Subject only, check for multi-line body
      let body = '';
      for (let i = index + 1; i < allLines.length; i++) {
        const nextLine = allLines[i];
        if (nextLine.match(/^\s+\S/)) {
          body += (body ? '\n' : '') + nextLine.trim();
        } else {
          break;
        }
      }

      return {
        subject: tokens[0],
        body,
      };
    }

    return { subject: '', body: input };
  }

  /**
   * Tokenize a string respecting quotes.
   */
  private tokenizeQuoted(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < input.length; i++) {
      const char = input[i];

      if (!inQuotes && (char === '"' || char === "'")) {
        inQuotes = true;
        quoteChar = char;
      } else if (inQuotes && char === quoteChar) {
        inQuotes = false;
        tokens.push(current);
        current = '';
        quoteChar = '';
      } else if (!inQuotes && char === ' ') {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      tokens.push(current);
    }

    return tokens;
  }

  /**
   * Remove surrounding quotes from a string.
   */
  private unquote(str: string): string {
    const trimmed = str.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }
}
