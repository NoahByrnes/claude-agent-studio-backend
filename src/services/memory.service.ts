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
 * Export memory from E2B sandbox to persistent storage (PostgreSQL + Redis cache)
 * Downloads the .claude-mem directory from the sandbox
 */
export async function exportMemoryFromSandbox(
  sandbox: Sandbox,
  conductorId: string
): Promise<void> {
  try {
    console.log(`📦 Exporting memory from sandbox ${sandbox.sandboxId}...`);

    // Check if .claude-mem directory exists
    const claudeMemCheck = await sandbox.commands.run('test -d /home/user/.claude-mem && echo "exists" || echo "missing"');
    const hasClaudeMem = claudeMemCheck.stdout.trim() === 'exists';

    if (!hasClaudeMem) {
      console.log('ℹ️  No .claude-mem directory found in sandbox');
      return;
    }

    // Create tarball of claude-mem directory inside sandbox
    console.log('   Including .claude-mem directory in backup');
    const tarResult = await sandbox.commands.run('cd /home/user && tar -czf /tmp/conductor-memory.tar.gz .claude-mem');

    if (tarResult.exitCode !== 0) {
      console.log('ℹ️  Failed to create memory tarball');
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

      console.log(`✅ Memory exported to PostgreSQL: ${(buffer.length / 1024).toFixed(2)} KB`);
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
    console.error('❌ Failed to export memory:', error.message);
    // Don't throw - memory export is not critical for conductor operation
  }
}

/**
 * Import memory from persistent storage to E2B sandbox
 * Uploads and extracts the .claude-mem directory to the sandbox
 * Checks Redis cache first, then PostgreSQL
 */
export async function importMemoryToSandbox(
  sandbox: Sandbox,
  conductorId: string
): Promise<void> {
  try {
    let memoryBuffer: Buffer | null = null;
    let source = '';

    // Try Redis cache first (fast path)
    if (redisClient) {
      try {
        const redisKey = `${REDIS_MEMORY_KEY_PREFIX}${conductorId}`;
        const base64Data = await redisClient.get(redisKey);
        if (base64Data) {
          memoryBuffer = Buffer.from(base64Data, 'base64');
          source = `Redis cache`;
          console.log(`📥 Found memory backup in Redis cache (${(memoryBuffer.length / 1024).toFixed(2)} KB)`);
        }
      } catch (redisError: any) {
        console.warn(`⚠️  Redis cache read failed: ${redisError.message}`);
      }
    }

    // Load from PostgreSQL if not in cache
    if (!memoryBuffer) {
      try {
        const result = await db.select()
          .from(conductorMemory)
          .where(eq(conductorMemory.conductor_id, conductorId))
          .limit(1);

        if (result.length > 0) {
          const memory = result[0];
          memoryBuffer = Buffer.from(memory.memory_data, 'base64');
          source = `PostgreSQL`;
          console.log(`📥 Found memory backup in PostgreSQL (${(memoryBuffer.length / 1024).toFixed(2)} KB)`);

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

    // No memory found anywhere
    if (!memoryBuffer) {
      console.log('ℹ️  No existing memory backup found (Redis or PostgreSQL)');
      return;
    }

    console.log(`📥 Importing memory from ${source}...`);

    // Upload to sandbox (convert Buffer to ArrayBuffer)
    await sandbox.files.write('/tmp/conductor-memory.tar.gz', memoryBuffer.buffer as ArrayBuffer);

    // Extract in sandbox (.claude-mem directory)
    try {
      const result = await sandbox.commands.run(
        'cd /home/user && tar -xzf /tmp/conductor-memory.tar.gz && rm /tmp/conductor-memory.tar.gz'
      );

      if (result.exitCode !== 0) {
        console.error(`❌ Tar extraction failed (exit ${result.exitCode})`);
        console.error(`   Stdout: ${result.stdout}`);
        console.error(`   Stderr: ${result.stderr}`);

        // Clean up failed tar file
        await sandbox.commands.run('rm -f /tmp/conductor-memory.tar.gz');
        return;
      }
    } catch (tarError: any) {
      console.error('❌ Tar extraction error:', tarError.message);
      // Clean up
      await sandbox.commands.run('rm -f /tmp/conductor-memory.tar.gz');
      return;
    }

    console.log(`✅ Memory imported to sandbox ${sandbox.sandboxId}`);
  } catch (error: any) {
    console.error('❌ Failed to import memory:', error.message);
    console.error('   Full error:', error);
    // Don't throw - memory import is not critical for conductor startup
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
