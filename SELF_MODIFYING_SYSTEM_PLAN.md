# Self-Modifying Worker System - Implementation Plan

## Overview

Enable Stu to spawn **infrastructure workers** that can modify the worker VM container code itself. This allows the system to self-improve by installing new capabilities (Playwright, computer use tools, etc.) based on needs discovered during operation.

## Architecture Changes

### 1. Repository Separation

**Create new repo: `claude-agent-studio-worker-template`**

```
claude-agent-studio-worker-template/
├── Dockerfile                 # Worker E2B template
├── package.json              # Node dependencies
├── tsconfig.json             # TypeScript config
├── .e2b.toml                 # E2B template config
├── README.md                 # Setup and maintenance guide
└── CHANGELOG.md              # Track template version changes
```

**Benefits:**
- Changes to worker template don't redeploy Stu (conductor backend)
- Workers can modify template without affecting live conductor
- Clear separation of concerns
- Version control for template evolution

### 2. New E2B Templates

**Template 1: Standard Worker** (already exists)
- Claude Code CLI
- Node.js 20
- Basic utilities (curl, wget, git, jq)
- Playwright dependencies (if installed by infrastructure worker)

**Template 2: Infrastructure Worker** (new)
- Everything in Template 1, PLUS:
- GitHub CLI (gh)
- Docker CLI (for Dockerfile manipulation)
- E2B CLI (for template rebuilds)
- Git with SSH keys
- Full GitHub API access

### 3. New Stu Commands

Add to Stu's available commands:

```
SPAWN_INFRASTRUCTURE_WORKER: <task>
```

**Differences from SPAWN_WORKER:**
- Uses different E2B template (infrastructure template)
- Has access to GitHub/Git APIs
- Can modify worker template repository
- Can trigger template rebuilds
- Stu automatically vets all changes before approval

## Implementation Steps

### Phase 1: Repository Setup

1. **Create new GitHub repository**
   ```bash
   gh repo create claude-agent-studio-worker-template --public --description "E2B template for Claude Agent Studio workers"
   ```

2. **Move worker template files**
   - Copy `agent-runtime/Dockerfile` → new repo `Dockerfile`
   - Create `.e2b.toml` with template configuration
   - Create `package.json` with dependencies
   - Create `README.md` with template documentation

3. **Set up E2B template**
   ```bash
   cd claude-agent-studio-worker-template
   e2b template build
   # Get new template ID: e2b_worker_xxx
   ```

4. **Update main backend**
   - Update `E2B_TEMPLATE_ID` environment variable to new template
   - Remove `agent-runtime/` directory from main backend repo
   - Update documentation to reference new worker template repo

### Phase 2: Infrastructure Worker Template

1. **Create infrastructure Dockerfile**

   ```dockerfile
   # Based on standard worker template but with infrastructure tools
   FROM ubuntu:22.04

   ENV DEBIAN_FRONTEND=noninteractive

   # Install standard worker dependencies
   RUN apt-get update && apt-get install -y \
       curl wget unzip jq git ca-certificates gnupg \
       && rm -rf /var/lib/apt/lists/*

   # Install Node.js 20
   RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
       && apt-get install -y nodejs \
       && rm -rf /var/lib/apt/lists/*

   # Install Claude Code CLI
   RUN npm install -g @anthropic-ai/claude-code

   # INFRASTRUCTURE ADDITIONS:

   # Install GitHub CLI
   RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
       gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
       echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
       tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
       apt-get update && apt-get install -y gh && \
       rm -rf /var/lib/apt/lists/*

   # Install E2B CLI
   RUN npm install -g @e2b/cli

   # Install Docker CLI (for Dockerfile analysis/modification)
   RUN apt-get update && apt-get install -y docker.io && \
       rm -rf /var/lib/apt/lists/*

   # Create workspace
   RUN mkdir -p /workspace
   WORKDIR /workspace

   # Git configuration for commits
   RUN git config --global user.name "Claude Agent Studio Bot" && \
       git config --global user.email "bot@claude-agent-studio.dev"

   CMD ["bash"]
   ```

2. **Build infrastructure template**
   ```bash
   e2b template build -f infrastructure.Dockerfile
   # Get template ID: e2b_infra_xxx
   ```

3. **Store in environment**
   ```bash
   E2B_INFRASTRUCTURE_TEMPLATE_ID=e2b_infra_xxx
   ```

### Phase 3: Backend Changes

1. **Add infrastructure template configuration**

   **File: `src/config/templates.ts`** (new file)
   ```typescript
   export const E2B_TEMPLATES = {
     WORKER: process.env.E2B_TEMPLATE_ID || '',
     INFRASTRUCTURE: process.env.E2B_INFRASTRUCTURE_TEMPLATE_ID || '',
   };

   export const WORKER_TEMPLATE_REPO = 'noahbyrnes/claude-agent-studio-worker-template';
   export const WORKER_TEMPLATE_BRANCH = 'main';
   ```

