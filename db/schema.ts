import { pgTable, uuid, varchar, text, jsonb, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Enums
export const agentStatusEnum = pgEnum('agent_status', ['idle', 'running', 'stopped', 'error', 'deploying']);
export const connectorTypeEnum = pgEnum('connector_type', ['email', 'sms', 'google_workspace']);

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

// Connector Configs Table (for email/SMS connector settings)
export const connectorConfigs = pgTable('connector_configs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  user_id: varchar('user_id', { length: 255 }).notNull(), // Supabase user ID or 'default-user' for MVP
  connector_type: connectorTypeEnum('connector_type').notNull(),
  settings: jsonb('settings').notNull(), // Encrypted credentials
  enabled: text('enabled').notNull().default('true'), // Using text to store 'true'/'false'
  created_at: timestamp('created_at').notNull().defaultNow(),
  updated_at: timestamp('updated_at').notNull().defaultNow(),
});

// Google Permissions Table (context-aware permissions)
export const googlePermissions = pgTable('google_permissions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  user_id: varchar('user_id', { length: 255 }).notNull(),
  resource_type: varchar('resource_type', { length: 50 }).notNull(), // 'email', 'doc', 'drive', 'calendar'
  resource_id: text('resource_id').notNull(), // specific file/thread ID, or '*' for all
  permission_scope: varchar('permission_scope', { length: 50 }).notNull(), // 'read', 'write', 'send'
  granted_by: varchar('granted_by', { length: 50 }).notNull(), // 'user', 'auto', 'context'
  granted_at: timestamp('granted_at').notNull().defaultNow(),
  expires_at: timestamp('expires_at'), // null = permanent
  context: text('context'), // "work on this file", "respond to alice@company.com"
});

// Google Watched Resources Table (push notification subscriptions)
export const googleWatchedResources = pgTable('google_watched_resources', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  user_id: varchar('user_id', { length: 255 }).notNull(),
  resource_type: varchar('resource_type', { length: 50 }).notNull(), // 'gmail', 'drive', 'calendar'
  resource_id: text('resource_id').notNull(),
  channel_id: text('channel_id').notNull(), // Google's channel ID
  channel_token: text('channel_token').notNull(), // Verification token
  expiration: timestamp('expiration').notNull(),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

// Google Events Table (incoming Google notifications before processing)
export const googleEvents = pgTable('google_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  user_id: varchar('user_id', { length: 255 }).notNull(),
  event_type: varchar('event_type', { length: 50 }).notNull(), // 'email_received', 'doc_mention', 'file_shared'
  resource_id: text('resource_id').notNull(),
  payload: jsonb('payload').notNull(),
  processed: timestamp('processed'),
  created_at: timestamp('created_at').notNull().defaultNow(),
});

// Google Email Threads Table (tracking email conversations)
export const googleEmailThreads = pgTable('google_email_threads', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  user_id: varchar('user_id', { length: 255 }).notNull(),
  thread_id: text('thread_id').notNull().unique(),
  subject: text('subject'),
  participants: jsonb('participants').notNull(), // Array of email addresses
  last_message_at: timestamp('last_message_at').notNull(),
  worker_id: text('worker_id'), // Which worker is handling this thread
  status: varchar('status', { length: 20 }).notNull().default('active'), // 'active', 'closed', 'archived'
  created_at: timestamp('created_at').notNull().defaultNow(),
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

export type ConnectorConfig = typeof connectorConfigs.$inferSelect;
export type NewConnectorConfig = typeof connectorConfigs.$inferInsert;

export type GooglePermission = typeof googlePermissions.$inferSelect;
export type NewGooglePermission = typeof googlePermissions.$inferInsert;

export type GoogleWatchedResource = typeof googleWatchedResources.$inferSelect;
export type NewGoogleWatchedResource = typeof googleWatchedResources.$inferInsert;

export type GoogleEvent = typeof googleEvents.$inferSelect;
export type NewGoogleEvent = typeof googleEvents.$inferInsert;

export type GoogleEmailThread = typeof googleEmailThreads.$inferSelect;
export type NewGoogleEmailThread = typeof googleEmailThreads.$inferInsert;
