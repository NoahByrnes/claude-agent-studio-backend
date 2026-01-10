# Claude Agent Studio - Architecture Design

## Vision

Deploy the Claude Agent SDK (the same engine that powers Claude Code CLI) in containers, making it accessible via email, SMS, webhooks, and web UI instead of just a local terminal.

Each agent is a **full Claude Code instance** with:
- Custom system prompts
- Flexible context sources (files, APIs, MCP servers, databases)
- Event-driven triggers (email, SMS, webhooks, UI)
- Real-time output streaming to web UI

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  WEB UI (React)                                                  │
│  - Create/configure agents                                       │
│  - Send prompts                                                  │
│  - View real-time logs (WebSocket)                              │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        │ HTTP API
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  BACKEND API (Fastify)                                           │
│  - Agent CRUD                                                    │
│  - Deployment orchestration                                      │
│  - Event routing (email/SMS/webhooks → prompts)                 │
│  - WebSocket streaming                                           │
└───────────────────────┬─────────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
        ▼               ▼               ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ PostgreSQL  │  │   Redis     │  │   Queue     │
│ (Supabase)  │  │  (Upstash)  │  │  (BullMQ)   │
│             │  │             │  │             │
│ - Agents    │  │ - Pub/Sub   │  │ - Events    │
│ - Logs      │  │ - Cache     │  │             │
└─────────────┘  └─────────────┘  └─────────────┘
        │
        │ Deploy Agent
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  CONTAINER RUNTIME (E2B or Cloudflare)                           │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │  HTTP SERVER (port 8080)                               │    │
│  │  - Health endpoint                                      │    │
│  │  - Execute endpoint (receives prompts)                 │    │
│  │  - Spawns detached agent processes                     │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │  CLAUDE AGENT SDK (@anthropic-ai/claude-agent-sdk)    │    │
│  │                                                         │    │
│  │  import { query } from '@anthropic-ai/claude-agent-sdk'│    │
│  │                                                         │    │
│  │  for await (const message of query({ prompt })) {      │    │
│  │    // Stream output                                     │    │
│  │  }                                                      │    │
│  │                                                         │    │
│  │  Available Tools:                                       │    │
│  │  ├─ Bash, Read, Write, Edit, Grep, Glob               │    │
│  │  ├─ MCP tools (if configured)                          │    │
│  │  └─ Skill (custom skills from .claude/skills/)        │    │
│  │                                                         │    │
│  │  Context Sources:                                       │    │
│  │  ├─ Mounted files/directories (/workspace)            │    │
│  │  ├─ Environment variables (API keys, credentials)      │    │
│  │  ├─ MCP server connections                             │    │
│  │  └─ Custom integrations                                │    │
│  └────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                        │
                        │ Writes output to
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  REDIS PUB/SUB + PostgreSQL                                      │
│  - Real-time log streaming                                       │
│  - Output history storage                                        │
└─────────────────────────────────────────────────────────────────┘
```

## Key Architecture Decisions

### 1. Cloudflare Workers Timeout Solution

**Problem:** Cloudflare Workers `waitUntil()` times out after ~30 seconds, but Claude Agent tasks can run for minutes.

**Solution (from bookkeeping-automation):**
- Container runs HTTP server on port 8080
- Worker sends task request → Container responds immediately with taskId
- Container spawns **detached** agent process in background
- Agent writes output to storage (KV/Redis/PostgreSQL) as it executes
- Frontend polls for updates from storage

```javascript
// Worker (index.ts)
const response = await sandbox.fetch('/execute-agent', {
  method: 'POST',
  body: JSON.stringify({ taskId, prompt, env })
});
// Returns immediately with taskId

// Container (server.js)
const proc = spawn('npm', ['start', '--', task], {
  detached: true,  // Continues after response
  stdio: ['ignore', 'pipe', 'pipe']
});
proc.unref();  // Detach from parent

