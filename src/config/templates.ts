/**
 * E2B Template Configuration
 *
 * Manages different E2B template IDs for different worker types:
 * - Standard workers: General task execution
 * - Infrastructure workers: Can modify worker template repository
 *
 * NOTE: These are loaded dynamically from Redis/PostgreSQL.
 * Call loadTemplates() on startup to populate from database.
 * Infrastructure workers can update these via API endpoints.
 */

export const E2B_TEMPLATES = {
  /**
   * Conductor template (Stu)
   * Includes: Claude CLI, Node.js, Bun, claude-mem plugin (pre-built)
   * Used for the single persistent conductor instance
   */
  CONDUCTOR: process.env.E2B_CONDUCTOR_TEMPLATE_ID || '',

  /**
   * Standard worker template
   * Includes: Claude CLI, Node.js, basic utilities, Playwright (once installed)
   */
  WORKER: process.env.E2B_TEMPLATE_ID || '',

  /**
   * Infrastructure worker template
   * Includes everything in WORKER plus: GitHub CLI, E2B CLI, Docker CLI, Git
   * Can modify worker template repository and trigger rebuilds
   */
  INFRASTRUCTURE: process.env.E2B_INFRASTRUCTURE_TEMPLATE_ID || '',
};

/**
 * Load template IDs from database/Redis
 * Call this on startup to populate E2B_TEMPLATES with latest values
 */
export async function loadTemplates(): Promise<void> {
  try {
    const { getTemplateConfig } = await import('../services/template-config.service.js');
    const config = await getTemplateConfig();

    // Update in-memory cache
    E2B_TEMPLATES.CONDUCTOR = config.conductor || E2B_TEMPLATES.CONDUCTOR;
    E2B_TEMPLATES.WORKER = config.worker || E2B_TEMPLATES.WORKER;
    E2B_TEMPLATES.INFRASTRUCTURE = config.infrastructure || E2B_TEMPLATES.INFRASTRUCTURE;

    console.log('✅ Template IDs loaded:', {
      conductor: E2B_TEMPLATES.CONDUCTOR,
      worker: E2B_TEMPLATES.WORKER,
      infrastructure: E2B_TEMPLATES.INFRASTRUCTURE,
    });
  } catch (error: any) {
    console.warn('⚠️  Failed to load template IDs from database, using environment variables:', error.message);
  }
}

/**
 * Reload template IDs from database/Redis
 * Call this after infrastructure workers update templates
 */
export async function reloadTemplates(): Promise<void> {
  console.log('🔄 Reloading template IDs...');
  await loadTemplates();
}

/**
 * Worker template repository configuration
 * This is the repository that infrastructure workers can modify
 */
export const WORKER_TEMPLATE_CONFIG = {
  /** GitHub repository in format "owner/repo" */
  REPO: process.env.WORKER_TEMPLATE_REPO || 'noahbyrnes/claude-agent-studio-worker-template',

  /** Branch to use for changes */
  BRANCH: process.env.WORKER_TEMPLATE_BRANCH || 'main',

  /** GitHub token for API access (infrastructure workers only) */
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
};

/**
 * Validate template configuration on startup
 */
export function validateTemplateConfig(): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check standard worker template
  if (!E2B_TEMPLATES.WORKER) {
    errors.push('E2B_TEMPLATE_ID not configured - worker spawning will fail');
  }

  // Check infrastructure template (warning only - not critical)
  if (!E2B_TEMPLATES.INFRASTRUCTURE) {
    warnings.push('E2B_INFRASTRUCTURE_TEMPLATE_ID not configured - infrastructure workers disabled');
  }

  // Check GitHub access (warning only - not critical)
  if (!WORKER_TEMPLATE_CONFIG.GITHUB_TOKEN) {
    warnings.push('GITHUB_TOKEN not configured - infrastructure workers cannot create PRs');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Get environment variables for infrastructure workers
 */
export function getInfrastructureWorkerEnv(): Record<string, string> {
  return {
    GITHUB_TOKEN: WORKER_TEMPLATE_CONFIG.GITHUB_TOKEN,
    WORKER_TEMPLATE_REPO: WORKER_TEMPLATE_CONFIG.REPO,
    WORKER_TEMPLATE_BRANCH: WORKER_TEMPLATE_CONFIG.BRANCH,
    E2B_API_KEY: process.env.E2B_API_KEY || '', // Backend API key (spawning sandboxes)
    E2B_ACCESS_TOKEN: process.env.E2B_ACCESS_TOKEN || '', // CLI access token (for e2b template build, etc.)
  };
}
