/**
 * E2B Sandbox Cleanup Service
 *
 * Provides utilities to kill E2B sandboxes by template ID.
 * Useful for cleaning up orphaned sandboxes and forcing fresh starts.
 */

import { Sandbox } from 'e2b';

export interface CleanupResult {
  killed: string[];
  failed: Array<{ sandboxId: string; error: string }>;
  total: number;
}

/**
 * Kill all E2B sandboxes matching a specific template ID.
 *
 * @param templateId - E2B template ID to filter by
 * @param apiKey - E2B API key for authentication
 * @returns Summary of killed and failed sandboxes
 */
export async function killSandboxesByTemplate(
  templateId: string,
  apiKey: string
): Promise<CleanupResult> {
  const result: CleanupResult = {
    killed: [],
    failed: [],
    total: 0,
  };

  try {
    console.log(`🔍 Listing all E2B sandboxes to find template: ${templateId}...`);

    // List all sandboxes (paginated)
    const paginator = Sandbox.list({ apiKey });
    const allSandboxes = [];

    for await (const sandbox of paginator) {
      allSandboxes.push(sandbox);
    }

    console.log(`   Found ${allSandboxes.length} total sandboxes`);

    // Filter by template ID
    const matchingSandboxes = allSandboxes.filter(s => s.templateId === templateId);
    result.total = matchingSandboxes.length;

    console.log(`   ${matchingSandboxes.length} sandboxes match template ${templateId}`);

    if (matchingSandboxes.length === 0) {
      console.log(`   ✅ No sandboxes to kill`);
      return result;
    }

    // Kill each matching sandbox
    for (const sandboxInfo of matchingSandboxes) {
      try {
        console.log(`   🔪 Killing sandbox: ${sandboxInfo.sandboxId}`);
        await Sandbox.kill(sandboxInfo.sandboxId, { apiKey });
        result.killed.push(sandboxInfo.sandboxId);
        console.log(`      ✅ Killed: ${sandboxInfo.sandboxId}`);
      } catch (error: any) {
        console.error(`      ❌ Failed to kill ${sandboxInfo.sandboxId}: ${error.message}`);
        result.failed.push({
          sandboxId: sandboxInfo.sandboxId,
          error: error.message,
        });
      }
    }

    console.log(`✅ Cleanup complete: ${result.killed.length}/${result.total} killed, ${result.failed.length} failed`);

    return result;
  } catch (error: any) {
    console.error(`❌ Failed to list/kill sandboxes: ${error.message}`);
    throw error;
  }
}

/**
 * Kill all conductor sandboxes (by conductor template ID).
 */
export async function killAllConductors(conductorTemplateId: string, apiKey: string): Promise<CleanupResult> {
  console.log(`🧹 Killing all conductor sandboxes (template: ${conductorTemplateId})...`);
  return killSandboxesByTemplate(conductorTemplateId, apiKey);
}

/**
 * Kill all worker sandboxes (by worker template ID).
 */
export async function killAllWorkers(workerTemplateId: string, apiKey: string): Promise<CleanupResult> {
  console.log(`🧹 Killing all worker sandboxes (template: ${workerTemplateId})...`);
  return killSandboxesByTemplate(workerTemplateId, apiKey);
}

/**
 * Kill all infrastructure worker sandboxes (by infrastructure template ID).
 */
export async function killAllInfrastructureWorkers(infraTemplateId: string, apiKey: string): Promise<CleanupResult> {
  console.log(`🧹 Killing all infrastructure worker sandboxes (template: ${infraTemplateId})...`);
  return killSandboxesByTemplate(infraTemplateId, apiKey);
}