// Write output to storage periodically
proc.stdout.on('data', async (data) => {
  await writeToDatabase(taskId, data);
  await publishToRedis(taskId, data);
});

// Respond immediately
res.json({ taskId, status: 'started' });
```

### 2. Container Structure

Based on `Dockerfile`:

```dockerfile
FROM cloudflare/sandbox:0.4.11
# or e2b/sandbox for E2B runtime

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# Install Claude Agent SDK
COPY agent-runtime/package.json /workspace/agent-runtime/
RUN cd /workspace/agent-runtime && npm install

# Copy agent source and skills
COPY agent-runtime/src /workspace/agent-runtime/src
COPY agent-runtime/.claude /workspace/agent-runtime/.claude

# Start HTTP server
CMD ["node", "/workspace/server.js"]
```

### 3. Agent Runtime Structure

```
/workspace/agent-runtime/
├── package.json
│   └── dependencies:
│       ├── @anthropic-ai/claude-agent-sdk: ^0.1.31
│       └── tsx: ^4.20.6
├── src/
│   └── index.ts          # Main agent entry point
├── .claude/
│   └── skills/           # Custom skills directory
│       ├── skill-name/
│       │   ├── SKILL.md     # Skill metadata
│       │   ├── REFERENCE.md # API docs
│       │   └── EXAMPLES.md  # Code examples
│       └── ...
└── server.js             # HTTP server for receiving prompts
```

**src/index.ts:**
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const task = process.argv.slice(2).join(" ");

for await (const message of query({
  prompt: task,
  options: {
    cwd: process.cwd(),
    allowedTools: ["Skill", "Read", "Write", "Edit", "Bash"],
    settingSources: ["project"],  // Load skills from .claude/
    maxTurns: 50,
  },
})) {
  // Stream output as JSON
  console.log(JSON.stringify(message));
}
```

### 4. Context Configuration (Flexible)

Not just MCP - support multiple context types:

```typescript
interface AgentContext {
  // MCP Servers (when appropriate)
  mcpServers?: {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  }[];

  // Direct file/directory mounts
  fileMounts?: {
    localPath: string;      // Cloud storage path
    containerPath: string;  // /workspace/...
    readOnly: boolean;
  }[];

  // Environment variables (API keys, tokens)
  environmentVariables?: Record<string, string>;

  // Database connections
  databases?: {
    name: string;
    connectionString: string;
  }[];

  // Custom integrations (npm packages)
  npmPackages?: string[];

  // Skills (custom tools as markdown)
  skills?: {
    name: string;
    content: string;  // Markdown content
  }[];
}
```

### 5. Event Routing Pipeline

```
Email arrives → Parse → Create prompt → Queue event
SMS arrives → Parse → Create prompt → Queue event
Webhook → Parse payload → Create prompt → Queue event
Web UI → User types → Create prompt → Send directly
```

**Event structure:**
```typescript
interface AgentEvent {
  agentId: string;
  eventId: string;
  eventType: 'email' | 'sms' | 'webhook' | 'prompt';
  source: string;  // email address, phone, webhook URL, or 'ui'
  payload: {
    subject?: string;
    body?: string;
    attachments?: string[];
    metadata?: Record<string, any>;
  };
  prompt: string;  // Constructed prompt for agent
}
```

### 6. Output Streaming

```
Container stdout → Parse JSON messages → PostgreSQL + Redis pub/sub
                                              ↓
                                        WebSocket to frontend
                                              ↓
                                        Display like terminal
```

## Database Schema Updates

### agents table
```sql
-- Add deployment_url column
ALTER TABLE agents ADD COLUMN deployment_url TEXT;

-- Add context configuration
ALTER TABLE agents ADD COLUMN context_config JSONB DEFAULT '{}'::jsonb;
```

### agent_context table (new)
```sql
CREATE TABLE agent_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  context_type TEXT NOT NULL,  -- 'mcp', 'file_mount', 'env', 'database', 'npm', 'skill'
  config JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_agent_context_agent_id ON agent_context(agent_id);
```

