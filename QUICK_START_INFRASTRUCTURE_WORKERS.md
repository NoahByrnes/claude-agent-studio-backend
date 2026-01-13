# Quick Start: Enable Infrastructure Workers

**Time needed:** ~5-10 minutes (mostly automated)

## What This Does

Enables Stu to spawn infrastructure workers that can modify the worker template repository, allowing autonomous system improvements.

## Prerequisites

✅ You have: `gh` (GitHub CLI), `e2b` CLI installed
✅ You have: GitHub account with write access
✅ You have: E2B account (from main setup)

## Step 1: Run Setup Script (Automated)

```bash
cd ~/claude-agent-studio-backend
./scripts/setup-worker-template-repo.sh
```

**What it does:**
1. ✅ Checks authentication (GitHub & E2B)
2. ✅ Creates `noahbyrnes/claude-agent-studio-worker-template` repo
3. ✅ Copies Dockerfiles and configuration
4. ✅ Builds both E2B templates (worker & infrastructure)
5. ✅ Gives you template IDs to use

**Expected output:**
```
✅ Setup Complete!
==================

Repository: https://github.com/noahbyrnes/claude-agent-studio-worker-template

Template IDs:
  Standard Worker:       abc123xyz...
  Infrastructure Worker: def456uvw...
```

## Step 2: Create GitHub Token

1. Go to: https://github.com/settings/tokens
2. Click **"Generate new token (classic)"**
3. Name: `Claude Agent Studio Infrastructure Workers`
4. Select scopes:
   - [x] **repo** (Full control of private repositories)
5. Click **"Generate token"**
6. **Copy the token** (starts with `ghp_`) - you won't see it again!

## Step 3: Configure Railway Environment Variables

Go to your Railway project settings and add/update:

```bash
# Template IDs (from Step 1 output)
E2B_TEMPLATE_ID=abc123xyz...              # Standard worker
E2B_INFRASTRUCTURE_TEMPLATE_ID=def456uvw... # Infrastructure worker

# Repository (already correct if you used default)
WORKER_TEMPLATE_REPO=noahbyrnes/claude-agent-studio-worker-template
WORKER_TEMPLATE_BRANCH=main

# GitHub Token (from Step 2)
GITHUB_TOKEN=ghp_your_token_here
```

**How to set in Railway:**
1. Go to https://railway.app
2. Select your project
3. Click on backend service
4. Go to "Variables" tab
5. Click "New Variable" for each
6. Or click "Raw Editor" and paste all at once

## Step 4: Deploy (Automatic)

Railway will automatically redeploy when you commit. Let's commit the new files:

```bash
cd ~/claude-agent-studio-backend
git add .
git commit -m "Add infrastructure worker template and setup scripts"
git push origin main
```

Railway will deploy automatically (watch at https://railway.app).

## Step 5: Test It! 🎉

Once deployed, send Stu a message via SMS or dashboard:

### Test 1: Check Configuration
```
Are infrastructure workers enabled?
```

Expected: Stu confirms infrastructure workers are enabled

### Test 2: Spawn Infrastructure Worker
```
Spawn an infrastructure worker to analyze the current worker Dockerfile and tell me what's installed
```

Expected:
1. Infrastructure worker spawns
2. Clones template repo
3. Analyzes Dockerfile
4. Reports installed packages

### Test 3: Full Capability Addition (Advanced)
```
Install jq (JSON processor) in the worker template. Create a PR with the changes.
```

Expected:
1. Infrastructure worker spawns
2. Modifies Dockerfile to add jq
3. Creates PR: https://github.com/noahbyrnes/claude-agent-studio-worker-template/pull/1
4. Stu asks you to review
5. You: "Show me the PR diff"
6. Stu shows changes
7. You: "Approved. Merge and rebuild."
8. Worker merges PR and rebuilds template
9. Stu reports new template ID

## Troubleshooting

### "gh not found"
```bash
brew install gh
gh auth login
```

### "e2b not found"
```bash
npm install -g @e2b/cli
e2b auth login
```

### "Not authenticated with GitHub"
```bash
gh auth login
```

### "Not authenticated with E2B"
```bash
e2b auth login
```

### "Permission denied" when creating repo
Check you're logged into the correct GitHub account:
```bash
gh auth status
# If wrong account, logout and login again
gh auth logout
gh auth login
```

### Template build fails
Common causes:
- Docker not running: `open /Applications/Docker.app`
- Network issues: Check internet connection
- E2B quota: Check https://e2b.dev/dashboard

### Infrastructure worker can't clone repo
- Verify GITHUB_TOKEN is set in Railway
- Check token hasn't expired
- Verify token has `repo` scope

## What Happens Next?

### Autonomous Improvement Cycle:

1. **Worker suggests improvement**
   - "Playwright not installed, using computer use (expensive)"

2. **Stu evaluates**
   - Is it valuable? Is it safe? Is it necessary?

3. **Infrastructure worker executes**
   - Clones repo, edits Dockerfile, creates PR

4. **Stu reviews**
   - Checks for secrets, malicious code, scope creep

5. **Stu approves (or rejects)**
   - If approved: merge, rebuild, deploy

6. **System improves**
   - New capability available to all future workers
   - Cost per task decreases
   - System gets smarter

### Example Improvements:

- ✅ Install Playwright → 25x cost reduction for browser tasks
- ✅ Add image processing tools → enable new task types
- ✅ Install ML libraries → enable data analysis tasks
- ✅ Add API clients → faster integration with services

## Cost Impact

**Initial setup:** Free (E2B has generous free tier)

**Per capability addition:**
- Infrastructure worker spawn: ~$0.02 (one-time)
- Template rebuild: Free

**Long-term savings:**
- Example: Playwright vs computer use
  - Before: $0.25/task
  - After: $0.01/task
  - **Savings: $0.24/task (25x reduction)**
  - Break-even after 1 task!

## Security Notes

✅ **All changes vetted by Stu** - No auto-merges
✅ **Sandboxed execution** - Workers can't access production data
✅ **Full audit trail** - All changes via reviewable PRs
✅ **Minimal token permissions** - GitHub token has only `repo` scope
✅ **Version control** - Easy rollback to previous templates

## Summary

**Total time:** ~10 minutes
**What you enabled:** Autonomous system improvement
**Benefits:** Lower costs, new capabilities, no manual intervention
**Risk:** Low (all changes vetted, sandboxed, auditable)
**ROI:** High (continuous optimization)

---

**Status:** Ready to enable! Just run the setup script. 🚀

**Questions?** See `INFRASTRUCTURE_WORKERS_IMPLEMENTATION.md` for detailed docs.
