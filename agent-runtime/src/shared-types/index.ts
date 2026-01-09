import { z } from 'zod';

// Agent Status
export const AgentStatus = z.enum(['idle', 'running', 'stopped', 'error', 'deploying']);
export type AgentStatus = z.infer<typeof AgentStatus>;

// MCP Server Configuration
export const MCPServerConfig = z.object({
  name: z.string(),
  url: z.string().url(),
  permissions: z.array(z.string()),
});
export type MCPServerConfig = z.infer<typeof MCPServerConfig>;

// Hook Configuration
export const HookConfig = z.object({
  type: z.enum(['PreTurn', 'PostTurn', 'PreToolUse', 'PostToolUse']),
  handler: z.string(),
});
export type HookConfig = z.infer<typeof HookConfig>;

// Deployment Configuration
export const DeploymentConfig = z.object({
  type: z.enum(['long-running', 'event-driven']),
  sandbox: z.enum(['cloudflare', 'e2b', 'local']),
  auto_restart: z.boolean(),
});
export type DeploymentConfig = z.infer<typeof DeploymentConfig>;

// Agent Configuration
export const AgentConfig = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  system_prompt: z.string().min(1),
  model: z.string().default('claude-sonnet-4-5'),
  temperature: z.number().min(0).max(1).default(0.2),
  max_turns: z.number().int().positive().optional(),
  mcp_servers: z.array(MCPServerConfig),
  hooks: z.array(HookConfig).optional(),
  deployment: DeploymentConfig,
});
export type AgentConfig = z.infer<typeof AgentConfig>;

// Agent Entity
export const Agent = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: AgentStatus,
  config: AgentConfig,
  created_at: z.date(),
  updated_at: z.date(),
});
export type Agent = z.infer<typeof Agent>;

// Session
export const Session = z.object({
  id: z.string().uuid(),
  agent_id: z.string().uuid(),
  session_id: z.string(),
  state: z.record(z.unknown()),
  last_active: z.date(),
  created_at: z.date(),
});
export type Session = z.infer<typeof Session>;

// Audit Log
export const AuditLog = z.object({
  id: z.string().uuid(),
  agent_id: z.string().uuid(),
  session_id: z.string().optional(),
  action_type: z.string(),
  tool_name: z.string().optional(),
  input_data: z.record(z.unknown()).optional(),
  output_data: z.record(z.unknown()).optional(),
  timestamp: z.date(),
});
export type AuditLog = z.infer<typeof AuditLog>;

// API Request/Response Types
export const CreateAgentRequest = AgentConfig;
export type CreateAgentRequest = z.infer<typeof CreateAgentRequest>;

export const UpdateAgentRequest = AgentConfig.partial();
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequest>;

export const AgentResponse = Agent;
export type AgentResponse = z.infer<typeof AgentResponse>;

export const AgentListResponse = z.object({
  agents: z.array(Agent),
  total: z.number(),
});
export type AgentListResponse = z.infer<typeof AgentListResponse>;

export const DeployAgentRequest = z.object({
  agent_id: z.string().uuid(),
});
export type DeployAgentRequest = z.infer<typeof DeployAgentRequest>;

export const LogsRequest = z.object({
  agent_id: z.string().uuid(),
  limit: z.number().int().positive().default(100),
  offset: z.number().int().nonnegative().default(0),
  action_type: z.string().optional(),
  tool_name: z.string().optional(),
});
export type LogsRequest = z.infer<typeof LogsRequest>;

export const LogsResponse = z.object({
  logs: z.array(AuditLog),
  total: z.number(),
});
export type LogsResponse = z.infer<typeof LogsResponse>;

export const MetricsResponse = z.object({
  agent_id: z.string().uuid(),
  tasks_completed: z.number(),
  tasks_failed: z.number(),
  uptime_seconds: z.number(),
  last_active: z.date().nullable(),
});
export type MetricsResponse = z.infer<typeof MetricsResponse>;

// Event Types
export const AgentEvent = z.object({
  id: z.string().uuid(),
  agent_id: z.string().uuid(),
  event_type: z.enum(['email', 'sms', 'webhook', 'scheduled']),
  payload: z.record(z.unknown()),
  timestamp: z.date(),
});
export type AgentEvent = z.infer<typeof AgentEvent>;

// Error Response
export const ErrorResponse = z.object({
  error: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