### agent_events table (new)
```sql
CREATE TABLE agent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,  -- 'email', 'sms', 'webhook', 'prompt'
  source TEXT NOT NULL,
  payload JSONB NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'processing', 'completed', 'failed'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_agent_events_agent_id ON agent_events(agent_id);
CREATE INDEX idx_agent_events_status ON agent_events(status);
```

## Implementation Phases

### Phase 1: Container Runtime ✓ PRIORITY
**Goal:** Deploy Claude Agent SDK in E2B/Cloudflare containers

1. Create container structure:
   - Dockerfile based on reference
   - HTTP server (container-server.js)
   - Agent runtime (src/index.ts using query())

2. Implement async execution pattern:
   - Container receives prompt via HTTP
   - Spawns detached agent process
   - Responds immediately with taskId
   - Agent writes to PostgreSQL + Redis as it executes

3. Test deployment:
   - Local Docker test
   - E2B deployment
   - Cloudflare Containers deployment

### Phase 2: Backend Integration
**Goal:** Connect existing backend to container runtime

1. Update SandboxService:
   - Remove custom agent executor
   - Deploy Claude Agent SDK containers
   - Configure context (files, env, MCP, skills)

2. Implement storage integration:
   - Agent output → PostgreSQL audit_logs
   - Real-time streaming → Redis pub/sub
   - Frontend polling → WebSocket updates

3. Update API routes:
   - POST /api/agents/:id/execute → Queue event
   - GET /api/agents/:id/logs/stream → WebSocket
   - POST /api/agents/:id/deploy → Deploy container

### Phase 3: Context Configuration
**Goal:** Support flexible context sources

1. Database schema:
   - agent_context table
   - Context type enum
   - Configuration validation

2. Configuration UI:
   - MCP server setup
   - File mount configuration
   - Environment variables
   - Custom skills upload

3. Container configuration:
   - Mount files from cloud storage
   - Inject environment variables
   - Configure MCP servers
   - Load custom skills

### Phase 4: Event Routing
**Goal:** Email/SMS/Webhook triggers

1. Email gateway:
   - Mailgun/SendGrid webhook
   - Parse incoming emails
   - Create prompts from email content

2. SMS gateway:
   - Twilio webhook
   - Parse SMS messages
   - Create prompts from SMS

3. Webhook endpoint:
   - Generic webhook handler
   - Payload parsing
   - Custom prompt construction

## Migration Path

### Current State
- Custom agentic framework calling Anthropic API directly
- Agent executor service with tool loop
- BullMQ event queue
- Redis pub/sub for logs

### Migration Steps

1. **Keep existing infrastructure:**
   - PostgreSQL database ✓
   - Redis pub/sub ✓
   - BullMQ queue ✓
   - Audit logging ✓

2. **Replace agent execution:**
   - ❌ AgentExecutorService (custom framework)
   - ✓ Claude Agent SDK in containers
   - ❌ Anthropic SDK client.messages.create()
   - ✓ query() from @anthropic-ai/claude-agent-sdk

3. **Adapt SandboxService:**
   - Deploy containers with Claude Agent SDK
   - Configure context from agent_context table
   - Send prompts via HTTP to container
   - Receive output via PostgreSQL + Redis

## Next Steps

1. ✓ Analyze bookkeeping-automation reference
2. → Create agent-runtime project structure
3. → Build Dockerfile for Claude Agent SDK
4. → Implement container HTTP server
5. → Test local deployment
6. → Update SandboxService
7. → Integrate with existing backend

---

**Reference Project:** `/Users/noahbyrnes/Desktop/bookkeeping-automation/cloudflare-sandbox-test`

**Key Files:**
- `Dockerfile` - Container definition
- `container-server.js` - HTTP server for receiving prompts
- `bookkeeping-agent/src/index.ts` - Agent SDK usage
- `bookkeeping-agent/.claude/skills/` - Skills framework
