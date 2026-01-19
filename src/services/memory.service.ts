/**
 * Memory Persistence Service
 *
 * Manages conductor memory persistence using PostgreSQL as primary storage and Redis as cache.
 * Backs up and restores the ~/.claude-mem directory across conductor sessions.
 */

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Sandbox } from 'e2b';
import { redis as redisClient } from '../lib/redis.js';
import { db } from '../lib/db.js';
import { conductorMemory, type ConductorMemory, type NewConductorMemory } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

const execAsync = promisify(exec);

const MEMORY_DIR = '/home/user/.claude-mem';
const BACKUP_DIR = '/tmp/conductor-memory-backups';
const REDIS_MEMORY_KEY_PREFIX = 'conductor:memory:';
const REDIS_CACHE_TTL = 24 * 60 * 60; // 24 hours (shorter than 7 days since backed by PostgreSQL)

/**
 * Initialize memory backup directory
 */
export async function initMemoryBackup(): Promise<void> {
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    console.log(`✅ Memory backup directory initialized: ${BACKUP_DIR}`);
  } catch (error: any) {
    console.error('❌ Failed to initialize memory backup:', error.message);
  }
}

/**
 * Export full conductor state from E2B sandbox to persistent storage (PostgreSQL + Redis cache)
 * Downloads .claude-mem (learned knowledge) and .claude/projects (conversation history) directories
 */
export async function exportMemoryFromSandbox(
  sandbox: Sandbox,
  conductorId: string
): Promise<void> {
  try {
    console.log(`📦 Exporting full conductor state from sandbox ${sandbox.sandboxId}...`);

    // Check which directories exist
    const claudeMemCheck = await sandbox.commands.run('test -d /home/user/.claude-mem && echo "exists" || echo "missing"');
    const hasClaudeMem = claudeMemCheck.stdout.trim() === 'exists';

    const claudeProjectsCheck = await sandbox.commands.run('test -d /home/user/.claude/projects && echo "exists" || echo "missing"');
    const hasClaudeProjects = claudeProjectsCheck.stdout.trim() === 'exists';

    if (!hasClaudeMem && !hasClaudeProjects) {
      console.log('ℹ️  No .claude-mem or .claude/projects directories found in sandbox');
      return;
    }

    // Build list of directories to include in tarball
    const dirsToBackup: string[] = [];
    if (hasClaudeMem) {
      dirsToBackup.push('.claude-mem');
      console.log('   Including .claude-mem directory (learned knowledge)');
    }
    if (hasClaudeProjects) {
      dirsToBackup.push('.claude/projects');
      console.log('   Including .claude/projects directory (conversation history)');
    }

    // Create tarball with both directories (if they exist)
    const tarCommand = `cd /home/user && tar -czf /tmp/conductor-memory.tar.gz ${dirsToBackup.join(' ')}`;
    const tarResult = await sandbox.commands.run(tarCommand);

    if (tarResult.exitCode !== 0) {
      console.log('ℹ️  Failed to create state tarball');
      console.log(`   Command: ${tarCommand}`);
      console.log(`   Stderr: ${tarResult.stderr}`);
      return;
    }

    // Download the tarball
    const memoryData = await sandbox.files.read('/tmp/conductor-memory.tar.gz');
    const buffer = Buffer.from(memoryData);
    const base64Data = buffer.toString('base64');
    const sizeBytes = buffer.length.toString();

    // Save to PostgreSQL (primary storage)
    try {
      const existing = await db.select()
        .from(conductorMemory)
        .where(eq(conductorMemory.conductor_id, conductorId))
        .limit(1);

      if (existing.length > 0) {
        // Update existing
        await db.update(conductorMemory)
          .set({
            memory_data: base64Data,
            size_bytes: sizeBytes,
            updated_at: new Date(),
          })
          .where(eq(conductorMemory.conductor_id, conductorId));
      } else {
        // Insert new
        await db.insert(conductorMemory).values({
          conductor_id: conductorId,
          memory_data: base64Data,
          size_bytes: sizeBytes,
        });
      }

      const sizeMB = buffer.length / (1024 * 1024);
      const sizeDisplay = sizeMB >= 1
        ? `${sizeMB.toFixed(2)} MB`
        : `${(buffer.length / 1024).toFixed(2)} KB`;

      console.log(`✅ Full conductor state exported to PostgreSQL: ${sizeDisplay}`);
      if (hasClaudeMem && hasClaudeProjects) {
        console.log(`   Includes: conversation history + learned knowledge`);
      } else if (hasClaudeProjects) {
        console.log(`   Includes: conversation history only`);
      } else {
        console.log(`   Includes: learned knowledge only`);
      }
    } catch (dbError: any) {
      console.error(`❌ PostgreSQL export failed: ${dbError.message}`);
      throw dbError;
    }

    // Cache in Redis for fast access (24 hour TTL)
    if (redisClient) {
      try {
        const redisKey = `${REDIS_MEMORY_KEY_PREFIX}${conductorId}`;
        await redisClient.setex(redisKey, REDIS_CACHE_TTL, base64Data);
        console.log(`   Cached in Redis (24h TTL)`);
      } catch (redisError: any) {
        console.warn(`⚠️  Redis cache failed (non-critical): ${redisError.message}`);
      }
    }
  } catch (error: any) {
    console.error('❌ Failed to export conductor state:', error.message);
    // Don't throw - state export is not critical for conductor operation
  }
}

