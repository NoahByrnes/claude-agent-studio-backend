/**
 * Tool definitions for the conductor agent.
 * These follow Anthropic's tool use specification.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * Tool for spawning a new worker agent to handle a subtask.
 */
export const spawnWorkerTool: ToolDefinition = {
  name: 'spawn_worker',
  description: `Spawns a new autonomous worker agent in an isolated E2B sandbox to handle a specific task.
The worker will have full access to Claude CLI tools and runs independently.
Use this for any non-trivial work that requires code execution, data analysis, or multi-step operations.
The worker will report back when complete.`,
  input_schema: {
    type: 'object',
    properties: {
      task_description: {
        type: 'string',
        description: 'Detailed description of what the worker should accomplish. Be specific about inputs, expected outputs, and success criteria.',
      },
      context: {
        type: 'string',
        description: 'Additional context the worker needs (data locations, requirements, constraints, etc.)',
      },
    },
    required: ['task_description'],
  },
};

/**
 * Tool for sending emails to external recipients.
 */
export const sendEmailTool: ToolDefinition = {
  name: 'send_email',
  description: 'Sends an email to a recipient via SendGrid. Use this to respond to clients or send reports.',
  input_schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Email address of the recipient',
      },
      subject: {
        type: 'string',
        description: 'Email subject line',
      },
      body: {
        type: 'string',
        description: 'Email body content (plain text or HTML)',
      },
      reply_to: {
        type: 'string',
        description: 'Optional reply-to address',
      },
    },
    required: ['to', 'subject', 'body'],
  },
};

/**
 * Tool for sending SMS messages.
 */
export const sendSmsTool: ToolDefinition = {
  name: 'send_sms',
  description: 'Sends an SMS text message to a phone number via Twilio. Use for urgent notifications or responses.',
  input_schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Phone number in E.164 format (e.g., +1234567890)',
      },
      message: {
        type: 'string',
        description: 'SMS message content (max 1600 characters)',
      },
    },
    required: ['to', 'message'],
  },
};

/**
 * Tool for terminating a worker agent.
 */
export const killWorkerTool: ToolDefinition = {
  name: 'kill_worker',
  description: 'Terminates a running worker agent and cleans up its E2B sandbox. Use when work is complete or needs to be aborted.',
  input_schema: {
    type: 'object',
    properties: {
      worker_id: {
        type: 'string',
        description: 'The ID of the worker to terminate',
      },
      reason: {
        type: 'string',
        description: 'Reason for termination (for logging)',
      },
    },
    required: ['worker_id'],
  },
};

/**
 * All conductor tools combined.
 */
export const conductorTools: ToolDefinition[] = [
  spawnWorkerTool,
  sendEmailTool,
  sendSmsTool,
  killWorkerTool,
];

/**
 * Tool result type for handling tool execution results.
 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
