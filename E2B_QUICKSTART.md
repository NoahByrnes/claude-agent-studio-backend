# E2B Quick Start Guide

## What We Built

✅ **E2BSandboxService** - Full E2B integration for deploying Claude Agent SDK in containers
✅ **Sandbox API Routes** - Deploy, execute, stop, manage sandboxes
✅ **Ubuntu 22.04 + Browser** - Full environment with Playwright support
✅ **Async Execution** - Containers run agents in background, write to backend API

## Setup (3 Steps)

### 1. Get E2B API Key

```bash
# Sign up at https://e2b.dev
# Copy API key from dashboard
# Add to Railway environment variables:
E2B_API_KEY=your-key-here
```

### 2. Build & Push E2B Template

```bash
# Install E2B CLI globally
npm install -g @e2b/cli

# Login to E2B
e2b login

# Build template from agent-runtime/
cd agent-runtime
e2b template build

# This creates a template with ID (e.g., "claude-agent-studio-v1")
# Copy the template ID
```

### 3. Configure Backend

```bash
# Add to Railway environment variables:
E2B_TEMPLATE_ID=your-template-id-here
BACKEND_API_URL=https://your-backend.railway.app
INTERNAL_API_KEY=generate-random-key-here
```

## API Usage

### Deploy Agent

```bash
POST /api/agents/:id/deploy

# Creates E2B sandbox with Claude Agent SDK
# Returns deployment info
```

### Execute Prompt

```bash
POST /api/agents/:id/execute
{
  "prompt": "Check my GitHub notifications and summarize",
  "env": {
    "GITHUB_TOKEN": "ghp_..."
  }
}

# Starts agent in background
# Returns sessionId
# Agent writes output to backend API
# Frontend gets real-time updates via WebSocket
```

### Upload Files

```bash
POST /api/agents/:id/sandbox/files
{
  "files": [
    { "path": "/workspace/config.json", "content": "{...}" }
  ]
}
```

### Install Packages

```bash
POST /api/agents/:id/sandbox/packages
{
  "packages": ["playwright", "axios"]
}
```

### Execute Command

```bash
POST /api/agents/:id/sandbox/exec
{
  "command": "ls -la /workspace",
  "timeout": 10000
}
```

### Stop Sandbox

```bash
POST /api/agents/:id/stop

# Closes sandbox and cleans up
```

## Architecture Flow

```
User clicks "Deploy" in UI
  ↓
POST /api/agents/:id/deploy
  ↓
E2BSandboxService.deploy()
  ├─ Creates E2B sandbox with template
  ├─ Waits for HTTP server (port 8080)
  ├─ Verifies health check
  └─ Returns deployment info
  ↓
User sends prompt in UI
  ↓
POST /api/agents/:id/execute
  ↓
E2BSandboxService.execute()
  ├─ Sends request to container HTTP server
  ├─ Container spawns detached agent process
  ├─ Responds immediately with sessionId
  └─ Agent runs in background
  ↓
Agent execution (in E2B container):
  ├─ npm start "user prompt"
  ├─ Claude Agent SDK executes
  ├─ Uses tools (Bash, Read, Write, Skills)
  ├─ Writes output to backend /api/internal/logs/append
  └─ Backend stores in PostgreSQL + Redis pub/sub
  ↓
Frontend WebSocket:
  ├─ Subscribes to agent logs
  ├─ Receives real-time updates
  └─ Displays like terminal output
```

## Browser Automation Example

Agents can use browsers in E2B!

**Create a skill for browser automation:**

`.claude/skills/web-scraping/SKILL.md`:
```markdown
---
name: web-scraping
description: Extract data from websites using Playwright
---

# Web Scraping Skill

Automate web interactions and extract data.

## Usage

1. Install Playwright (if not already):
   ```bash
   npx playwright install chromium
   ```

2. Use Playwright in Bash:
   ```javascript
   const { chromium } = require('playwright');
   const browser = await chromium.launch({ headless: true });
   const page = await browser.newPage();
   await page.goto('https://example.com');
   const title = await page.title();
   await browser.close();
   ```
```

Then agent can use it:
```bash
User: "Get the title of example.com"

Agent: I'll use the web-scraping skill to fetch that.
  [Uses Bash tool to run Playwright script]
  [Returns: "Example Domain"]
```

## Cost Management

E2B charges:
- **$0.00015/second** (~$0.27/hour)
- **30-minute task**: ~$0.135
- **Auto-cleanup**: Sandboxes timeout after 30 minutes

E2BSandboxService automatically:
- Closes sandboxes on timeout
- Cleans up on agent stop
- Reuses sandboxes for same agent

## Next Steps

1. **Deploy first agent** - Test E2B integration
2. **Create custom skills** - Add browser automation, API integrations
3. **Monitor costs** - E2B dashboard shows usage
4. **Scale** - E2B handles concurrency automatically

## Troubleshooting

**"No template found"**
- Run `e2b template build` in agent-runtime/
- Copy template ID to `E2B_TEMPLATE_ID` env var

**"Timeout waiting for port 8080"**
- Check Dockerfile CMD is starting server
- Verify server.js is in container

**"Agent not writing output"**
- Check `BACKEND_API_URL` env var is correct
- Check `INTERNAL_API_KEY` matches between backend and .env
- Check container can reach backend API

**"Browser automation not working"**
- Add Playwright deps to Dockerfile (already included)
- Run `npx playwright install chromium` in sandbox
- Use headless: true mode