/**
 * Import full conductor state from persistent storage to E2B sandbox
 * Uploads and extracts .claude-mem (learned knowledge) and .claude/projects (conversation history)
 * Checks Redis cache first, then PostgreSQL
 */
export async function importMemoryToSandbox(
  sandbox: Sandbox,
  conductorId: string
): Promise<void> {
  try {
    let stateBuffer: Buffer | null = null;
    let source = '';

    // Try Redis cache first (fast path)
    if (redisClient) {
      try {
        const redisKey = `${REDIS_MEMORY_KEY_PREFIX}${conductorId}`;
        const base64Data = await redisClient.get(redisKey);
        if (base64Data) {
          stateBuffer = Buffer.from(base64Data, 'base64');
          source = `Redis cache`;

          const sizeMB = stateBuffer.length / (1024 * 1024);
          const sizeDisplay = sizeMB >= 1
            ? `${sizeMB.toFixed(2)} MB`
            : `${(stateBuffer.length / 1024).toFixed(2)} KB`;

          console.log(`📥 Found conductor state in Redis cache (${sizeDisplay})`);
        }
      } catch (redisError: any) {
        console.warn(`⚠️  Redis cache read failed: ${redisError.message}`);
      }
    }

    // Load from PostgreSQL if not in cache
    if (!stateBuffer) {
      try {
        const result = await db.select()
          .from(conductorMemory)
          .where(eq(conductorMemory.conductor_id, conductorId))
          .limit(1);

        if (result.length > 0) {
          const memory = result[0];
          stateBuffer = Buffer.from(memory.memory_data, 'base64');
          source = `PostgreSQL`;

          const sizeMB = stateBuffer.length / (1024 * 1024);
          const sizeDisplay = sizeMB >= 1
            ? `${sizeMB.toFixed(2)} MB`
            : `${(stateBuffer.length / 1024).toFixed(2)} KB`;

          console.log(`📥 Found conductor state in PostgreSQL (${sizeDisplay})`);

          // Cache in Redis for next time
          if (redisClient) {
            try {
              const redisKey = `${REDIS_MEMORY_KEY_PREFIX}${conductorId}`;
              await redisClient.setex(redisKey, REDIS_CACHE_TTL, memory.memory_data);
            } catch (error: any) {
              console.warn('⚠️  Failed to cache in Redis (non-critical):', error.message);
            }
          }
        }
      } catch (dbError: any) {
        console.error(`❌ PostgreSQL read failed: ${dbError.message}`);
      }
    }

    // No state found anywhere
    if (!stateBuffer) {
      console.log('ℹ️  No existing conductor state found (Redis or PostgreSQL)');
      return;
    }

    console.log(`📥 Importing conductor state from ${source}...`);

    // Upload to sandbox
    // IMPORTANT: Create a proper ArrayBuffer without offset issues
    // Using .buffer directly can cause corruption if Buffer is a view with byteOffset
    // Solution: slice() creates a new Buffer, then .buffer gets its clean ArrayBuffer
    const cleanBuffer = stateBuffer.slice(); // Creates new Buffer without offset issues
    await sandbox.files.write('/tmp/conductor-memory.tar.gz', cleanBuffer.buffer as ArrayBuffer);

    // Diagnostic: Check tarball integrity before extraction
    try {
      const listResult = await sandbox.commands.run(
        'tar -tzf /tmp/conductor-memory.tar.gz | head -20',
        { timeoutMs: 10000 }
      );
      console.log('   📋 Tarball contents (first 20 files):');
      console.log(listResult.stdout || '(empty)');
    } catch (listError: any) {
      console.error('   ⚠️  Cannot list tarball contents:', listError.message);
    }

    // Extract in sandbox (.claude-mem and .claude/projects directories)
    // Use sh -c to capture stderr even when command fails
    try {
      const extractCommand = 'cd /home/user && tar -xzvf /tmp/conductor-memory.tar.gz 2>&1; echo "EXIT_CODE=$?"';
      const result = await sandbox.commands.run(extractCommand, { timeoutMs: 30000 });

      console.log('   📦 Tar extraction output:');
      console.log(result.stdout.substring(0, 1000)); // First 1000 chars

      // Check if extraction succeeded (look for EXIT_CODE=0)
      if (result.stdout.includes('EXIT_CODE=0')) {
        console.log('   ✅ Tar extraction succeeded');
        // Clean up tarball
        await sandbox.commands.run('rm -f /tmp/conductor-memory.tar.gz');
      } else {
        console.error('   ❌ Tar extraction failed');
        console.error(`   Full output: ${result.stdout}`);
        await sandbox.commands.run('rm -f /tmp/conductor-memory.tar.gz');
        return;
      }
    } catch (tarError: any) {
      console.error('❌ Tar extraction error:', tarError.message);
      console.error('   Error details:', tarError);
      // Clean up
      await sandbox.commands.run('rm -f /tmp/conductor-memory.tar.gz');
      return;
    }

    console.log(`✅ Full conductor state imported to sandbox ${sandbox.sandboxId}`);
    console.log(`   Restored: conversation history + learned knowledge`);
  } catch (error: any) {
    console.error('❌ Failed to import conductor state:', error.message);
    console.error('   Full error:', error);
    // Don't throw - state import is not critical for conductor startup (will start fresh)
  }
}

