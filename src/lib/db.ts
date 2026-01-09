import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../db/schema.js';

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/claude_studio';

// Create postgres connection with IPv4 preference
const queryClient = postgres(connectionString, {
  ssl: 'require',
  connect_timeout: 10,
  prepare: false, // Required for connection pooling
});

// Create drizzle instance
export const db = drizzle(queryClient, { schema });
