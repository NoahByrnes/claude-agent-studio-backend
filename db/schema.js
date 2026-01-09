import { pgTable, uuid, varchar, text, jsonb, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
// Enums
export const agentStatusEnum = pgEnum('agent_status', ['idle', 'running', 'stopped', 'error', 'deploying']);
// Agents Table
export const agents = pgTable('agents', {
    id: uuid('id').primaryKey().default(sql `gen_random_uuid()`),
    user_id: uuid('user_id').notNull(), // Supabase user ID
    name: varchar('name', { length: 255 }).notNull(),
    status: agentStatusEnum('status').notNull().default('idle'),
    config: jsonb('config').notNull(),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
});
// Sessions Table
export const sessions = pgTable('sessions', {
    id: uuid('id').primaryKey().default(sql `gen_random_uuid()`),
    agent_id: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    session_id: varchar('session_id', { length: 255 }).notNull(),
    state: jsonb('state').notNull().default({}),
    last_active: timestamp('last_active').notNull().defaultNow(),
    created_at: timestamp('created_at').notNull().defaultNow(),
});
// Audit Logs Table
export const auditLogs = pgTable('audit_logs', {
    id: uuid('id').primaryKey().default(sql `gen_random_uuid()`),
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
    id: uuid('id').primaryKey().default(sql `gen_random_uuid()`),
    name: varchar('name', { length: 100 }).notNull(),
    url: text('url').notNull(),
    permissions: jsonb('permissions').notNull().default([]),
    credentials_vault_path: text('credentials_vault_path'),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
});
// Agent Events Table (for tracking incoming events)
export const agentEvents = pgTable('agent_events', {
    id: uuid('id').primaryKey().default(sql `gen_random_uuid()`),
    agent_id: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    event_type: varchar('event_type', { length: 50 }).notNull(),
    payload: jsonb('payload').notNull(),
    processed: timestamp('processed'),
    created_at: timestamp('created_at').notNull().defaultNow(),
});
//# sourceMappingURL=schema.js.map