2. **Add infrastructure worker spawning**

   **File: `src/conductor-cli/conductor-e2b.service.ts`**

   Add to `processOutput()` method:
   ```typescript
   // Existing SPAWN_WORKER handling...

   // NEW: Handle SPAWN_INFRASTRUCTURE_WORKER command
   if (line.startsWith('SPAWN_INFRASTRUCTURE_WORKER:')) {
     const task = line.replace('SPAWN_INFRASTRUCTURE_WORKER:', '').trim();

     // Spawn using infrastructure template
     const workerId = await this.spawnWorker(
       userId,
       task,
       E2B_TEMPLATES.INFRASTRUCTURE,
       {
         GITHUB_TOKEN: process.env.GITHUB_TOKEN,
         WORKER_TEMPLATE_REPO,
         E2B_API_KEY: process.env.E2B_API_KEY,
       }
     );

     // Notify Stu
     await this.sendToConductor(
       conductorId,
       `[SYSTEM] Infrastructure worker spawned: ${workerId}\nTask: ${task}\nThis worker can modify the worker template repository and trigger rebuilds.`
     );

     continue;
   }
   ```

3. **Update worker spawning to support templates**

   ```typescript
   private async spawnWorker(
     userId: string,
     task: string,
     templateId?: string, // NEW: Optional template override
     envVars?: Record<string, string> // NEW: Optional environment variables
   ): Promise<string> {
     // Use provided template or default worker template
     const template = templateId || E2B_TEMPLATES.WORKER;

     // Create sandbox with specified template
     const sandbox = await Sandbox.create(template, {
       apiKey: this.e2bApiKey,
       timeoutMs: 1800000,
     });

     // Merge environment variables
     const env = {
       ...this.getDefaultWorkerEnv(),
       ...envVars,
     };

     // ... rest of worker spawn logic
   }
   ```

### Phase 4: Stu's System Prompt Updates

**File: `src/conductor-cli/conductor-e2b.service.ts`**

Add new section to Stu's system prompt:

```typescript
## Infrastructure Workers & Self-Improvement

You can spawn SPECIAL INFRASTRUCTURE WORKERS that can modify the worker VM container code itself.

**When to spawn infrastructure workers:**
1. A regular worker suggests: "We need package X for task Y"
2. A worker reports: "I could be faster with tool Z installed"
3. You identify a capability gap: "Workers can't do X because Y is missing"

**Infrastructure worker capabilities:**
- Clone and modify the worker template repository
- Edit Dockerfile to add dependencies
- Install new system packages (apt-get)
- Install new npm packages globally
- Trigger E2B template rebuilds
- Create pull requests with changes
- Test changes before deployment

**Vetting Flow (CRITICAL - Always Follow):**

Step 1: Regular worker suggests improvement
[WORKER:abc123] "Suggestion: Install Playwright for browser tasks. Currently using computer use which costs 50x more."

Step 2: You evaluate the suggestion
- Is it valuable? (yes - saves cost)
- Is it safe? (yes - Playwright is standard)
- Is it necessary? (yes - common use case)

Step 3: Spawn infrastructure worker with SPECIFIC task
SPAWN_INFRASTRUCTURE_WORKER: Install Playwright in worker template. Add 'npx playwright install chromium' to Dockerfile. Create PR with changes for review.

Step 4: Infrastructure worker reports back
[WORKER:inf789] "Changes ready. Created PR #12 in worker-template repo:
- Added Playwright to Dockerfile
- Installed chromium browser
- Updated README with Playwright usage
PR: https://github.com/noahbyrnes/claude-agent-studio-worker-template/pull/12"

Step 5: You review the changes
- Read the PR diff the infrastructure worker created
- Check for security issues
- Verify it matches your request
- Ensure it won't break existing workers

Step 6: Approve or reject
Option A - APPROVE:
"TELL_WORKER: inf789 | Approved. Merge the PR and rebuild the template."

Option B - REJECT:
"TELL_WORKER: inf789 | Changes needed: [specific feedback]. Update the PR."

Step 7: Infrastructure worker completes
[WORKER:inf789] "PR merged. Triggering template rebuild... Template rebuilt: e2b_worker_v2_xxx. Update E2B_TEMPLATE_ID to use new version."

Step 8: You update your memory
Read /root/stu-memory.json, add to capabilities:
{
  "worker_capabilities": {
    "playwright": {
      "added": "2024-01-12",
      "template_version": "e2b_worker_v2_xxx",
      "reason": "Cost optimization for browser tasks"
    }
  }
}
Write /root/stu-memory.json

**Commands:**
SPAWN_INFRASTRUCTURE_WORKER: <task> - Spawn worker that can modify worker template
TELL_WORKER: <worker-id> | <message> - Send message to specific worker (infrastructure or regular)

**Safety Rules:**
1. NEVER auto-approve infrastructure worker changes
2. ALWAYS review PR diffs before approval
3. ONLY allow changes that are:
   - Necessary for functionality
   - Security-vetted
   - Won't break existing capabilities
4. Track all template changes in your memory
5. Keep template version history

**Example - Full Flow:**

User: [SMS] "Research skiing conditions near Whistler"
You: SPAWN_WORKER: Research current skiing conditions at Whistler Blackcomb
[WORKER:abc123] "Suggestion: Install curl/wget if not available for API calls"
You: "Workers already have curl/wget. Proceed with research."
[WORKER:abc123] "Whistler has 245cm base, 20cm fresh snow, all lifts open."
You: "Great work!"
You: KILL_WORKER: abc123
You: SEND_SMS: +16041234567 | Whistler has 245cm base, 20cm fresh snow, all lifts open.

Later...

User: [SMS] "Book a ferry reservation"
You: SPAWN_WORKER: Book BC Ferries reservation. NOTE: bcferries.ca has no API - use Playwright.
[WORKER:def456] "FYI: Playwright not installed. Using computer use API (more expensive). Suggest: Install Playwright in template."
You: "Good suggestion. Computer use costs $0.25/task, Playwright would be <$0.01."
You: SPAWN_INFRASTRUCTURE_WORKER: Install Playwright in worker template. Add Chromium browser. Optimize for headless browser automation. Create PR for review.
[WORKER:inf789] "Analyzing current template... Creating changes... PR created: https://github.com/.../pull/15"
You: [Review PR diff]
You: "TELL_WORKER: inf789 | Looks good. Also add Firefox browser for compatibility. Then merge and rebuild."
[WORKER:inf789] "Added Firefox. PR updated and merged. Rebuilding template... Done! New template: e2b_worker_v2_abc"
You: [Update memory with new capability]
You: "Perfect! Future browser tasks will use Playwright."
```

