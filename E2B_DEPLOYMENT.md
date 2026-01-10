# E2B Deployment Guide

## Why E2B for Claude Agent Studio

E2B provides a full Ubuntu 22.04 environment with:
- **Browser automation** - Playwright/Puppeteer for web tasks
- **Full filesystem** - Mount files, create workspaces
- **Package installation** - npm, pip, apt-get
- **Long-running tasks** - Up to 24 hours per sandbox
- **Persistent during execution** - Files persist during agent runtime

This is perfect for "Claude Code as a Service" - agents need real environments, not headless compute.

## E2B Setup

### 1. Install E2B SDK

```bash
cd /Users/noahbyrnes/claude-agent-studio-backend
npm install @e2b/sdk
```

### 2. Get E2B API Key

```bash
# Sign up at https://e2b.dev
# Get API key from dashboard
# Add to .env:
E2B_API_KEY=your-key-here
```

### 3. Build & Push Container Template

E2B uses custom templates (Docker images) that you can deploy:

```bash
# Install E2B CLI
npm install -g @e2b/cli

# Login
e2b login

# Build template from agent-runtime/
cd agent-runtime
e2b template build

# This will:
# 1. Use the Dockerfile
# 2. Build the image
# 3. Push to E2B registry
# 4. Return a template ID (e.g., "claude-agent-studio-v1")
```

**Note:** Update Dockerfile to use E2B base image:

```dockerfile
FROM e2bdev/code-interpreter:latest
# or FROM ubuntu:22.04 if you want full control

# Then install everything we need
RUN apt-get update && apt-get install -y curl git nodejs npm

# Copy agent-runtime files
COPY . /workspace/agent-runtime

# Install dependencies
RUN cd /workspace/agent-runtime && npm install

# Start HTTP server
CMD ["node", "/workspace/server.js"]
```

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Backend API (Railway)                                       │
│                                                              │
│  SandboxService.deploy(agentId) {                          │
│    const sandbox = await Sandbox.create({                   │
│      template: 'claude-agent-studio-v1',                   │
│      timeoutMs: 1800000, // 30 minutes                      │
│    });                                                       │
│                                                              │
│    // Start HTTP server in sandbox                          │
│    await sandbox.waitForPort(8080);                        │
│                                                              │
│    // Send prompt to agent                                  │
│    const response = await sandbox.fetch('/execute', {      │
│      method: 'POST',                                         │
│      body: JSON.stringify({ prompt, agentId, sessionId })  │
│    });                                                       │
│  }                                                           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  E2B Sandbox (Ubuntu 22.04 VM)                              │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  HTTP Server (port 8080)                             │  │
│  │  - Receives prompt                                    │  │
│  │  - Spawns detached agent process                     │  │
│  │  - Returns immediately                                │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Agent Process (background)                          │  │
│  │                                                        │  │
│  │  npm start "Check my email and summarize"           │  │
│  │    ↓                                                   │  │
│  │  Claude Agent SDK executes:                          │  │
│  │  - Read tool                                          │  │
│  │  - Bash tool (can run browser automation!)          │  │
│  │  - Custom skills from .claude/skills/               │  │
│  │  - Writes output to backend API                      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  Available:                                                  │
│  - Full filesystem (/workspace)                             │
│  - Node.js, npm                                              │
│  - Playwright/Puppeteer (headful!)                          │
│  - Git, curl, wget                                           │
│  - Any apt package                                           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  Backend API (receives output)                               │
│  /api/internal/logs/append                                  │
│    ↓                                                         │
│  PostgreSQL + Redis pub/sub                                 │
│    ↓                                                         │
│  WebSocket to Frontend                                       │
└─────────────────────────────────────────────────────────────┘
```

## E2B SDK Usage Example

```typescript
import { Sandbox } from '@e2b/sdk';

// Create sandbox from our template
const sandbox = await Sandbox.create({
  template: 'claude-agent-studio-v1', // Our custom template
  apiKey: process.env.E2B_API_KEY,
  timeoutMs: 1800000, // 30 minutes
  metadata: {
    agentId: 'agent-123',
    userId: 'user-456'
  }
});

