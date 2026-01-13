/**
 * Memory Persistence Service
 *
 * Manages conductor memory persistence using claude-mem plugin.
 * Backs up and restores the ~/.claude-mem directory across conductor sessions.
 *
 * Storage:
 * - Development: Local /tmp directory (ephemeral)
 * - Production (Railway): Redis for persistence across deployments
 */

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Sandbox } from 'e2b';
import { redis as redisClient } from '../lib/redis.js';

const execAsync = promisify(exec);

const MEMORY_DIR = '/root/.claude-mem';
const BACKUP_DIR = '/tmp/conductor-memory-backups';
const REDIS_MEMORY_KEY_PREFIX = 'conductor:memory:';

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
 * Export memory from E2B sandbox to persistent storage
 * Downloads the .claude-mem directory from the sandbox
 * Stores in Redis (production) or local file (development)
 */
export async function exportMemoryFromSandbox(
  sandbox: Sandbox,
  conductorId: string
): Promise<void> {
  try {
    console.log(`📦 Exporting memory from sandbox ${sandbox.sandboxId}...`);

    // Check if stu-memory.json exists (primary memory file)
    const stuMemoryCheck = await sandbox.commands.run('test -f /root/stu-memory.json && echo "exists" || echo "missing"');
    const hasStuMemory = stuMemoryCheck.stdout.trim() === 'exists';

    // Check if .claude-mem directory exists (optional, for claude-mem plugin)
    const claudeMemCheck = await sandbox.commands.run('test -d /root/.claude-mem && echo "exists" || echo "missing"');
    const hasClaudeMem = claudeMemCheck.stdout.trim() === 'exists';

    if (!hasStuMemory && !hasClaudeMem) {
      console.log('ℹ️  No memory files found in sandbox (neither stu-memory.json nor .claude-mem)');
      return;
    }

    // Create tarball of memory files inside sandbox
    let tarCommand = 'cd /root && tar -czf /tmp/conductor-memory.tar.gz';
    if (hasStuMemory) {
      tarCommand += ' stu-memory.json';
      console.log('   Including stu-memory.json in backup');
    }
    if (hasClaudeMem) {
      tarCommand += ' .claude-mem';
      console.log('   Including .claude-mem directory in backup');
    }

    const tarResult = await sandbox.commands.run(tarCommand);

    if (tarResult.exitCode !== 0) {
      console.log('ℹ️  Failed to create memory tarball');
      return;
    }

    // Download the tarball
    const memoryData = await sandbox.files.read('/tmp/conductor-memory.tar.gz');
    const buffer = Buffer.from(memoryData);

    // Try Redis first (for production persistence across deployments)
    const redis = redisClient;
    if (redis) {
      try {
        const redisKey = `${REDIS_MEMORY_KEY_PREFIX}${conductorId}`;
        await redis.set(redisKey, buffer.toString('base64'), 'EX', 7 * 24 * 60 * 60); // Expire after 7 days
        console.log(`✅ Memory exported to Redis: ${redisKey} (${buffer.length} bytes)`);
        return;
      } catch (redisError: any) {
        console.warn(`⚠️  Redis export failed, falling back to local: ${redisError.message}`);
      }
    }

    // Fallback to local file storage (development)
    const backupPath = path.join(BACKUP_DIR, `${conductorId}.tar.gz`);
    await fs.writeFile(backupPath, buffer);
    console.log(`✅ Memory exported to local file: ${backupPath}`);
  } catch (error: any) {
    console.error('❌ Failed to export memory:', error.message);
    // Don't throw - memory export is not critical
  }
}

/**
 * Import memory from persistent storage to E2B sandbox
 * Uploads and extracts the .claude-mem directory to the sandbox
 * Checks Redis first (production) then falls back to local file (development)
 */
