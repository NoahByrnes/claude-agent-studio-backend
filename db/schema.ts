import { pgTable, uuid, varchar, text, jsonb, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Enums
export const agentStatusEnum = pgEnum('agent_status', ['idle', 'running', 'stopped', 'error', 'deploying']);

// Agents Table
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  user_id: uuid('user_id').notNull(), // Supabase user ID
  name: varchar('name', { length: 255 }).notNull(),
  status: agentStatusEnum('status').notNull().default('idle'),
  config: jsonb('config').notNull(),
  created_at: timestamp('created_at').notNull().defaultNow(),
  updated_at: timestamp('updated_at').notNull().defaultNow(),
});

// Sessions Table
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  agent_id: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  session_id: varchar('session_id', { length: 255 }).notNull(),
  state: jsonb('state').notNull().default({}),
  last_active: timestamp('last_active').notNull().defaultNow(),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

// Audit Logs Table
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  agent_id: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  session_id: varchar('session_id', { length: 255 }),
  action_type: varchar('action_type', { length: 100 }).notNull(),
  tool_name: varchar('tool_name', { length: 100 }),
  input_data: jsonb('input_data'),
  output_data: jsonb('output_data'),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
});

// MCP Connectors Table
export const mcpConnectors = pgTable('mcp_connectors', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: varchar('name', { length: 100 }).notNull(),
  url: text('url').notNull(),
  permissions: jsonb('permissions').notNull().default([]),
  credentials_vault_path: text('credentials_vault_path'),
  created_at: timestamp('created_at').notNull().defaultNow(),
  updated_at: timestamp('updated_at').notNull().defaultNow(),
});

// Agent Events Table (for tracking incoming events)
export const agentEvents = pgTable('agent_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  agent_id: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  event_type: varchar('event_type', { length: 50 }).notNull(),
  payload: jsonb('payload').notNull(),
  processed: timestamp('processed'),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

// Orchestration Status Enum
export const orchestrationStatusEnum = pgEnum('orchestration_status', [
  'pending',
  'triaging',
  'spawning',
  'running',
  'validating',
  'retrying',
  'finalizing',
  'completed',
  'failed',
  'escalated',
]);

// Orchestrations Table (conductor tracking)
export const orchestrations = pgTable('orchestrations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  event_id: uuid('event_id').notNull(),
  status: orchestrationStatusEnum('status').notNull().default('pending'),
  current_task_id: uuid('current_task_id'),
  current_worker_id: uuid('current_worker_id'),
  triage_decision: jsonb('triage_decision'),
  validation_result: jsonb('validation_result'),
  final_result: jsonb('final_result'),
  attempts: jsonb('attempts').notNull().default([]),
  created_at: timestamp('created_at').notNull().defaultNow(),
  updated_at: timestamp('updated_at').notNull().defaultNow(),
  completed_at: timestamp('completed_at'),
});

// Tasks Table (worker tasks)
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orchestration_id: uuid('orchestration_id').notNull().references(() => orchestrations.id, { onDelete: 'cascade' }),
  event_id: uuid('event_id').notNull(),
  description: text('description').notNull(),
  instructions: text('instructions').notNull(),
  context: jsonb('context').notNull(),
  constraints: jsonb('constraints').notNull(),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

// Workers Table (worker instances)
export const workers = pgTable('workers', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  task_id: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  sandbox_id: varchar('sandbox_id', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('initializing'),
  result: jsonb('result'),
  error: text('error'),
  started_at: timestamp('started_at').notNull().defaultNow(),
  ended_at: timestamp('ended_at'),
});

// Type exports
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

export type MCPConnector = typeof mcpConnectors.$inferSelect;
export type NewMCPConnector = typeof mcpConnectors.$inferInsert;

export type AgentEvent = typeof agentEvents.$inferSelect;
export type NewAgentEvent = typeof agentEvents.$inferInsert;

export type Orchestration = typeof orchestrations.$inferSelect;
export type NewOrchestration = typeof orchestrations.$inferInsert;

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

export type Worker = typeof workers.$inferSelect;
export type NewWorker = typeof workers.$inferInsert;