/**
 * Clear memory backups from both PostgreSQL and Redis
 */
export async function clearMemoryBackups(conductorId: string = 'default'): Promise<void> {
  // Clear from PostgreSQL
  try {
    await db.delete(conductorMemory)
      .where(eq(conductorMemory.conductor_id, conductorId));
    console.log('✅ Memory backups cleared from PostgreSQL');
  } catch (error: any) {
    console.error('❌ Failed to clear from PostgreSQL:', error.message);
  }

  // Clear from Redis cache
  if (redisClient) {
    try {
      const redisKey = `${REDIS_MEMORY_KEY_PREFIX}${conductorId}`;
      await redisClient.del(redisKey);
      console.log('   Cleared from Redis cache');
    } catch (error: any) {
      console.warn('⚠️  Failed to clear from Redis (non-critical):', error.message);
    }
  }
}

/**
 * List available memory backups
 */
export async function listMemoryBackups(): Promise<Array<{ conductorId: string; sizeBytes: string; updatedAt: Date }>> {
  try {
    const results = await db.select()
      .from(conductorMemory);

    return results.map(r => ({
      conductorId: r.conductor_id,
      sizeBytes: r.size_bytes,
      updatedAt: r.updated_at,
    }));
  } catch (error: any) {
    console.error('❌ Failed to list memory backups:', error.message);
    return [];
  }
}

/**
 * Get memory backup info
 */
export async function getMemoryBackupInfo(conductorId: string): Promise<{
  exists: boolean;
  size?: number;
  lastModified?: Date;
}> {
  try {
    const result = await db.select()
      .from(conductorMemory)
      .where(eq(conductorMemory.conductor_id, conductorId))
      .limit(1);

    if (result.length === 0) {
      return { exists: false };
    }

    const memory = result[0];
    return {
      exists: true,
      size: parseInt(memory.size_bytes, 10),
      lastModified: memory.updated_at,
    };
  } catch (error: any) {
    console.error('❌ Failed to get memory backup info:', error.message);
    return { exists: false };
  }
}

// Initialize on module load
initMemoryBackup();