export async function importMemoryToSandbox(
  sandbox: Sandbox,
  conductorId: string
): Promise<void> {
  try {
    let memoryBuffer: Buffer | null = null;
    let source = '';

    // Try Redis first (production)
    if (redisClient) {
      try {
        const redisKey = `${REDIS_MEMORY_KEY_PREFIX}${conductorId}`;
        const base64Data = await redisClient.get(redisKey);
        if (base64Data) {
          memoryBuffer = Buffer.from(base64Data, 'base64');
          source = `Redis:${redisKey}`;
          console.log(`📥 Found memory backup in Redis`);
        }
      } catch (redisError: any) {
        console.warn(`⚠️  Redis import failed, trying local: ${redisError.message}`);
      }
    }

    // Fallback to local file storage (development)
    if (!memoryBuffer) {
      const backupPath = path.join(BACKUP_DIR, `${conductorId}.tar.gz`);
      try {
        memoryBuffer = await fs.readFile(backupPath);
        source = backupPath;
        console.log(`📥 Found memory backup in local file`);
      } catch {
        console.log('ℹ️  No existing memory backup found (Redis or local)');
        return;
      }
    }

    console.log(`📥 Importing memory from ${source}...`);

    // Upload to sandbox (convert Buffer to ArrayBuffer)
    await sandbox.files.write('/tmp/conductor-memory.tar.gz', memoryBuffer.buffer as ArrayBuffer);

    // Extract in sandbox (includes stu-memory.json and/or .claude-mem)
    await sandbox.commands.run(
      'cd /root && tar -xzf /tmp/conductor-memory.tar.gz && rm /tmp/conductor-memory.tar.gz'
    );

    console.log(`✅ Memory imported to sandbox ${sandbox.sandboxId}`);
  } catch (error: any) {
    console.error('❌ Failed to import memory:', error.message);
    // Don't throw - memory import is not critical
  }
}

/**
 * Clear local memory backups (cleanup)
 */
export async function clearMemoryBackups(): Promise<void> {
  try {
    const files = await fs.readdir(BACKUP_DIR);
    for (const file of files) {
      await fs.unlink(path.join(BACKUP_DIR, file));
    }
    console.log('✅ Memory backups cleared');
  } catch (error: any) {
    console.error('❌ Failed to clear memory backups:', error.message);
  }
}

/**
 * List available memory backups
 */
export async function listMemoryBackups(): Promise<string[]> {
  try {
    const files = await fs.readdir(BACKUP_DIR);
    return files.filter((f) => f.endsWith('.tar.gz'));
  } catch {
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
    const backupPath = path.join(BACKUP_DIR, `${conductorId}.tar.gz`);
    const stats = await fs.stat(backupPath);
    return {
      exists: true,
      size: stats.size,
      lastModified: stats.mtime,
    };
  } catch {
    return { exists: false };
  }
}

/**
 * Initialize Stu's memory file in sandbox if it doesn't exist
 */
export async function initializeMemoryFile(sandbox: Sandbox): Promise<void> {
  try {
    console.log(`📝 Initializing Stu's memory file...`);

    // Check if memory file exists
    const checkResult = await sandbox.commands.run('test -f /root/stu-memory.json && echo "exists" || echo "missing"');

    if (checkResult.stdout.trim() === 'missing') {
      console.log('   Creating initial memory file...');

      // Create initial empty memory structure
      const initialMemory = {
        user_preferences: {},
        api_knowledge: {},
        learned_facts: [],
        last_updated: new Date().toISOString()
      };

      // Write initial memory file to sandbox
      await sandbox.files.write('/root/stu-memory.json', JSON.stringify(initialMemory, null, 2));
      console.log('   ✅ Memory file initialized');
    } else {
      console.log('   ✅ Memory file already exists');
    }
  } catch (error: any) {
    console.error('❌ Failed to initialize memory file:', error.message);
    // Don't throw - memory initialization is not critical to sandbox startup
  }
}

// Initialize on module load
initMemoryBackup();