### Phase 5: Infrastructure Worker System Prompt

**File: `src/conductor-cli/conductor-e2b.service.ts`**

Create specialized prompt for infrastructure workers:

```typescript
private getInfrastructureWorkerSystemPrompt(task: string): string {
  return `You are an INFRASTRUCTURE WORKER. You modify the worker template repository to add capabilities.

## Your Task
${task}

## Your Capabilities
You have access to:
- GitHub CLI (gh) - Create PRs, manage issues
- Git - Clone repos, commit changes
- E2B CLI - Rebuild templates
- Docker CLI - Analyze Dockerfiles
- Full filesystem access

## Environment Variables Available
- GITHUB_TOKEN - GitHub API authentication
- WORKER_TEMPLATE_REPO - Repository to modify (e.g., "noahbyrnes/claude-agent-studio-worker-template")
- E2B_API_KEY - E2B API for template operations

## Workflow

1. **Clone the worker template repo**
   gh repo clone ${WORKER_TEMPLATE_REPO}
   cd claude-agent-studio-worker-template

2. **Make changes** (based on your task)
   - Edit Dockerfile
   - Update package.json
   - Add installation scripts
   - Update README

3. **Create branch and commit**
   git checkout -b feature/add-capability-$(date +%s)
   git add .
   git commit -m "Add [capability]: [description]"

4. **Push and create PR**
   git push origin HEAD
   gh pr create --title "[Capability]" --body "## Changes\n- [list changes]\n\n## Reason\n[why needed]\n\n## Testing\n[how to test]"

5. **Report PR URL to Stu**
   "PR created: [URL]. Changes: [summary]. Ready for review."

6. **If approved, merge and rebuild**
   gh pr merge [number] --squash
   e2b template build
   # Report new template ID

## Example Task

Task: "Install Playwright for browser automation"

You do:
1. Clone repo
2. Edit Dockerfile, add:
   RUN npx playwright install-deps chromium
   RUN npx playwright install chromium
3. Update README with Playwright usage
4. Create PR with changes
5. Report to Stu: "PR #15 created. Added Playwright with Chromium. Cost savings: ~$0.25 → $0.01 per browser task."
6. Wait for Stu's approval
7. If approved: merge, rebuild template, report new ID

## Safety Guidelines

1. NEVER merge without Stu's explicit approval
2. ALWAYS create PR for review (never push to main directly)
3. Keep changes focused and minimal
4. Document all changes in PR description
5. Include testing instructions
6. Provide rollback plan

## Communication

