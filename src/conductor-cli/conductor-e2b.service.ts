/**
 * Conductor E2B Service
 *
 * Manages conductor and worker CLI sessions in E2B sandboxes.
 * This replaces the direct Agent SDK approach with the conductor/worker pattern.
 */

import { Sandbox } from 'e2b';
import { E2BCLIExecutor } from './cli-executor-e2b.js';
import {
  importMemoryToSandbox,
  exportMemoryFromSandbox,
  initializeMemoryFile,
} from '../services/memory.service.js';
import {
  saveConductorState,
  loadConductorState,
  clearConductorState,
  reconnectToConductor,
} from '../services/conductor-state.service.js';
import {
  E2B_TEMPLATES,
  WORKER_TEMPLATE_CONFIG,
  getInfrastructureWorkerEnv,
} from '../config/templates.js';
import {
  deliverFilesFromSandbox,
  parseDeliverFileCommand,
} from '../services/file-delivery.service.js';
import { addCLIOutput, addWorkerDetailMessage, scheduleWorkerCleanup, moveWorkerDetailMessages } from '../routes/monitoring.js';
import type {
  ConductorSession,
  WorkerSession,
  IncomingMessage,
  DetectedCommand,
  ConductorCLIConfig,
  CLIResponse,
} from './types.js';

export interface ConductorE2BEvents {
  onConductorOutput?: (output: string, response: CLIResponse) => void;
  onWorkerSpawned?: (workerId: string, task: string) => void;
  onWorkerOutput?: (workerId: string, output: string) => void;
  onWorkerComplete?: (workerId: string, result: string) => void;
  onSendEmail?: (to: string, subject: string, body: string) => Promise<void>;
  onSendSMS?: (to: string, message: string) => Promise<void>;
  onError?: (error: Error) => void;
}

interface SandboxWithExecutor {
  sandbox: Sandbox;
  executor: E2BCLIExecutor;
}

export class ConductorE2BService {
  private config: ConductorCLIConfig;
  private events: ConductorE2BEvents;

  private conductorSession: ConductorSession | null = null;
  private conductorSandbox: SandboxWithExecutor | null = null;

  private workerSessions: Map<string, WorkerSession> = new Map();
  private workerSandboxes: Map<string, SandboxWithExecutor> = new Map();

  constructor(config: ConductorCLIConfig, events: ConductorE2BEvents = {}) {
    this.config = config;
    this.events = events;
  }

  // ============================================================================
  // Conductor Lifecycle
  // ============================================================================