// Wait for HTTP server to be ready
await sandbox.waitForPort(8080);

// Send prompt to agent
const response = await sandbox.fetch('http://localhost:8080/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    agentId: 'agent-123',
    sessionId: 'session-789',
    prompt: 'Check my GitHub notifications and create a summary',
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN
    },
    storage: {
      type: 'postgresql',
      apiUrl: 'https://your-backend.railway.app',
      apiKey: process.env.INTERNAL_API_KEY
    }
  })
});

// Response is immediate (agent runs in background)
const { sessionId, status } = await response.json();
// status: "started"

// Agent continues running, writing output to your backend API
// Frontend polls via WebSocket for real-time updates

// Later, when done or timeout:
await sandbox.close();
```

## Browser Automation in E2B

Agents can use browser automation via skills:

```bash
# In the E2B sandbox, agent can run:
npx playwright install chromium

# Then in a skill:
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('https://github.com/notifications');
// ... automate tasks
```

## File Mounting

```typescript
// Mount files from your backend to E2B sandbox
const sandbox = await Sandbox.create({
  template: 'claude-agent-studio-v1',
  // Files are available at /workspace
});

// Write files to sandbox
await sandbox.writeFile('/workspace/config.json', JSON.stringify({
  apiKeys: { ... }
}));

// Agent can read these files
// npm start "Read the config and authenticate to GitHub"
```

## Cost Estimation

E2B pricing (as of 2025):
- **Sandbox usage**: $0.00015/second (~$0.27/hour)
- **30-minute agent task**: ~$0.135
- **1000 tasks/month**: ~$135

Much more economical than building/managing your own VM infrastructure.

## Lifecycle Management

```typescript
// SandboxService manages sandbox lifecycle:

class SandboxService {
  private sandboxes: Map<string, Sandbox> = new Map();

  async deploy(agentId: string): Promise<Sandbox> {
    // Create sandbox
    const sandbox = await Sandbox.create({
      template: 'claude-agent-studio-v1',
      timeoutMs: 1800000
    });

    // Store reference
    this.sandboxes.set(agentId, sandbox);

    // Setup cleanup on timeout
    setTimeout(() => {
      this.cleanup(agentId);
    }, 30 * 60 * 1000);

    return sandbox;
  }

  async cleanup(agentId: string): Promise<void> {
    const sandbox = this.sandboxes.get(agentId);
    if (sandbox) {
      await sandbox.close();
      this.sandboxes.delete(agentId);
    }
  }
}
```

## Testing E2B Deployment

```bash
# 1. Build template
cd agent-runtime
e2b template build

# 2. Test locally with E2B SDK
cd ..
npm install @e2b/sdk

# 3. Create test script
cat > test-e2b.ts << 'EOF'
import { Sandbox } from '@e2b/sdk';

const sandbox = await Sandbox.create({
  template: 'claude-agent-studio-v1',
  apiKey: process.env.E2B_API_KEY
});

console.log('Sandbox created:', sandbox.id);

// Test HTTP server
await sandbox.waitForPort(8080);
console.log('HTTP server ready');

// Test agent execution
const response = await sandbox.fetch('http://localhost:8080/execute', {
  method: 'POST',
  body: JSON.stringify({
    agentId: 'test',
    sessionId: 'test-123',
    prompt: 'List files in /workspace',
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
  })
});

console.log('Agent started:', await response.json());

// Keep alive for 2 minutes to see output
await new Promise(resolve => setTimeout(resolve, 120000));

await sandbox.close();
EOF

# 4. Run test
tsx test-e2b.ts
```

## Next Steps

1. ✅ Update `agent-runtime/Dockerfile` for E2B
2. ✅ Install @e2b/sdk in backend
3. ✅ Update SandboxService to use E2B
4. ✅ Test template build and deployment
5. ✅ Integrate with existing backend API

Let's proceed with Phase 2: E2B Integration!
