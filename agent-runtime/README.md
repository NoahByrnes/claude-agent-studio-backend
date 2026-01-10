# Claude Agent Studio - Agent Runtime

This is the agent runtime that runs inside containers (E2B or Cloudflare Sandboxes).

## Architecture

```
┌─────────────────────────────────────────┐
│  Container                               │
│                                          │
│  ┌────────────────────────────────────┐ │
│  │  HTTP Server (server.js)           │ │
│  │  - Port 8080                        │ │
│  │  - Receives execution requests      │ │
│  │  - Spawns detached agent processes  │ │
│  └────────────────────────────────────┘ │
│                                          │
│  ┌────────────────────────────────────┐ │
│  │  Agent Runtime (src/index.ts)      │ │
│  │                                     │ │
│  │  import { query } from              │ │
│  │    '@anthropic-ai/claude-agent-sdk' │ │
│  │                                     │ │
│  │  - Receives prompt via CLI args     │ │
│  │  - Executes agent autonomously      │ │
│  │  - Streams output as JSON           │ │
│  │  - Uses tools (Bash, Read, Write)   │ │
│  │  - Loads skills from .claude/       │ │
│  └────────────────────────────────────┘ │
│                                          │
│  ┌────────────────────────────────────┐ │
│  │  Skills (.claude/skills/)          │ │
│  │  - Custom tools as markdown        │ │
│  │  - SKILL.md - Metadata             │ │
│  │  - REFERENCE.md - API docs         │ │
│  │  - EXAMPLES.md - Code samples      │ │
│  └────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

## Local Testing

```bash
# Install dependencies
cd agent-runtime
npm install

# Test agent locally
npm start "Write a haiku about containers"

# Test HTTP server
node server.js

# In another terminal:
curl http://localhost:8080/health

curl -X POST http://localhost:8080/execute \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "test-agent",
    "sessionId": "test-session",
    "prompt": "Write a haiku about containers",
    "env": {
      "ANTHROPIC_API_KEY": "your-key-here"
    },
    "storage": {
      "type": "postgresql",
      "apiUrl": "http://localhost:3000",
      "apiKey": "test-key"
    }
  }'
```

## Docker Build

```bash
# Build image
docker build -t claude-agent-studio-runtime .

# Test locally
docker run -p 8080:8080 \
  -e ANTHROPIC_API_KEY=your-key \
  claude-agent-studio-runtime

# Test health
curl http://localhost:8080/health
```

## Environment Variables

Required:
- `ANTHROPIC_API_KEY` - Anthropic API key for Claude

Optional:
- `DEBUG` - Set to 'true' for debug logs
- `PORT` - HTTP server port (default: 8080)

## Skills

Skills are custom tools defined in `.claude/skills/`. Each skill is a directory containing markdown files:

**SKILL.md** - Quick start and metadata:
```markdown
---
name: skill-name
description: What this skill does
---

# Skill Name

Quick start guide...
```

**REFERENCE.md** - Detailed API documentation
**EXAMPLES.md** - Code examples

Skills are automatically loaded by the Claude Agent SDK when using `settingSources: ["project"]`.

## Output Format

The agent streams output to stdout as newline-delimited JSON:

```json
{"type":"assistant","message":{"id":"msg_123","content":[{"type":"text","text":"Let me help with that..."}]}}
{"type":"assistant","message":{"id":"msg_124","content":[{"type":"tool_use","name":"Bash","input":{"command":"echo hello"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_123","content":"hello"}]}}
```

The container server captures this output and writes it to storage (PostgreSQL or KV) for real-time streaming to the frontend.

## Deployment

### E2B
```typescript
import { Sandbox } from '@e2b/sdk';

const sandbox = await Sandbox.create({
  template: 'claude-agent-studio-runtime',
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
  }
});

const response = await sandbox.fetch('/execute', {
  method: 'POST',
  body: JSON.stringify({
    agentId: 'agent-123',
    sessionId: 'session-456',
    prompt: 'Check my GitHub notifications',
    storage: { type: 'postgresql', apiUrl, apiKey }
  })
});

// Response is immediate, agent runs in background
const { sessionId, status } = await response.json();
// Poll storage for output...
```

### Cloudflare Containers
```typescript
const sandbox = env.Sandbox.get(id);

const response = await sandbox.fetch('/execute', {
  method: 'POST',
  body: JSON.stringify({
    agentId: 'agent-123',
    sessionId: 'session-456',
    prompt: 'Check my GitHub notifications',
    storage: { type: 'cloudflare-kv', accountId, namespaceId, apiToken }
  })
});

// Response is immediate, agent runs in background
```