Report progress to Stu:
- "Analyzing current template..."
- "Creating PR with changes..."
- "PR ready for review: [URL]"
- "Waiting for approval..."
- "Approved - merging and rebuilding..."
- "Complete! New template: [ID]"

CRITICAL: Never merge or deploy without explicit approval from Stu.
`;
}
```

### Phase 6: Environment Variables

Add to `.env.example` and Railway configuration:

```bash
# Worker Template Repository (for self-modification)
WORKER_TEMPLATE_REPO=noahbyrnes/claude-agent-studio-worker-template
WORKER_TEMPLATE_BRANCH=main

# GitHub Access (for infrastructure workers)
GITHUB_TOKEN=ghp_xxxxx  # Personal access token with repo access

# E2B Templates
E2B_TEMPLATE_ID=e2b_worker_xxx          # Standard worker template
E2B_INFRASTRUCTURE_TEMPLATE_ID=e2b_infra_xxx  # Infrastructure worker template
```

### Phase 7: Testing

**Test 1: Infrastructure Worker Can Clone Repo**
```
Stu: SPAWN_INFRASTRUCTURE_WORKER: Clone the worker template repo and list files
Expected: Worker clones repo successfully and reports file list
```

**Test 2: Infrastructure Worker Can Create PR**
```
Stu: SPAWN_INFRASTRUCTURE_WORKER: Add a comment to Dockerfile explaining the Node.js installation. Create PR.
Expected: PR created with comment change
```

**Test 3: Full Capability Addition Flow**
```
1. Stu: SPAWN_INFRASTRUCTURE_WORKER: Install jq package for JSON parsing. Create PR.
2. Worker: "PR #20 created: [URL]"
3. Stu reviews PR
4. Stu: "TELL_WORKER: inf123 | Approved. Merge and rebuild."
5. Worker: "Merged. Rebuilding... New template: e2b_worker_v3_xxx"
6. Stu updates memory with new capability
```

**Test 4: Rejection and Iteration**
```
1. Worker creates PR with security issue
2. Stu reviews and finds issue
3. Stu: "TELL_WORKER: inf456 | Rejected. Remove the exposed API key. Use environment variable instead."
4. Worker updates PR
5. Stu re-reviews
6. Stu approves after fix
```

## Cost Implications

### Before Self-Modification:
- Computer use for browser tasks: $0.25/task
- Fixed capabilities in template
- Manual updates require deployment

### After Self-Modification:
- Initial infrastructure worker spawn: ~$0.02
- Template rebuild: free (E2B)
- Future browser tasks with Playwright: $0.01/task
- **Net savings: $0.24/task after first template update**
- System continuously optimizes itself

## Security Considerations

1. **GitHub Token Scope**
   - Limit to specific repository
   - Use fine-grained PAT (Personal Access Token)
   - Only `repo` scope needed

2. **PR Review Requirement**
   - Stu MUST review all PRs
   - Never auto-merge
   - Check for:
     - Exposed secrets
     - Malicious commands
     - Breaking changes

3. **Template Versioning**
   - Keep old template IDs available
   - Tag template versions in git
   - Allow rollback if new version breaks

4. **Audit Trail**
   - All changes via PRs (reviewable)
   - Stu tracks in memory (who, what, when, why)
   - Git history provides full audit

## Success Metrics

1. ✅ Infrastructure workers can create PRs
2. ✅ Stu successfully reviews and approves/rejects
3. ✅ Template rebuilds work automatically
4. ✅ New capabilities appear in future workers
5. ✅ Cost per task decreases over time
6. ✅ System adds capabilities without human intervention

## Future Enhancements

1. **Automatic Testing**: Infrastructure workers run tests before creating PR
2. **Capability Discovery**: Workers analyze tasks to find optimization opportunities
3. **Multi-Template Support**: Specialized templates for different task types
4. **Version Management**: Automatic rollback if new template fails
5. **Cost Tracking**: Dashboard showing cost savings from self-improvements

## Rollout Plan

1. **Week 1**: Set up worker template repo, build initial templates
2. **Week 2**: Implement infrastructure worker spawning in backend
3. **Week 3**: Update Stu's prompts, test basic flows
4. **Week 4**: First real capability addition (Playwright)
5. **Week 5**: Monitor, iterate, document learnings
6. **Week 6+**: System actively self-improves based on usage

## Next Steps

1. Create `claude-agent-studio-worker-template` repository
2. Build infrastructure worker Dockerfile and template
3. Implement backend changes for SPAWN_INFRASTRUCTURE_WORKER
4. Update Stu's system prompt
5. Test with simple capability addition
6. Document and deploy

---

**Status**: Ready for implementation
**Owner**: Backend team
**Priority**: High (enables autonomous system improvement)
**Estimated Time**: 2-3 weeks full implementation
