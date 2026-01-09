import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../db/schema.js';

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/claude_studio';

// Create postgres connection
const queryClient = postgres(connectionString);

// Create drizzle instance
export const db = drizzle(queryClient, { schema });
