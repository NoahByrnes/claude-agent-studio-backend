/**
 * Memory Persistence Service
 *
 * Manages conductor memory persistence using claude-mem plugin.
 * Backs up and restores the ~/.claude-mem directory across conductor sessions.
 */

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Sandbox } from 'e2b';

const execAsync = promisify(exec);

const MEMORY_DIR = '/root/.claude-mem';
const BACKUP_DIR = '/tmp/conductor-memory-backups';

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
 * Export memory from E2B sandbox to local backup
 * Downloads the .claude-mem directory from the sandbox
 */
export async function exportMemoryFromSandbox(
  sandbox: Sandbox,
  conductorId: string
): Promise<void> {
  try {
    const backupPath = path.join(BACKUP_DIR, `${conductorId}.tar.gz`);

    console.log(`📦 Exporting memory from sandbox ${sandbox.sandboxId}...`);

    // Create tarball of memory directory inside sandbox
    await sandbox.commands.run(
      `cd /root && tar -czf /tmp/claude-mem.tar.gz .claude-mem 2>/dev/null || echo "No memory to export"`
    );

    // Download the tarball
    const memoryData = await sandbox.files.read('/tmp/claude-mem.tar.gz');

    // Save to local backup (convert Uint8Array to Buffer)
    await fs.writeFile(backupPath, Buffer.from(memoryData));

    console.log(`✅ Memory exported to ${backupPath}`);
  } catch (error: any) {
    console.error('❌ Failed to export memory:', error.message);
    // Don't throw - memory export is not critical
  }
}

/**
 * Import memory from local backup to E2B sandbox
 * Uploads and extracts the .claude-mem directory to the sandbox
 */
export async function importMemoryToSandbox(
  sandbox: Sandbox,
  conductorId: string
): Promise<void> {
  try {
    const backupPath = path.join(BACKUP_DIR, `${conductorId}.tar.gz`);

    // Check if backup exists
    try {
      await fs.access(backupPath);
    } catch {
      console.log('ℹ️  No existing memory backup found');
      return;
    }

    console.log(`📥 Importing memory from ${backupPath}...`);

    // Read backup
    const memoryData = await fs.readFile(backupPath);

    // Upload to sandbox (convert Buffer to ArrayBuffer)
    await sandbox.files.write('/tmp/claude-mem.tar.gz', memoryData.buffer as ArrayBuffer);

    // Extract in sandbox
    await sandbox.commands.run(
      'cd /root && tar -xzf /tmp/claude-mem.tar.gz && rm /tmp/claude-mem.tar.gz'
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

// Initialize on module load
initMemoryBackup();