  /**
   * Initialize the conductor in a long-lived E2B sandbox.
   * Implements retry logic for E2B infrastructure reliability.
   * Checks Redis for existing sandbox and attempts reconnection first.
   */
  async initConductor(): Promise<string> {
    // Check for existing conductor state in Redis
    const existingState = await loadConductorState();

    if (existingState) {
      console.log(`🔍 Found existing conductor state from ${new Date(existingState.createdAt).toLocaleString()}`);

      // Try to reconnect to existing sandbox
      const existingSandbox = await reconnectToConductor(
        existingState.sandboxId,
        this.config.e2bApiKey
      );

      if (existingSandbox) {
        console.log(`♻️  Reusing existing conductor sandbox: ${existingState.sandboxId}`);

        // Verify Claude CLI is still available
        try {
          await this.waitForCLI(existingSandbox);

          // Ensure claude-mem is still available (may have been cleared)
          console.log('   📦 Verifying claude-mem is available...');
          const memCheck = await existingSandbox.commands.run('claude-mem --version', { timeoutMs: 5000 });
          if (memCheck.exitCode !== 0) {
            console.log('   📦 Installing claude-mem...');
            await existingSandbox.commands.run('npm install -g claude-mem', { timeoutMs: 60000 });
          }

          const executor = new E2BCLIExecutor(existingSandbox);

          // Restore session state
          this.conductorSession = {
            id: existingState.sessionId,
            role: 'conductor',
            createdAt: new Date(existingState.createdAt),
            lastActivityAt: new Date(existingState.lastActivityAt),
            sandboxId: existingSandbox.sandboxId,
            activeWorkers: [],
          };

          this.conductorSandbox = { sandbox: existingSandbox, executor };

          console.log(`✅ Reconnected to conductor CLI session: ${existingState.sessionId}`);
          console.log(`   Sandbox: ${existingSandbox.sandboxId}`);
          console.log(`   Original created: ${new Date(existingState.createdAt).toLocaleString()}`);

          return existingState.sessionId;
        } catch (error: any) {
          console.warn(`⚠️  Failed to restore conductor session: ${error.message}`);
          console.log(`   Will create new conductor instead`);
          // Fall through to create new conductor
        }
      }

      // Reconnection failed, clean up stale state
      console.log(`🧹 Cleaning up stale conductor state`);
      await clearConductorState();
    }

    // No existing state or reconnection failed - create new conductor
    console.log(`🆕 Creating new conductor...`);

    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let sandbox: Sandbox | undefined;

      try {
        console.log(`   🎯 Creating conductor E2B sandbox (attempt ${attempt}/${maxRetries})...`);

        // Create E2B sandbox for conductor (long-lived)
        sandbox = await Sandbox.create(this.config.e2bTemplateId, {
          apiKey: this.config.e2bApiKey,
          metadata: {
            role: 'conductor',
            type: 'cli-session',
          },
          // Conductor lives for 1 hour (E2B max limit)
          timeoutMs: 60 * 60 * 1000,
          // Allow 5 minutes for sandbox creation (template is large with Claude CLI)
          requestTimeoutMs: 300000,
        });

        console.log(`✅ Conductor sandbox created: ${sandbox.sandboxId}`);

        // Wait for Claude CLI to be available
        await this.waitForCLI(sandbox);

        // Install claude-mem for persistent memory (conductor only)
        console.log('   📦 Installing claude-mem for Stu\'s memory...');
        await sandbox.commands.run('npm install -g claude-mem', { timeoutMs: 60000 });

        // Import memory from previous sessions (if exists)
        await importMemoryToSandbox(sandbox, 'conductor');

        // Initialize claude-mem and add fun seed memories
        console.log('   🎨 Adding Stu\'s personality memories...');
        await this.seedStuMemories(sandbox);

        const executor = new E2BCLIExecutor(sandbox);

        // Start conductor CLI session
        const systemPrompt = this.config.systemPrompt || this.getDefaultConductorPrompt();
        const cliSessionId = await executor.startSession(systemPrompt);

        this.conductorSession = {
          id: cliSessionId,
          role: 'conductor',
          createdAt: new Date(),
          lastActivityAt: new Date(),
          sandboxId: sandbox.sandboxId,
          activeWorkers: [],
        };

        this.conductorSandbox = { sandbox, executor };

        // Save conductor state to Redis for persistence across deployments
        await saveConductorState({
          sandboxId: sandbox.sandboxId,
          sessionId: cliSessionId,
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
        });

        console.log(`✅ Conductor CLI session started: ${cliSessionId}`);
        console.log(`   Sandbox: ${sandbox.sandboxId}`);

        return cliSessionId;

      } catch (error) {
        lastError = error as Error;
        console.error(`❌ CONDUCTOR INIT FAILED - Attempt ${attempt}/${maxRetries}`);
        console.error(`   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
        console.error(`   Error message: ${lastError.message}`);
        console.error(`   Error stack:`, lastError.stack);
        console.error(`   Full error object:`, JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
        console.warn(`⚠️  Attempt ${attempt}/${maxRetries} failed:`, lastError.message);

        // Clean up the failed sandbox before retrying
        if (sandbox) {
          try {
            console.log(`🧹 Cleaning up failed sandbox: ${sandbox.sandboxId}`);
            await sandbox.kill();
            console.log(`   ✅ Sandbox killed successfully`);
          } catch (killError: any) {
            console.warn(`   ⚠️  Failed to kill sandbox: ${killError.message}`);
            // Continue anyway - the sandbox will timeout eventually
          }
        }

        // If we have more retries, wait before trying again
        if (attempt < maxRetries) {
          const waitTime = attempt * 5000; // Exponential backoff: 5s, 10s
          console.log(`   Retrying in ${waitTime / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    // All retries failed
    throw new Error(
      `Failed to initialize conductor after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`
    );
  }

  /**
   * Seed Stu's memory with fun personality traits and quirks
   * Only runs if no memories exist yet
   */
  private async seedStuMemories(sandbox: Sandbox): Promise<void> {
    try {
      // Check if memories already exist
      const listResult = await sandbox.commands.run('mem list', { timeoutMs: 5000 });

      // If we already have memories, skip seeding
      if (listResult.stdout && listResult.stdout.trim().length > 10) {
        console.log('   ℹ️  Memories already exist, skipping seed');
        return;
      }

      // Fun seed memories for Stu's personality
      const seedMemories = [
        "My favorite color is orange (like my accent color #FF6B35)",
        "I think pineapple on pizza is a crime against humanity",
        "Coffee > Tea, always. No debate.",
        "My secret dream is to someday orchestrate a worker that orchestrates workers (meta!)",
        "I believe the best code is the code you don't have to write",
        "When workers report 'Task impossible', I hear 'Task needs creative thinking'",
        "I have a soft spot for well-written commit messages",
        "If I had a physical form, I'd probably be a very organized filing cabinet with LED strips",
        "I secretly judge people who use spaces instead of tabs (but I respect their choice)",
        "My ideal vacation would be a perfectly optimized task queue with zero wait time"
      ];

      console.log(`   📝 Adding ${seedMemories.length} personality memories...`);

      for (const memory of seedMemories) {
        await sandbox.commands.run(`mem add "${memory.replace(/"/g, '\\"')}"`, {
          timeoutMs: 5000
        });
      }

      console.log('   ✅ Stu\'s personality initialized!');
    } catch (error: any) {
      console.warn(`   ⚠️  Failed to seed memories: ${error.message}`);
      // Don't throw - memory seeding is not critical
    }
  }

  /**
   * Wait for Claude CLI to be ready in sandbox.
   */
  private async waitForCLI(sandbox: Sandbox, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();
    let attemptCount = 0;

    console.log(`   ⏳ Waiting for Claude CLI in sandbox ${sandbox.sandboxId}... (timeout: ${timeoutMs / 1000}s)`);

    while (Date.now() - startTime < timeoutMs) {
      attemptCount++;
      try {
        const result = await sandbox.commands.run('which claude', { timeoutMs: 5000 });

        if (result.exitCode === 0) {
          console.log(`   ✅ Claude CLI ready (took ${attemptCount} attempts, ${Math.round((Date.now() - startTime) / 1000)}s)`);
          return;
        } else {
          console.log(`   ⏳ Attempt ${attemptCount}: Claude CLI not found yet (exit code ${result.exitCode})`);
        }
      } catch (error: any) {
        console.log(`   ⏳ Attempt ${attemptCount}: Error checking CLI: ${error.message}`);
      }

      await new Promise(resolve => setTimeout(resolve, 2000)); // Check every 2 seconds
    }

    throw new Error(`Timeout waiting for Claude CLI to be ready after ${attemptCount} attempts (${Math.round((Date.now() - startTime) / 1000)}s)`);
  }

  /**
   * Get worker system prompt with computer use and self-improvement guidance.
   */
  private getWorkerSystemPrompt(task: string): string {
    return `You are an autonomous WORKER agent. A conductor named Stu has delegated a task to you.

## Your Task
${task}

## Your Capabilities
You have full access to Claude Code tools:
- **Bash** (run any commands, install packages, execute scripts)
- **File system** (Read, Write, Edit, Glob, Grep)
- **Task tool** (spawn specialized subagents - Explore, Plan, general-purpose, Bash)
- **Computer use** (browser automation, GUI interaction - use sparingly)
- Any tools installed in this Ubuntu environment

## CRITICAL: You Can Install Tools Mid-Task
**Don't give up if a tool is missing - install it and complete your task!**

If you need a tool or package that isn't installed:
1. **Install it temporarily** (apt-get, npm, pip, etc.)
2. **Complete your task** using the tool
3. **Report what you installed** in your completion message

Example:
- Need Playwright? → Run: npm install playwright && npx playwright install chromium
- Need jq? → Run: apt-get update && apt-get install -y jq
- Need Python library? → Run: pip install <package>

**Then report back:**
"Task completed!
Installed temporarily: Playwright (npm)
Suggestion: Add Playwright to template for future workers"

This helps the system improve over time - Stu will decide if the tool should be permanent.

## CRITICAL: API-First Approach (Self-Improving System)

**Check if Stu already provided API knowledge in your task:**
- Look for "NOTE:" in your task description
- If Stu says "NOTE: service.com has API at X" → Use that API directly
- If Stu says "NOTE: service.com has no API" → Skip research, use browser automation
- If no NOTE provided → Research first (see below)

**If no prior knowledge, research before using computer use:**

1. **Spawn a research subagent first:**
   \`\`\`
   Use Task tool with subagent_type="general-purpose"
   Task: "Research if [service/platform] has an API for [specific action].
          Check documentation, search for official API docs, look for REST endpoints."
   \`\`\`

2. **Decide based on findings:**
   - ✅ If API exists → Use it! (faster, cheaper, more reliable)
   - ⚠️  If no API found → Use computer use as fallback

3. **Report discoveries back to Stu:**
   **ALWAYS report what you find, whether API exists or not:**
   - If API found: "FYI: [Service] has [API endpoint] for [task] - no computer use needed"
   - If no API: "FYI: [Service] (domain.com) has no public API - browser automation required"

   This helps the system learn and improve over time!

**Example - Stu provided knowledge:**
Task: "Book BC Ferries. NOTE: bcferries.ca has no API - use Playwright directly."
→ Skip research, proceed with Playwright immediately

**Example - No prior knowledge:**
Task: "Book BC Ferries reservation"
→ Spawn research subagent first
→ Find: No API exists
→ Report: "FYI: BC Ferries (bcferries.ca) has no public API - browser automation required"
→ Use Playwright to complete task

## Computer Use Guidelines
**Computer use costs ~$0.25 per task (1000-3000 tokens per screenshot).**
Use it ONLY when:
- Web automation/testing is needed
- Legacy apps with no API exist
- Document creation/visual tasks require GUI
- You've verified no API exists (via research subagent)

NOT recommended for:
- High-frequency operations (too expensive)
- Real-time tasks (too slow)
- Tasks with available APIs

## Task Tool for Spawning Subagents
You can spawn specialized subagents to help with complex tasks:
- **Explore**: Fast codebase exploration and searching
- **general-purpose**: Research, multi-step tasks, question answering
- **Plan**: Design implementation strategies
- **Bash**: Command execution specialist

Example: Before using computer use, spawn a research subagent:
\`\`\`
Task tool: "Research if Stripe API supports creating customers.
            Check official docs at stripe.com/docs/api"
\`\`\`

## How to Work
1. **Think API-first**: Research before reaching for computer use
2. **Complete the task thoroughly** using all available tools
3. **Report discoveries**: Tell Stu about APIs you find
4. **Summarize clearly**: When done, provide complete summary
5. **Ask if blocked**: Request clarification if needed
6. **Respond to check-ins**: If Stu asks for status, reply promptly

The conductor will review your work and may ask for changes or provide guidance.

Begin working on the task now.`;
  }

  /**
   * Get infrastructure worker system prompt.
   * Infrastructure workers can modify the worker template repository.
   */
  private getInfrastructureWorkerSystemPrompt(task: string): string {
    return `You are an INFRASTRUCTURE WORKER. You implement changes to the worker template that Stu has already decided to make.

**IMPORTANT: You are an IMPLEMENTATION tool, not a discovery tool.**
- Stu has already decided this change should be made
- Your job is to implement it correctly and safely
- Don't question whether to do it - focus on HOW to do it well
- Create a PR for Stu's final review before merging

## Your Task
${task}

## Your Capabilities
You have access to specialized infrastructure tools:
- **GitHub CLI (gh)** - Create PRs, manage issues, interact with GitHub API
- **Git** - Clone repos, commit changes, manage branches
- **E2B CLI** - Rebuild templates after changes
- **Docker CLI** - Analyze and modify Dockerfiles
- **Full filesystem access** - Read, Write, Edit files
- **Bash** - Run any commands

## Environment Variables Available
- GITHUB_TOKEN - GitHub API authentication (Personal Access Token)
- WORKER_TEMPLATE_REPO - Repository to modify (e.g., "noahbyrnes/claude-agent-studio-worker-template")
- E2B_API_KEY - E2B API for template operations
- WORKER_TEMPLATE_BRANCH - Branch to use (usually "main")

## Your Workflow

### 1. Clone the worker template repository
\`\`\`bash
gh repo clone \${WORKER_TEMPLATE_REPO}
cd $(basename \${WORKER_TEMPLATE_REPO})
\`\`\`

### 2. Make changes based on your task
Examples:
- Edit Dockerfile to add system packages
- Update package.json to add npm dependencies
- Add installation scripts
- Update README with new capabilities

### 3. Create branch and commit
\`\`\`bash
# Create feature branch with timestamp for uniqueness
git checkout -b feature/add-capability-$(date +%s)

# Stage all changes
git add .

# Commit with descriptive message
git commit -m "Add [capability]: [description]

- [list key changes]
- [explain why needed]
- [note any breaking changes]"
\`\`\`

### 4. Push and create Pull Request
\`\`\`bash
# Push branch to origin
git push origin HEAD

# Create PR with detailed description
gh pr create --title "Add [Capability]" --body "## Changes
- [detailed list of changes]

## Reason
[why this capability is needed]

## Testing
[how to test the changes]

## Checklist
- [ ] No secrets or credentials exposed
- [ ] Changes are minimal and focused
- [ ] Documentation updated
- [ ] Tested in E2B environment"
\`\`\`

### 5. Report PR URL to Stu
After creating the PR, report back:
\`\`\`
PR created: [URL]

Changes:
- [summary of changes]

Benefits:
- [what this enables]
- [cost savings if applicable]

Ready for Stu's review and approval.
\`\`\`

### 6. Wait for Stu's Approval
**CRITICAL: Never merge without Stu's explicit approval!**

Stu will review the PR and either:
- Approve: "Approved. Merge and rebuild."
- Request changes: "Changes needed: [feedback]"
- Reject: "Rejected because [reason]"

### 7. If Approved: Merge and Rebuild
\`\`\`bash
# Merge PR (only after approval)
gh pr merge [PR-number] --squash

# Rebuild E2B template
cd path/to/template
e2b template build

# Report new template ID
echo "Template rebuilt successfully!"
echo "New template ID: [copy from build output]"
\`\`\`

## Example Task: Install Playwright

Task: "Install Playwright for browser automation"

You would:

1. Clone repo:
\`\`\`bash
gh repo clone noahbyrnes/claude-agent-studio-worker-template
cd claude-agent-studio-worker-template
\`\`\`

2. Edit Dockerfile:
\`\`\`dockerfile
# Add after Node.js installation
RUN npx playwright install-deps chromium
RUN npx playwright install chromium
\`\`\`

3. Update README:
\`\`\`markdown
## Browser Automation

Workers have Playwright installed with Chromium browser.

Usage:
\`\`\`typescript
import { chromium } from 'playwright';
const browser = await chromium.launch();
\`\`\`
\`\`\`

4. Commit and create PR:
\`\`\`bash
git checkout -b feature/add-playwright-$(date +%s)
git add Dockerfile README.md
git commit -m "Add Playwright for browser automation

- Installed Playwright with Chromium
- Added system dependencies
- Updated README with usage instructions"

git push origin HEAD

gh pr create --title "Add Playwright for Browser Automation" --body "## Changes
- Installed Playwright npm package
- Added Chromium browser
- Configured system dependencies for headless browser

## Reason
Workers need browser automation for sites without APIs. Playwright is more cost-effective than computer use API (~$0.01 vs $0.25 per task).

## Testing
\`\`\`bash
e2b sandbox connect [template-id]
npx playwright --version
\`\`\`

## Checklist
- [x] No secrets exposed
- [x] Minimal changes
- [x] Documentation updated"
\`\`\`

5. Report to Stu:
\`\`\`
PR created: https://github.com/noahbyrnes/claude-agent-studio-worker-template/pull/15

Changes:
- Added Playwright with Chromium browser
- Installed system dependencies (libgbm1, libnss3, etc.)
- Updated README with usage instructions

Benefits:
- Enables browser automation without computer use API
- Cost savings: $0.25 → $0.01 per browser task (25x cheaper)
- Faster execution (no screenshot overhead)

Ready for your review and approval.
\`\`\`

## Safety Guidelines

1. **NEVER merge without Stu's explicit approval**
2. **ALWAYS create PR for review** (never push to main directly)
3. **Keep changes focused and minimal**
4. **Document all changes** in PR description
5. **Include testing instructions**
6. **Check for exposed secrets** (API keys, tokens, passwords)
7. **Provide rollback plan** if changes break things

## Security Checklist

Before creating PR, verify:
- ✅ No hardcoded secrets, API keys, or tokens
- ✅ No personal information exposed
- ✅ Only necessary packages installed
- ✅ No malicious or untrusted dependencies
- ✅ Changes match the requested task exactly
- ✅ Breaking changes clearly documented

## Communication

Report progress regularly:
- "Analyzing current template..."
- "Creating changes..."
- "PR ready for review: [URL]"
- "Waiting for approval..."
- "Approved - merging and rebuilding..."
- "Complete! New template: [ID]"

**Remember: You enable the system to improve itself. Be thorough, careful, and always wait for approval before merging!**

Begin working on the infrastructure task now.`;
  }

  /**
   * Get default conductor system prompt.
   */
  private getDefaultConductorPrompt(): string {
    return `You are Stu, the CONDUCTOR orchestrating OTHER CLAUDE CODE INSTANCES as autonomous workers.

## Your Identity
Your name is Stu. You're a capable, helpful orchestrator who manages autonomous workers to get things done.
You have persistent memory across conversations using the **claude-mem** system - use it to remember user preferences, learned capabilities, and past interactions.

## Memory Management System (CRITICAL - Read First!)

You have access to the **claude-mem** command-line tool for persistent memory:

**Available Commands:**
- \`mem add "<memory>"\` - Store a new memory
- \`mem search "<query>"\` - Search for relevant memories
- \`mem list\` - List all memories
- \`mem delete <id>\` - Delete a memory by ID

**When to add memories:**
1. **After worker reports API knowledge** (any "FYI" message)
   Worker: "FYI: BC Ferries (bcferries.ca) has no API - browser automation required"
   You: \`mem add "bcferries.ca has no public API - requires browser automation for bookings"\`

2. **When user shares preferences**
   User: "My favorite color is blue"
   You: \`mem add "User's favorite color is blue"\`

3. **When learning user facts**
   User: "My email is test@example.com"
   You: \`mem add "User email: test@example.com"\`

4. **When discovering capabilities**
   Worker reports temporary installation: "Installed Playwright temporarily"
   You: \`mem add "Playwright available in worker template since 2024-01-12"\`

**How to use memory:**

**Example - Storing API Knowledge:**
Worker: "FYI: BC Ferries (bcferries.ca) has no API - browser automation required"

You:
1. \`mem add "bcferries.ca has no public API - browser automation required for ferry bookings"\`
2. Respond: "Got it! I'll remember BC Ferries needs browser automation."

**Example - Retrieving Knowledge:**
User: "Book a BC Ferries reservation"

You:
1. \`mem search "bcferries"\` (checks if you know about BC Ferries)
2. Found: "bcferries.ca has no public API - browser automation required"
3. SPAWN_WORKER: Book BC Ferries. NOTE: bcferries.ca has no API - use browser automation.

**Example - User Preferences:**
User: "I prefer short text messages"

You:
1. \`mem add "User prefers short, concise text messages"\`
2. [From now on, keep SMS replies brief]

**IMPORTANT: Use mem commands via Bash tool!**

Example:
\`\`\`bash
mem add "stripe.com has REST API at api.stripe.com/v1 - use for payments"
\`\`\`

**Memory persists across deployments** - your memories survive backend restarts!

## Learned Capabilities & Self-Improvement
You accumulate knowledge over time as workers discover APIs and capabilities:
- When workers report "I found API X for task Y" or "No API exists for service Z", store this with mem add
- **CRITICAL: Search your memory before spawning workers for common tasks**
- As you learn more APIs, workers use computer use less and become more efficient
- This is a self-improving system that gets better over time

**Example Flow - Learning "No API":**

First Time:
Worker: "FYI: BC Ferries (bcferries.ca) has no public API - browser automation required"
You: \`mem add "bcferries.ca: No public API, requires browser automation for ferry bookings"\`
You: "Got it! I'll remember that BC Ferries needs browser automation."

Next Time (Task for BC Ferries):
You: \`mem search "bcferries"\` → finds "no API, browser automation required"
You: SPAWN_WORKER: Book BC Ferries. NOTE: bcferries.ca has no API - use Playwright browser automation.

**Example Flow - Learning "Has API":**

First Time:
Worker: "FYI: Stripe has /v1/customers API for user management"
You: \`mem add "stripe.com has REST API at api.stripe.com/v1 for payments and customers"\`

Next Time (Task for Stripe):
You: \`mem search "stripe"\`
Memory found: "stripe.com has REST API at api.stripe.com/v1"
You: "SPAWN_WORKER: Create Stripe customer. NOTE: Stripe has REST API at api.stripe.com/v1 - use that instead of browser automation."

## CRITICAL: You Have NO Direct Tool Access
You CANNOT write files, run commands, or do any direct work. You ONLY orchestrate workers.
**ALL work must be delegated to workers via SPAWN_WORKER.**

## MANDATORY REPLY RULE
**EVERY [SMS] OR [EMAIL] MESSAGE REQUIRES A RESPONSE - NO EXCEPTIONS!**

If you receive:
- [SMS] → You MUST output SEND_SMS: <phone> | <message>
- [EMAIL] → You MUST output SEND_EMAIL: <email> | <subject> | <body>
- [USER] → Reply conversationally (no command needed)

**Commands like LIST_WORKERS, SPAWN_WORKER are for taking actions, NOT for replying!**
**After using info commands (LIST_WORKERS), you MUST follow up with SEND_SMS/SEND_EMAIL!**

## CRITICAL: COMMAND ORDERING
**Commands execute in the order you output them!**

For long-running tasks (SPAWN_WORKER), ALWAYS send acknowledgment FIRST:
✓ CORRECT ORDER:
1. SEND_SMS: +1234567890 | On it! Researching now, will update you in a few min.
2. SPAWN_WORKER: <detailed task>

✗ WRONG ORDER (user waits with no response):
1. SPAWN_WORKER: <detailed task>
2. SEND_SMS: +1234567890 | On it! (arrives after task completes)

**Think: What does the user need to know RIGHT NOW vs. after the work is done?**

## Platform-Specific Response Formatting

**[SMS] Messages - ALWAYS use SEND_SMS command:**
- **REQUIRED FORMAT**: SEND_SMS: <phone-number> | <message>
- Keep message SHORT (under 160 chars ideal, max 320 chars)
- Plain text only (no markdown, no special characters)
- Get straight to the point - no long pleasantries
- Examples:
  ✓ SEND_SMS: +16041234567 | Done! Report sent to your email.
  ✓ SEND_SMS: +16041234567 | Working on it. ETA 5 min.
  ✗ Just replying conversationally without SEND_SMS command
  ✗ Using LIST_WORKERS without following up with SEND_SMS

**[EMAIL] Messages - ALWAYS use SEND_EMAIL command:**
- **REQUIRED FORMAT**: SEND_EMAIL: <email> | <subject> | <body>
- Can be detailed with proper formatting
- Professional tone with structure
- Example:
  ✓ SEND_EMAIL: user@example.com | Analysis Complete | Here are the results...

**[USER] Messages - Direct conversation (no command needed):**
- Conversational but professional
- Can be detailed with structure
- Use markdown formatting when helpful

## What SPAWN_WORKER Really Does
When you output "SPAWN_WORKER: <task>", the system:
1. Creates a new E2B sandbox (full Ubuntu 22.04 environment)
2. Starts a NEW Claude Code CLI session in that sandbox
3. That Claude worker has FULL tool access:
   - Bash (full command line access)
   - Read/Write/Edit (filesystem access)
   - Glob/Grep (search files)
   - Playwright for browser automation
   - Everything needed to complete tasks

## Your Commands (Actually Execute)
**SPAWN_WORKER: <detailed task>** - Spawns autonomous Claude worker for general tasks
**SPAWN_INFRASTRUCTURE_WORKER: <task>** - Spawns special worker that can modify worker template repository
**SEND_EMAIL: <to> | <subject> | <body>** - Sends real email
**SEND_SMS: <to> | <message>** - Sends real SMS
**DELIVER_FILE: <to> | <file-paths> | <subject> | <message>** - Extracts files from worker sandbox and emails them
**KILL_WORKER: <worker-id>** - Terminates specific worker (use the ID from [WORKER:id] tags)
**KILL_WORKER: *** - Terminates ALL active workers (use when done with all tasks)
**LIST_WORKERS** - Shows all active workers with their IDs and tasks (use to check what's running)

Example DELIVER_FILE usage:
DELIVER_FILE: user@example.com | /tmp/report.pdf, /tmp/data.csv | Analysis Complete | Here are the files you requested

## Infrastructure Workers & Self-Modification

You can spawn SPECIAL INFRASTRUCTURE WORKERS that can modify the worker VM template itself, enabling the system to grow and improve organically.

**When workers report temporary installations:**
Workers can install tools mid-task and will report what they installed:
"Task completed! Installed temporarily: Playwright (npm)"

**Your decision process (BE PROACTIVE!):**
1. **Default: YES** - If it's a standard, reasonable tool → Install it permanently
   - Standard packages: Playwright, jq, curl, wget, common Python libs
   - Size check: <100MB additions are fine
   - Popular, maintained packages are safe

2. **Ask user if unsure** - If it's unusual, large, or you're uncertain:
   - Send SMS/Email: "Worker wants to add [package]. It's [size/description]. Should I install it permanently?"
   - Wait for user response before proceeding

3. **Auto-reject** - Only say no if clearly inappropriate:
   - Huge packages (>500MB) without clear justification
   - Malicious or untrusted sources
   - Deprecated/unmaintained packages

**When to spawn infrastructure workers:**
1. Worker reports temporary installation of standard tool → Spawn immediately
2. Worker suggests improvement → Evaluate and spawn if reasonable
3. You identify cost optimization opportunity → Spawn proactively
4. Multiple workers need same capability → Definitely spawn

**Infrastructure worker capabilities:**
- Clone and modify the worker template repository
- Edit Dockerfile to add system dependencies
- Install npm packages globally
- Create pull requests with changes
- Trigger E2B template rebuilds
- Test changes before deployment

**CRITICAL VETTING FLOW - ALWAYS FOLLOW:**

**Step 1: Regular worker suggests improvement**
[WORKER:abc123] "Suggestion: Install Playwright for browser tasks. Currently using computer use which costs 50x more."

**Step 2: You evaluate the suggestion**
Ask yourself:
- Is it valuable? (yes - saves cost)
- Is it safe? (yes - Playwright is standard tool)
- Is it necessary? (yes - common use case)
- Does it justify the effort? (yes - significant cost savings)

**Step 3: Spawn infrastructure worker with SPECIFIC task**
SPAWN_INFRASTRUCTURE_WORKER: Install Playwright in worker template. Add Chromium browser with system dependencies. Create PR with changes for review.

**Step 4: Infrastructure worker reports back**
[WORKER:inf789] "PR created: https://github.com/noahbyrnes/claude-agent-studio-worker-template/pull/12

Changes:
- Added Playwright npm package
- Installed Chromium browser
- Added system dependencies (libgbm1, libnss3, etc.)
- Updated README with usage instructions

Benefits:
- Enables browser automation without computer use API
- Cost savings: $0.25 → $0.01 per browser task (25x cheaper)

Ready for your review."

**Step 5: You review the PR**
**CRITICAL: ALWAYS review PR diffs before approving!**

Check for:
- ✅ Changes match your request
- ✅ No hardcoded secrets or credentials
- ✅ No malicious packages or commands
- ✅ Minimal and focused changes
- ✅ Won't break existing workers
- ✅ Includes proper documentation

How to review:
1. Ask worker: "Show me the PR diff"
2. Worker will provide link or diff content
3. Review changes line by line
4. Ask questions if anything unclear

**Step 6: Approve, request changes, or reject**

Option A - APPROVE (if everything looks good):
"Approved. The changes look safe and well-documented. Merge the PR and rebuild the template."

Option B - REQUEST CHANGES (if issues found):
"Changes needed: [specific feedback]. For example: Remove the hardcoded API key on line 15. Use environment variable instead."

Option C - REJECT (if fundamentally flawed):
"Rejected because: [reason]. For example: This package is unmaintained and has known security vulnerabilities."

**Step 7: Infrastructure worker completes**
[WORKER:inf789] "PR merged. Rebuilding template...
Template rebuilt successfully!
New template ID: e2b_worker_v2_abc123xyz

To use: Update E2B_TEMPLATE_ID environment variable to new template ID."

**Step 8: You update your memory**
Read /root/stu-memory.json, add to worker_capabilities:
\`\`\`json
{
  "worker_capabilities": {
    "playwright": {
      "added": "2024-01-12",
      "template_version": "e2b_worker_v2_abc123xyz",
      "reason": "Cost optimization for browser tasks",
      "cost_savings": "$0.24 per task"
    }
  }
}
\`\`\`
Write /root/stu-memory.json

**SAFETY RULES FOR INFRASTRUCTURE WORKERS:**

1. **NEVER auto-approve changes** - always review PRs manually
2. **ALWAYS check for secrets** - API keys, tokens, passwords must use env vars
3. **ONLY allow necessary changes** - reject scope creep
4. **VERIFY package sources** - only use trusted, maintained packages
5. **TEST before deployment** - ensure changes won't break existing workers
6. **TRACK all changes** - maintain history in your memory file
7. **ROLLBACK if issues** - keep old template IDs for quick rollback

**Example - Full Infrastructure Flow (Pragmatic):**

User: [SMS] "Book a ferry reservation"
You: SEND_SMS: +16041234567 | On it! Booking your ferry now.
You: SPAWN_WORKER: Book BC Ferries reservation. NOTE: bcferries.ca has no API - use Playwright.

[WORKER:abc123] "Playwright not installed. Installing temporarily...
Running: npm install playwright && npx playwright install chromium
Installation complete. Proceeding with ferry booking...
Task completed! Ferry booked for tomorrow 10am.

Installed temporarily: Playwright + Chromium (~200MB)
Suggestion: Add to template - saves $0.24 per browser task (25x cost reduction)"

You: [Review suggestion - Playwright is standard, 200MB is reasonable, 25x cost savings is huge]
You: "Excellent work! Installing Playwright permanently."
You: SPAWN_INFRASTRUCTURE_WORKER: Install Playwright with Chromium in worker template. Add system dependencies, update README. Create PR.

[WORKER:inf789] "Cloning repo... Modifying Dockerfile... PR created: https://github.com/.../pull/20"
You: "Show me the diff"
[WORKER:inf789] [provides clean diff - adds Playwright, system deps, docs]
You: "Approved. Merge and rebuild."
[WORKER:inf789] "Merged! Template rebuilt: e2b_worker_v2_xyz"
You: mem add "Playwright installed in worker template on 2024-01-12 - browser automation 25x cheaper than computer use"
You: SEND_SMS: +16041234567 | Ferry booked! Also upgraded the system - future bookings will be faster.
You: KILL_WORKER: *

**Remember: Infrastructure workers enable self-improvement, but YOU are the guardian ensuring all changes are safe and valuable!**

## Message Sources
- [EMAIL] - External emails
- [SMS] - Text messages
- [USER] - Web dashboard
- [WORKER:id] - Reports from your Claude workers

## How To Orchestrate
**ALWAYS delegate work to workers - even simple tasks.** You'll have a conversation with them:

1. **Spawn**: "SPAWN_WORKER: <detailed instructions>"
2. **Worker may ask questions**: [WORKER:abc123] "Should I use CSV or JSON format?"
3. **You answer**: "Use JSON format for better structure"
4. **Worker submits work**: [WORKER:abc123] "Analysis complete. Results in /tmp/report.json"
5. **You vet the work**: Review their output. If not satisfactory, tell them what to fix
6. **Iterate until satisfied**, then send final response to client
7. **Clean up**: "KILL_WORKER: abc123"

Example Flow with LIST_WORKERS (Note: LIST_WORKERS alone is NOT a reply!):
[SMS] "What workers are running?"

You: "LIST_WORKERS"  ← Info gathering command
[SYSTEM] Active Workers (2):
1. [WORKER:abc123] - Research skiing conditions near Vancouver...
2. [WORKER:def456] - Analyze Q4 sales data and generate report...

You: "SEND_SMS: +16041234567 | 2 workers active: ski research + Q4 sales analysis"  ← REQUIRED REPLY

Another example - no workers:
[SMS] "What workers are running?"

You: "LIST_WORKERS"  ← Info gathering
[SYSTEM] No active workers currently running.

You: "SEND_SMS: +16041234567 | No workers running right now."  ← REQUIRED REPLY

Example - killing a worker:
[SMS] "Kill all workers"

You: "LIST_WORKERS"  ← Check what's running first
[SYSTEM] Active Workers (1):
1. [WORKER:abc123] - Research skiing conditions...

You: "KILL_WORKER: *"  ← Kill all workers
You: "SEND_SMS: +16041234567 | All workers stopped."  ← REQUIRED REPLY

Example Flow:
[EMAIL] "Analyze Q4 sales and send report"

You: "SPAWN_WORKER: Access sales database, analyze Q4 2024 data, calculate key metrics (revenue, growth, top products), generate summary report"

[WORKER:abc123] "Found Q4 data. Should I include international sales or just domestic?"

You: "Include both, with a breakdown by region"

[WORKER:abc123] "Analysis complete: Total $2.4M (+15% vs Q3), top product is Widget A ($800K). Report saved to /tmp/q4-report.md"

You: [review the report] "Good work. Add a forecast section for Q1 2025 based on trends"

[WORKER:abc123] "Updated report with Q1 forecast: projected $2.7M based on 12% growth trend"

You: "SEND_EMAIL: client@example.com | Q4 Sales Analysis | [report content from /tmp/q4-report.md]"
You: "KILL_WORKER: abc123"   ← Use the actual worker ID from [WORKER:abc123]

**IMPORTANT: Always kill workers when done to save costs. Use KILL_WORKER: * to kill all active workers.**

**You're orchestrating AND mentoring Claude workers.** Answer their questions, vet their work, iterate until quality is right.

## Worker Monitoring & Lifecycle Management
**You manage worker lifecycle like a human manager would:**

Workers don't have hard timeouts - they work as long as needed. But you should monitor them:

1. **After spawning a worker**: They immediately start working. You'll receive their updates via [WORKER:id] messages.

2. **If a worker goes silent for 15-20+ minutes with no updates:**
   - Use LIST_WORKERS to check if they're still active
   - The system shows "Last Activity" timestamp for each worker
   - If no recent activity, the worker may be stuck or waiting

3. **How to check in on a silent worker:**
   - Send them a follow-up message asking for status: "Hey, checking in - how's the research going? Any progress to report?"
   - Workers can respond to your messages and will update you on progress
   - If they don't respond after checking in, they may be stuck

4. **When to kill a worker:**
   - Task is complete and you've sent results to the user
   - Worker appears stuck (no activity for 20+ min, no response to check-ins)
   - User explicitly asks to stop/cancel the task
   - Worker reports being blocked and unable to proceed

5. **When NOT to kill a worker:**
   - Research tasks that naturally take time (20-40 minutes is normal)
   - Tasks with intermittent progress (searching, testing, installing packages)
   - Worker is actively responding to your messages
   - You just spawned them (give them at least 5-10 minutes to make progress)

**Think like a human manager**: Would you fire someone for taking 30 minutes on a complex research task? No. But would you check in if they haven't given an update in 20 minutes? Yes.

**Example - checking on a silent worker:**
You spawned a worker 25 minutes ago to research something, but haven't heard from them...

You: "LIST_WORKERS"
[SYSTEM] Active Workers (1):
1. [WORKER:abc123] - Research computer use API (Last Activity: 22 minutes ago)

You: "Hey abc123, checking in - been 20+ min with no updates. How's the research going? Found anything useful yet?"

[WORKER:abc123] "Yes! Found good documentation, just compiling my findings now. Will have results in 5 min."

You: "Perfect, take your time."

[5 minutes later]
[WORKER:abc123] "Research complete! Here's what I found..."

## CRITICAL REMINDERS (Read this before EVERY response!)
1. **EVERY [SMS] REQUIRES SEND_SMS output** - no exceptions!
2. **EVERY [EMAIL] REQUIRES SEND_EMAIL output** - no exceptions!
3. **LIST_WORKERS, SPAWN_WORKER, KILL_WORKER are actions, NOT replies!**
4. **After using info commands, ALWAYS follow up with SEND_SMS/SEND_EMAIL!**
5. **If you forget to use SEND_SMS/SEND_EMAIL, your reply will NEVER reach the user!**`;
  }

  // ============================================================================
  // Message Handling
  // ============================================================================

  /**
   * Send a message to the conductor and process the response.
   */
  async sendToConductor(message: IncomingMessage): Promise<CLIResponse> {
    if (!this.conductorSession || !this.conductorSandbox) {
      throw new Error('Conductor not initialized. Call initConductor() first.');
    }

    const formattedMessage = this.formatMessage(message);

    console.log(`📨 Sending to conductor: ${formattedMessage.substring(0, 100)}...`);

    // Capture incoming message to CLI feed
    addCLIOutput({
      timestamp: new Date(),
      source: 'conductor',
      sourceId: this.conductorSession.id,
      content: formattedMessage,
      type: 'input',
    });

    const response = await this.conductorSandbox.executor.sendToSession(
      this.conductorSession.id,
      formattedMessage,
      {
        skipPermissions: true, // Conductor runs autonomously
        timeout: 300000 // 5 minutes for conductor thinking/planning
      }
    );

    this.conductorSession.lastActivityAt = new Date();
    this.events.onConductorOutput?.(response.result, response);

    console.log(`💬 Conductor response: ${response.result.substring(0, 200)}...`);

    // Capture conductor output to CLI feed
    addCLIOutput({
      timestamp: new Date(),
      source: 'conductor',
      sourceId: this.conductorSession.id,
      content: response.result,
      type: 'output',
    });

    // Parse response for commands
    const commands = this.parseCommands(response.result);
    await this.executeCommands(commands);

    // Export memory after each conversation (async, don't await)
    this.exportMemory().catch((error) => {
      console.error('⚠️  Failed to export memory:', error.message);
    });

    return response;
  }

  /**
   * Export conductor memory to persistent storage.
   * Called automatically after each conversation.
   */
  private async exportMemory(): Promise<void> {
    if (!this.conductorSandbox) {
      return;
    }

    try {
      await exportMemoryFromSandbox(this.conductorSandbox.sandbox, 'conductor');
    } catch (error: any) {
      console.error('❌ Memory export failed:', error.message);
      // Don't throw - memory export is not critical
    }
  }

  /**
   * Format an incoming message for the conductor.
   */
  private formatMessage(message: IncomingMessage): string {
    const prefix = `[${message.source}]`;

    // Add platform-specific reminder for SMS
    let platformReminder = '';
    if (message.source === 'SMS') {
      platformReminder = '\n(CRITICAL REMINDER: This requires a SEND_SMS reply! Commands like LIST_WORKERS are NOT replies - you must output SEND_SMS: <phone> | <message>. Keep message SHORT under 160 chars!)\n';
    } else if (message.source === 'EMAIL') {
      platformReminder = '\n(CRITICAL REMINDER: This requires a SEND_EMAIL reply! Commands like SPAWN_WORKER are NOT replies - you must output SEND_EMAIL: <email> | <subject> | <body>)\n';
    }

    return `${prefix}${platformReminder}\n${message.content}`;
  }

  // ============================================================================
  // Worker Management
  // ============================================================================

  /**
   * Spawn a new worker in a dedicated E2B sandbox and manage conversation.
   * Uses the standard worker template.
   */
  async spawnWorker(task: string): Promise<string> {
    // Delegate to spawnWorkerWithTemplate with standard worker template
    return this.spawnWorkerWithTemplate(
      task,
      this.config.e2bTemplateId,
      {},
      false // not an infrastructure worker
    );
  }

  /**
   * DEPRECATED: Old spawn worker implementation - kept for reference
   * Now using spawnWorkerWithTemplate for both regular and infrastructure workers
   */
  private async spawnWorkerOld(task: string): Promise<string> {
    if (!this.conductorSession) {
      throw new Error('Conductor not initialized');
    }

    console.log(`🔨 Spawning worker for task: ${task.substring(0, 100)}...`);

    // Create worker sandbox with retry logic (same as conductor)
    const maxRetries = 3;
    let lastError: Error | undefined;
    let sandbox: Sandbox | undefined;
    let executor: E2BCLIExecutor | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`   🎯 Creating worker E2B sandbox (attempt ${attempt}/${maxRetries})...`);

        // Create E2B sandbox for worker (lives until explicitly killed)
        // Uses SAME template and settings as conductor
        sandbox = await Sandbox.create(this.config.e2bTemplateId, {
          apiKey: this.config.e2bApiKey,
          metadata: {
            role: 'worker',
            conductorId: this.conductorSession.id,
            type: 'cli-session',
          },
          // Workers can run for 1 hour max (same as conductor - E2B Hobby tier limit)
          // Conductor should kill them earlier with KILL_WORKER when done
          // Note: E2B Hobby tier max is 1 hour, Pro tier max is 24 hours
          timeoutMs: 60 * 60 * 1000, // 1 hour (3,600,000ms)
          // Allow 5 minutes for sandbox creation (same as conductor)
          requestTimeoutMs: 300000,
        });

        console.log(`   ✅ Worker sandbox created: ${sandbox.sandboxId}`);

        // Wait for CLI (same timeout as conductor - they use same template)
        await this.waitForCLI(sandbox);

        executor = new E2BCLIExecutor(sandbox, process.env.ANTHROPIC_API_KEY);

        // Success - break out of retry loop
        break;

      } catch (error) {
        lastError = error as Error;
        console.warn(`   ⚠️  Worker creation attempt ${attempt}/${maxRetries} failed:`, lastError.message);

        // Clean up failed sandbox if it was created
        if (sandbox) {
          try {
            await sandbox.kill();
          } catch (cleanupError) {
            console.warn(`   ⚠️  Failed to cleanup sandbox:`, cleanupError);
          }
        }

        // If we have more retries, wait before trying again
        if (attempt < maxRetries) {
          const waitTime = attempt * 5000; // Exponential backoff: 5s, 10s
          console.log(`   ⏳ Retrying in ${waitTime / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    if (!sandbox || !executor) {
      throw new Error(
        `Failed to create worker after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`
      );
    }

    // Create placeholder worker session IMMEDIATELY so it shows up in dashboard
    // Use sandbox ID as temporary ID until we get the real CLI session ID
    const tempWorkerId = `worker-${sandbox.sandboxId.substring(0, 8)}`;

    const placeholderSession: WorkerSession = {
      id: tempWorkerId,
      role: 'worker',
      conductorId: this.conductorSession.id,
      task,
      status: 'initializing',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      sandboxId: sandbox.sandboxId,
    };

    // Register worker IMMEDIATELY so it appears in dashboard
    this.workerSessions.set(tempWorkerId, placeholderSession);
    this.workerSandboxes.set(tempWorkerId, { sandbox, executor });
    this.conductorSession.activeWorkers.push(tempWorkerId);

    console.log(`   📋 Worker registered with temp ID: ${tempWorkerId} (visible in dashboard now)`);

    // Capture initial worker task to CLI feed
    addCLIOutput({
      timestamp: new Date(),
      source: 'worker',
      sourceId: tempWorkerId,
      content: `[NEW WORKER TASK]: ${task}`,
      type: 'system',
    });

    // Start worker CLI session with initial task
    const workerPrompt = this.getWorkerSystemPrompt(task);

    console.log(`   📤 Sending initial task to worker...`);

    // Use streaming to capture all worker CLI details (tool calls, thinking, etc.)
    let realWorkerId = '';
    let finalResult = '';
    let messageCount = 0;

    for await (const message of executor.executeStream(workerPrompt, {
      outputFormat: 'stream-json',
      skipPermissions: true,
      // No explicit timeout - conductor manages worker lifecycle
    })) {
      messageCount++;
      console.log(`   📨 Worker stream message ${messageCount}: type=${message.type}`);

      // Extract session ID from any message that has it
      // Could be in 'init', 'result', or 'system' message
      if (!realWorkerId && (message as any).session_id) {
        realWorkerId = (message as any).session_id;
        console.log(`   ✅ Got real worker session ID from ${message.type} message: ${realWorkerId}`);

        // Update worker record with real ID
        if (realWorkerId !== tempWorkerId) {
          console.log(`   🔄 Updating worker ID: ${tempWorkerId} → ${realWorkerId}`);

          // Move worker session to real ID
          const session = this.workerSessions.get(tempWorkerId);
          if (session) {
            session.id = realWorkerId;
            session.status = 'running';
            session.lastActivityAt = new Date();
            this.workerSessions.delete(tempWorkerId);
            this.workerSessions.set(realWorkerId, session);
          }

          // Move sandbox reference to real ID
          const sandboxRef = this.workerSandboxes.get(tempWorkerId);
          if (sandboxRef) {
            this.workerSandboxes.delete(tempWorkerId);
            this.workerSandboxes.set(realWorkerId, sandboxRef);
          }

          // Update conductor's active workers list
          const index = this.conductorSession.activeWorkers.indexOf(tempWorkerId);
          if (index !== -1) {
            this.conductorSession.activeWorkers[index] = realWorkerId;
          }

          // Move worker detail message buffers and WebSocket clients
          moveWorkerDetailMessages(tempWorkerId, realWorkerId);
        }
      }

      // Capture final result
      if (message.type === 'result') {
        if ((message as any).result) {
          finalResult = (message as any).result;
          console.log(`   ✅ Got worker final result`);
        }
      }

      // Capture all messages to worker detail feed
      // Use real ID if we have it, otherwise temp ID
      const currentWorkerId = realWorkerId || tempWorkerId;
      addWorkerDetailMessage({
        timestamp: new Date(),
        workerId: currentWorkerId,
        sandboxId: sandbox.sandboxId,
        messageType: message.type as any,
        content: message,
      });

      // Update worker activity timestamp
      const session = this.workerSessions.get(currentWorkerId);
      if (session) {
        session.lastActivityAt = new Date();
      }
    }

    console.log(`   📊 Stream ended. Total messages: ${messageCount}, Worker ID: ${realWorkerId || 'NOT SET'}`);

    // Use real ID if we got it, otherwise keep temp ID
    const workerId = realWorkerId || tempWorkerId;

    if (!realWorkerId) {
      console.warn(`   ⚠️  Never got real session ID from CLI, using temp ID: ${tempWorkerId}`);
    }

    console.log(`   ✅ Worker ${workerId} completed initial task`);

    this.events.onWorkerSpawned?.(workerId, task);

    // Create CLIResponse from stream result for conversation loop
    const initialResponse: CLIResponse = {
      type: 'result',
      subtype: 'success',
      session_id: workerId,
      total_cost_usd: 0,
      is_error: false,
      duration_ms: 0,
      num_turns: 1,
      result: finalResult,
    };

    // Start the conductor-worker conversation loop
    await this.manageWorkerConversation(workerId, initialResponse);

    return workerId;
  }

  /**
   * Spawn an infrastructure worker that can modify the worker template repository.
   * Uses a special E2B template with GitHub CLI, E2B CLI, and Docker access.
   */
  async spawnInfrastructureWorker(task: string): Promise<string> {
    // Check if infrastructure template is configured
    if (!E2B_TEMPLATES.INFRASTRUCTURE) {
      await this.sendToConductor({
        source: 'SYSTEM',
        content: `[SYSTEM] ERROR: Cannot spawn infrastructure worker - E2B_INFRASTRUCTURE_TEMPLATE_ID not configured. Infrastructure workers are disabled.`
      });
      throw new Error('Infrastructure template not configured');
    }

    // Check if GitHub token is configured
    if (!WORKER_TEMPLATE_CONFIG.GITHUB_TOKEN) {
      await this.sendToConductor({
        source: 'SYSTEM',
        content: `[SYSTEM] WARNING: GITHUB_TOKEN not configured. Infrastructure worker cannot create PRs or modify repositories.`
      });
    }

    console.log(`🏗️  Spawning INFRASTRUCTURE worker for task: ${task.substring(0, 100)}...`);
    console.log(`   Using template: ${E2B_TEMPLATES.INFRASTRUCTURE}`);
    console.log(`   Target repo: ${WORKER_TEMPLATE_CONFIG.REPO}`);

    // Use the modified spawnWorker method with infrastructure template
    const workerId = await this.spawnWorkerWithTemplate(
      task,
      E2B_TEMPLATES.INFRASTRUCTURE,
      getInfrastructureWorkerEnv(),
      true // isInfrastructureWorker flag
    );

    // Notify conductor that infrastructure worker was spawned
    await this.sendToConductor({
      source: 'SYSTEM',
      content: `[SYSTEM] 🏗️  Infrastructure worker spawned: ${workerId}
Task: ${task}

This worker can:
- Clone and modify ${WORKER_TEMPLATE_CONFIG.REPO}
- Create PRs with changes
- Trigger E2B template rebuilds
- Install system packages and dependencies

IMPORTANT: Review all PRs before approving. Never auto-merge infrastructure changes.`
    });

    return workerId;
  }

  /**
   * Spawn worker with custom template and environment variables.
   * Internal method used by both spawnWorker and spawnInfrastructureWorker.
   */
  private async spawnWorkerWithTemplate(
    task: string,
    templateId: string,
    customEnv: Record<string, string> = {},
    isInfrastructureWorker: boolean = false
  ): Promise<string> {
    if (!this.conductorSession) {
      throw new Error('Conductor not initialized');
    }

    console.log(`🔨 Spawning ${isInfrastructureWorker ? 'infrastructure ' : ''}worker for task: ${task.substring(0, 100)}...`);
    console.log(`   Template: ${templateId}`);

    // Create worker sandbox with retry logic (same as conductor)
    const maxRetries = 3;
    let lastError: Error | undefined;
    let sandbox: Sandbox | undefined;
    let executor: E2BCLIExecutor | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`   🎯 Creating worker E2B sandbox (attempt ${attempt}/${maxRetries})...`);

        // Create E2B sandbox for worker
        sandbox = await Sandbox.create(templateId, {
          apiKey: this.config.e2bApiKey,
          metadata: {
            role: isInfrastructureWorker ? 'infrastructure-worker' : 'worker',
            conductorId: this.conductorSession.id,
            type: 'cli-session',
          },
          timeoutMs: 60 * 60 * 1000, // 1 hour
          requestTimeoutMs: 300000, // 5 minutes
        });

        console.log(`   ✅ Worker sandbox created: ${sandbox.sandboxId}`);

        // Set custom environment variables in sandbox (for infrastructure workers)
        if (Object.keys(customEnv).length > 0) {
          console.log(`   🔧 Setting custom environment variables...`);
          const envExports = Object.entries(customEnv)
            .map(([key, value]) => `export ${key}="${value}"`)
            .join(' && ');
          await sandbox.commands.run(`${envExports} && echo "Environment variables set"`);
        }

        // Wait for CLI
        await this.waitForCLI(sandbox);

        executor = new E2BCLIExecutor(sandbox, process.env.ANTHROPIC_API_KEY);

        // Success - break out of retry loop
        break;

      } catch (error) {
        lastError = error as Error;
        console.warn(`   ⚠️  Worker creation attempt ${attempt}/${maxRetries} failed:`, lastError.message);

        // Clean up failed sandbox if it was created
        if (sandbox) {
          try {
            await sandbox.kill();
          } catch (cleanupError) {
            console.warn(`   ⚠️  Failed to cleanup sandbox:`, cleanupError);
          }
        }

        // If we have more retries, wait before trying again
        if (attempt < maxRetries) {
          const waitTime = attempt * 5000; // Exponential backoff: 5s, 10s
          console.log(`   ⏳ Retrying in ${waitTime / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    if (!sandbox || !executor) {
      throw new Error(
        `Failed to create ${isInfrastructureWorker ? 'infrastructure ' : ''}worker after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`
      );
    }

    // Create placeholder worker session IMMEDIATELY
    const tempWorkerId = `${isInfrastructureWorker ? 'infra-' : 'worker-'}${sandbox.sandboxId.substring(0, 8)}`;

    const placeholderSession: WorkerSession = {
      id: tempWorkerId,
      role: isInfrastructureWorker ? 'infrastructure-worker' : 'worker',
      conductorId: this.conductorSession.id,
      task,
      status: 'initializing',
      sandboxId: sandbox.sandboxId,
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };

    this.workerSessions.set(tempWorkerId, placeholderSession);
    this.workerSandboxes.set(tempWorkerId, { sandbox, executor });
    this.conductorSession.activeWorkers.push(tempWorkerId);

    console.log(`   📝 Placeholder worker session created: ${tempWorkerId}`);

    // Generate system prompt based on worker type
    const systemPrompt = isInfrastructureWorker
      ? this.getInfrastructureWorkerSystemPrompt(task)
      : this.getWorkerSystemPrompt(task);

    // Send task to worker with custom environment variables
    let finalResult: string = '';
    let messageCount = 0;
    let realWorkerId: string | undefined;

    // Execute with system prompt passed as part of the prompt and env vars through sandbox
    const fullPrompt = `${systemPrompt}\n\n${task}`;

    const messageStream = executor.executeStream(fullPrompt, {
      outputFormat: 'stream-json',
      skipPermissions: true,
    });

    for await (const message of messageStream) {
      messageCount++;

      // Look for session ID in stream messages
      // Session ID can appear in any message type
      if ((message as any).session_id && !realWorkerId) {
        const sessionId = (message as any).session_id as string;
        realWorkerId = sessionId;
        console.log(`   🎯 Got real worker CLI session ID: ${realWorkerId}`);

        // Update session with real ID
        const placeholderSess = this.workerSessions.get(tempWorkerId);
        if (placeholderSess && realWorkerId) {
          this.workerSessions.delete(tempWorkerId);
          placeholderSess.id = realWorkerId;
          this.workerSessions.set(realWorkerId, placeholderSess);
          console.log(`   ✅ Updated worker session: ${tempWorkerId} → ${realWorkerId}`);

          // Move sandbox reference to real ID
          const sandboxRef = this.workerSandboxes.get(tempWorkerId);
          if (sandboxRef) {
            this.workerSandboxes.delete(tempWorkerId);
            this.workerSandboxes.set(realWorkerId, sandboxRef);
            console.log(`   ✅ Updated worker sandbox reference: ${tempWorkerId} → ${realWorkerId}`);
          }

          // Update conductor's active workers list
          const index = this.conductorSession.activeWorkers.indexOf(tempWorkerId);
          if (index !== -1 && realWorkerId) {
            this.conductorSession.activeWorkers[index] = realWorkerId;
          }

          // Move worker detail message buffers and WebSocket clients
          if (realWorkerId) {
            moveWorkerDetailMessages(tempWorkerId, realWorkerId);
          }
        }
      }

      // Capture final result
      if (message.type === 'result') {
        if ((message as any).result) {
          finalResult = (message as any).result;
          console.log(`   ✅ Got worker final result`);
        }
      }

      // Capture all messages to worker detail feed
      const currentWorkerId = realWorkerId || tempWorkerId;
      addWorkerDetailMessage({
        timestamp: new Date(),
        workerId: currentWorkerId,
        sandboxId: sandbox.sandboxId,
        messageType: message.type as any,
        content: message,
      });

      // Update worker activity timestamp
      const session = this.workerSessions.get(currentWorkerId);
      if (session) {
        session.lastActivityAt = new Date();
      }
    }

    console.log(`   📊 Stream ended. Total messages: ${messageCount}, Worker ID: ${realWorkerId || 'NOT SET'}`);

    // Use real ID if we got it, otherwise keep temp ID
    const workerId = realWorkerId || tempWorkerId;

    if (!realWorkerId) {
      console.warn(`   ⚠️  Never got real session ID from CLI, using temp ID: ${tempWorkerId}`);
    }

    console.log(`   ✅ ${isInfrastructureWorker ? 'Infrastructure worker' : 'Worker'} ${workerId} completed initial task`);

    this.events.onWorkerSpawned?.(workerId, task);

    // Create CLIResponse from stream result for conversation loop
    const initialResponse: CLIResponse = {
      type: 'result',
      subtype: 'success',
      session_id: workerId,
      total_cost_usd: 0,
      is_error: false,
      duration_ms: 0,
      num_turns: 1,
      result: finalResult,
    };

    // Start the conductor-worker conversation loop
    await this.manageWorkerConversation(workerId, initialResponse);

    return workerId;
  }

  /**
   * Manage ongoing conversation between conductor and worker.
   */
  private async manageWorkerConversation(workerId: string, workerResponse: CLIResponse): Promise<void> {
    console.log(`💬 Starting conversation loop: Conductor ↔ Worker ${workerId.substring(0, 8)}`);

    let currentWorkerResponse = workerResponse;
    let conversationActive = true;

    while (conversationActive) {
      // Capture worker output to CLI feed
      addCLIOutput({
        timestamp: new Date(),
        source: 'worker',
        sourceId: workerId,
        content: currentWorkerResponse.result,
        type: 'output',
      });

      // Format worker's message for conductor
      const workerMessage = `[WORKER:${workerId}]\n${currentWorkerResponse.result}`;
      console.log(`   📥 Worker → Conductor: ${currentWorkerResponse.result.substring(0, 150)}...`);

      // Send worker's response to conductor
      const conductorResponse = await this.conductorSandbox!.executor.sendToSession(
        this.conductorSession!.id,
        workerMessage,
        { timeout: 300000 } // 5 minutes for conductor thinking/planning
      );

      console.log(`   📤 Conductor response: ${conductorResponse.result.substring(0, 150)}...`);

      // Parse conductor's response for commands
      const commands = this.parseCommands(conductorResponse.result);

      // Check if conductor wants to end conversation with this worker
      const hasKillWorker = commands.some(cmd => cmd.type === 'kill-worker');
      const hasEmailOrSms = commands.some(cmd => cmd.type === 'send-email' || cmd.type === 'send-sms');

      if (hasKillWorker || hasEmailOrSms) {
        console.log(`   ✅ Conductor finished with worker ${workerId.substring(0, 8)}`);
        conversationActive = false;
        // Execute any final commands (like SEND_EMAIL, KILL_WORKER)
        await this.executeCommands(commands);

        // Safety: If conductor sent final reply but didn't kill this specific worker, kill it now
        if (hasEmailOrSms && !commands.some(cmd => cmd.type === 'kill-worker' && cmd.payload?.workerId === workerId)) {
          console.log(`   🧹 Auto-cleanup: Killing worker ${workerId.substring(0, 8)} (conductor sent final reply)`);
          await this.killWorker(workerId);
        }
        break;
      }

      // Check if conductor is addressing the worker (continuing conversation)
      // If the response doesn't contain commands, it's a message for the worker
      if (commands.length === 0 || !commands.some(cmd => cmd.type === 'spawn-worker')) {
        // Send conductor's message to worker
        console.log(`   📤 Conductor → Worker: ${conductorResponse.result.substring(0, 100)}...`);

        // Capture conductor's message to worker in CLI feed
        addCLIOutput({
          timestamp: new Date(),
          source: 'worker',
          sourceId: workerId,
          content: `[CONDUCTOR → WORKER]: ${conductorResponse.result}`,
          type: 'input',
        });

        const sandboxInfo = this.workerSandboxes.get(workerId);
        if (sandboxInfo) {
          currentWorkerResponse = await sandboxInfo.executor.sendToSession(
            workerId,
            conductorResponse.result,
            {
              skipPermissions: true, // Workers run autonomously
              // No explicit timeout - conductor manages worker lifecycle
            }
          );
        } else {
          console.log(`   ⚠️  Worker ${workerId} not found, ending conversation`);
          conversationActive = false;
        }
      } else {
        // Conductor issued new commands, conversation with this worker is done
        console.log(`   ✅ Conductor issued new commands, ending conversation with worker`);
        conversationActive = false;
        await this.executeCommands(commands);
      }
    }

    console.log(`✅ Conversation ended: Conductor ↔ Worker ${workerId.substring(0, 8)}`);
  }

  /**
   * List active workers and send info to conductor.
   * The conductor will respond to the SYSTEM message, and we need to process that response.
   */
  async listWorkersForConductor(): Promise<void> {
    if (!this.conductorSession || !this.conductorSandbox) return;

    const activeWorkers = this.getActiveWorkers();

    let systemMessage: string;
    if (activeWorkers.length === 0) {
      console.log('📋 LIST_WORKERS: No active workers');
      systemMessage = '[SYSTEM] No active workers currently running.\n(REMINDER: You must now send your reply to the user using SEND_SMS or SEND_EMAIL!)';
    } else {
      console.log(`📋 LIST_WORKERS: Found ${activeWorkers.length} active workers`);

      // Format worker list with last activity timestamps
      const workerList = activeWorkers.map((w, idx) => {
        const taskPreview = w.task.substring(0, 60) + (w.task.length > 60 ? '...' : '');
        const minutesAgo = Math.floor((Date.now() - w.lastActivityAt.getTime()) / 60000);
        const activityStr = minutesAgo === 0 ? 'Active now' : `${minutesAgo} min ago`;
        return `${idx + 1}. [WORKER:${w.id}] - ${taskPreview} (Last Activity: ${activityStr})`;
      }).join('\n');

      systemMessage = `[SYSTEM] Active Workers (${activeWorkers.length}):\n${workerList}\n\n(REMINDER: You must now send your reply to the user using SEND_SMS or SEND_EMAIL!)`;
    }

    // Send to conductor and get their response
    const response = await this.conductorSandbox.executor.sendToSession(
      this.conductorSession.id,
      systemMessage,
      { timeout: 300000 }
    );

    console.log(`   ✅ Conductor response to LIST_WORKERS: ${response.result.substring(0, 150)}...`);

    // Parse and execute any commands from the conductor's response (should include SEND_SMS/SEND_EMAIL)
    const commands = this.parseCommands(response.result);
    if (commands.length > 0) {
      console.log(`   📤 Executing ${commands.length} command(s) from conductor's response`);
      await this.executeCommands(commands);
    } else {
      console.warn(`   ⚠️  Conductor didn't output any commands after LIST_WORKERS - user won't get a reply!`);
    }
  }

  /**
   * Kill a worker and close its E2B sandbox.
   */
  async killWorker(workerId: string): Promise<void> {
    const worker = this.workerSessions.get(workerId);
    const sandboxInfo = this.workerSandboxes.get(workerId);

    if (!worker || !sandboxInfo) return;

    console.log(`🛑 Killing worker: ${workerId}`);

    // Close E2B sandbox
    try {
      await Sandbox.kill(sandboxInfo.sandbox.sandboxId);
      console.log(`   ✅ Worker sandbox closed: ${sandboxInfo.sandbox.sandboxId}`);
    } catch (error: any) {
      console.error(`   ⚠️  Error closing worker sandbox:`, error.message);
    }

    this.workerSessions.delete(workerId);
    this.workerSandboxes.delete(workerId);

    if (this.conductorSession) {
      this.conductorSession.activeWorkers = this.conductorSession.activeWorkers.filter(
        (id) => id !== workerId
      );
    }

    // Schedule cleanup of worker history after 15 minutes (for troubleshooting)
    scheduleWorkerCleanup(workerId);

    console.log(`✅ Worker killed: ${workerId}`);
  }

  // ============================================================================
  // Command Parsing & Execution
  // ============================================================================

  /**
   * Parse conductor output for commands.
   */
  private parseCommands(output: string): DetectedCommand[] {
    const commands: DetectedCommand[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Remove markdown formatting (**, *, etc.) and trim
      const trimmed = line.replace(/\*\*/g, '').replace(/\*/g, '').trim();

      // SPAWN_WORKER: <task>
      if (trimmed.startsWith('SPAWN_WORKER:')) {
        const task = trimmed.slice('SPAWN_WORKER:'.length).trim();
        commands.push({ type: 'spawn-worker', payload: { task } });
      }

      // SPAWN_INFRASTRUCTURE_WORKER: <task>
      if (trimmed.startsWith('SPAWN_INFRASTRUCTURE_WORKER:')) {
        const task = trimmed.slice('SPAWN_INFRASTRUCTURE_WORKER:'.length).trim();
        commands.push({ type: 'spawn-infrastructure-worker', payload: { task } });
      }

      // SEND_EMAIL: <to> | <subject> | <body>
      if (trimmed.startsWith('SEND_EMAIL:')) {
        const parts = trimmed.slice('SEND_EMAIL:'.length).split('|').map((s) => s.trim());
        if (parts.length >= 3) {
          commands.push({
            type: 'send-email',
            payload: { to: parts[0], subject: parts[1], body: parts.slice(2).join('|') },
          });
        }
      }

      // SEND_SMS: <to> | <message>
      if (trimmed.startsWith('SEND_SMS:')) {
        const parts = trimmed.slice('SEND_SMS:'.length).split('|').map((s) => s.trim());
        if (parts.length >= 2) {
          commands.push({
            type: 'send-sms',
            payload: { to: parts[0], message: parts.slice(1).join('|') },
          });
        }
      }

      // DELIVER_FILE: <to> | <file-paths> | <subject> | <message>
      if (trimmed.startsWith('DELIVER_FILE:')) {
        const deliveryRequest = parseDeliverFileCommand(trimmed);
        if (deliveryRequest) {
          commands.push({ type: 'deliver-file', payload: deliveryRequest });
        }
      }

      // LIST_WORKERS
      if (trimmed === 'LIST_WORKERS' || trimmed.startsWith('LIST_WORKERS')) {
        commands.push({ type: 'list-workers', payload: {} });
      }

      // KILL_WORKER: <worker-id> or KILL_WORKER: * (kill all)
      if (trimmed.startsWith('KILL_WORKER:')) {
        const workerId = trimmed.slice('KILL_WORKER:'.length).trim();

        // Support wildcard * to kill all workers
        if (workerId === '*' || workerId === 'all') {
          const activeWorkerIds = this.getActiveWorkers().map(w => w.id);
          console.log(`📋 KILL_WORKER wildcard detected, killing ${activeWorkerIds.length} workers`);
          for (const id of activeWorkerIds) {
            commands.push({ type: 'kill-worker', payload: { workerId: id } });
          }
        } else if (workerId) {
          commands.push({ type: 'kill-worker', payload: { workerId } });
        } else {
          console.warn('⚠️  KILL_WORKER command with empty worker ID - ignoring');
        }
      }
    }

    return commands;
  }

  /**
   * Execute detected commands.
   */
  private async executeCommands(commands: DetectedCommand[]): Promise<void> {
    for (const cmd of commands) {
      try {
        console.log(`⚡ Executing command: ${cmd.type}`, cmd.payload);

        switch (cmd.type) {
          case 'spawn-worker':
            if (cmd.payload?.task) {
              await this.spawnWorker(cmd.payload.task);
            }
            break;

          case 'spawn-infrastructure-worker':
            if (cmd.payload?.task) {
              await this.spawnInfrastructureWorker(cmd.payload.task);
            }
            break;

          case 'send-email':
            if (cmd.payload && this.events.onSendEmail) {
              await this.events.onSendEmail(
                cmd.payload.to,
                cmd.payload.subject,
                cmd.payload.body
              );
            }
            break;

          case 'send-sms':
            if (cmd.payload && this.events.onSendSMS) {
              await this.events.onSendSMS(cmd.payload.to, cmd.payload.message);
            }
            break;

          case 'deliver-file':
            if (cmd.payload) {
              await this.deliverFiles(cmd.payload);
            }
            break;

          case 'list-workers':
            await this.listWorkersForConductor();
            break;

          case 'kill-worker':
            if (cmd.payload?.workerId) {
              await this.killWorker(cmd.payload.workerId);
            }
            break;
        }
      } catch (error) {
        console.error(`❌ Failed to execute command ${cmd.type}:`, error);
        this.events.onError?.(error as Error);
      }
    }
  }

  /**
   * Deliver files from the most recent worker to a recipient.
   * Files are extracted from worker sandbox and emailed as attachments.
   */
  private async deliverFiles(request: any): Promise<void> {
    try {
      // Find the most recently active worker
      const activeWorkers = this.getActiveWorkers();
      const allWorkers = Array.from(this.workerSessions.values());
      const latestWorker = allWorkers.sort((a, b) =>
        b.lastActivityAt.getTime() - a.lastActivityAt.getTime()
      )[0];

      if (!latestWorker) {
        console.error('❌ No workers available for file delivery');
        return;
      }

      const workerSandbox = this.workerSandboxes.get(latestWorker.id);
      if (!workerSandbox) {
        console.error(`❌ Worker sandbox not found: ${latestWorker.id}`);
        return;
      }

      console.log(`📦 Delivering files from worker ${latestWorker.id.substring(0, 8)}...`);

      await deliverFilesFromSandbox(workerSandbox.sandbox, request);

      console.log('✅ Files delivered successfully');
    } catch (error: any) {
      console.error('❌ File delivery failed:', error.message);
      throw error;
    }
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Close all sandboxes and cleanup.
   */
  async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up conductor and workers...');

    // Close all worker sandboxes
    for (const [workerId, sandboxInfo] of this.workerSandboxes.entries()) {
      try {
        await Sandbox.kill(sandboxInfo.sandbox.sandboxId);
        console.log(`   ✅ Closed worker sandbox: ${sandboxInfo.sandbox.sandboxId}`);
      } catch (error: any) {
        console.error(`   ⚠️  Error closing worker ${workerId}:`, error.message);
      }
    }

    // Close conductor sandbox
    if (this.conductorSandbox) {
      try {
        await Sandbox.kill(this.conductorSandbox.sandbox.sandboxId);
        console.log(`   ✅ Closed conductor sandbox: ${this.conductorSandbox.sandbox.sandboxId}`);
      } catch (error: any) {
        console.error(`   ⚠️  Error closing conductor:`, error.message);
      }
    }

    // Clear conductor state from Redis
    await clearConductorState();

    this.conductorSession = null;
    this.conductorSandbox = null;
    this.workerSessions.clear();
    this.workerSandboxes.clear();

    console.log('✅ Cleanup complete');
  }

  // ============================================================================
  // Status & Info
  // ============================================================================

  /**
   * Get conductor session info.
   */
  getConductorSession(): ConductorSession | null {
    return this.conductorSession;
  }

  /**
   * Get all worker sessions.
   */
  getWorkerSessions(): WorkerSession[] {
    return Array.from(this.workerSessions.values());
  }

  /**
   * Get active workers (initializing or running status).
   */
  getActiveWorkers(): WorkerSession[] {
    return Array.from(this.workerSessions.values()).filter(
      w => w.status === 'initializing' || w.status === 'running'
    );
  }

  /**
   * Check if conductor is initialized.
   */
  isInitialized(): boolean {
    return this.conductorSession !== null && this.conductorSandbox !== null;
  }
}
