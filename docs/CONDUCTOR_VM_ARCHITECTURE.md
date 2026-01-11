# Conductor VM Architecture (Revised)

## Overview

The conductor is **an agent running in its own E2B VM**, not a separate orchestration service. It receives all incoming messages (email, SMS, web UI) directly into its CLI, makes natural decisions about what to action, and spawns worker VMs when needed.

This is fundamentally simpler than a service-based architecture because:
- The conductor uses Claude's natural reasoning, not separate triage logic
- Communication is CLI-to-CLI, not HTTP APIs
- State lives in the agent's conversation, not a database

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        INFRASTRUCTURE LAYER                              │
│                      (Our backend - minimal)                             │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                      MESSAGE ROUTER                                 │ │
│  │                                                                     │ │
│  │  Webhook (email) ─┐                                                 │ │
│  │  Webhook (SMS) ───┼──► Format message ──► Inject into Conductor CLI│ │
│  │  Web UI prompt ───┘                                                 │ │
│  │                                                                     │ │
│  │  Worker stdout ──────────────────────► Inject into Conductor CLI   │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                       VM MANAGER                                    │ │
│  │                                                                     │ │
│  │  • Spin up conductor VM on startup (persistent)                    │ │
│  │  • Handle /spawn-worker commands from conductor                    │ │
│  │  • Route worker output back to conductor                           │ │
│  │  • Kill workers when conductor says done                           │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CONDUCTOR VM                                     │
│                     (Long-running E2B sandbox)                           │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                    INITIAL SYSTEM PROMPT                            │ │
│  │                                                                     │ │
│  │  You are a conductor agent responsible for managing tasks.          │ │
│  │                                                                     │ │
│  │  You will receive messages in your CLI from various sources:        │ │
│  │  - [EMAIL] from: ... subject: ... body: ...                        │ │
│  │  - [SMS] from: ... message: ...                                    │ │
│  │  - [USER] prompt from web interface                                │ │
│  │  - [WORKER:id] output from a worker you spawned                    │ │
│  │                                                                     │ │
│  │  For each message, decide:                                          │ │
│  │  1. Does this need action? If not, say so and wait for next.       │ │
│  │  2. Can you handle it directly? If simple, just do it.             │ │
│  │  3. Need dedicated focus? Use /spawn-worker to create a worker.    │ │
│  │                                                                     │ │
│  │  Available commands:                                                │ │
│  │  /spawn-worker <task description>  - Create worker VM for task     │ │
│  │  /message-worker <id> <message>    - Send message to worker        │ │
│  │  /kill-worker <id>                 - Terminate a worker            │ │
│  │  /send-email <to> <subject> <body> - Send email response           │ │
│  │  /send-sms <to> <message>          - Send SMS response             │ │
│  │                                                                     │ │
│  │  When a worker reports completion, validate the work.               │ │
│  │  If satisfactory, send the appropriate response and kill worker.   │ │
│  │  If not, send clarifying instructions to the worker.               │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                      PRELOADED CAPABILITIES                         │ │
│  │                                                                     │ │
│  │  Skills:                                                            │ │
│  │  • All project-specific skills from .claude/skills/                │ │
│  │  • Computer use (browser, desktop)                                  │ │
│  │  • Code editing, file management, git                              │ │
│  │                                                                     │ │
│  │  MCP Servers:                                                       │ │
│  │  • Filesystem access                                                │ │
│  │  • Database connections                                             │ │
│  │  • API integrations                                                 │ │
│  │                                                                     │ │
│  │  Custom Commands:                                                   │ │
│  │  • /spawn-worker, /message-worker, /kill-worker                    │ │
│  │  • /send-email, /send-sms                                          │ │
│  │  • /list-workers, /worker-status                                   │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                         /spawn-worker
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐
│     WORKER VM        │ │     WORKER VM        │ │     WORKER VM        │
│                      │ │                      │ │                      │
│  Same capabilities   │ │  Same capabilities   │ │  Same capabilities   │
│  as conductor        │ │  as conductor        │ │  as conductor        │
│                      │ │                      │ │                      │
│  Initial prompt:     │ │  Initial prompt:     │ │  Initial prompt:     │
│  "You are a worker.  │ │  "You are a worker.  │ │  "You are a worker.  │
│   Complete this      │ │   Complete this      │ │   Complete this      │
│   task: <task>       │ │   task: <task>       │ │   task: <task>       │
│                      │ │                      │ │                      │
│   Only conductor     │ │   Only conductor     │ │   Only conductor     │
│   sends you msgs.    │ │   sends you msgs.    │ │   sends you msgs.    │
│   Report progress    │ │   Report progress    │ │   Report progress    │
│   and completion."   │ │   and completion."   │ │   and completion."   │
│                      │ │                      │ │                      │
│  stdout ─────────────┼─┼──────────────────────┼─┼───► Conductor CLI   │
└──────────────────────┘ └──────────────────────┘ └──────────────────────┘
```

## Message Format

Messages injected into conductor CLI are formatted consistently:

```
[EMAIL]
From: client@example.com
To: agent@yourdomain.com
Subject: Please update the pricing on our landing page
Body:
Hi, can you update the pricing section? The new prices are:
- Basic: $29/mo
- Pro: $79/mo
Thanks!
---

[SMS]
From: +1234567890
Message: Hey, is the build passing?
---

[USER]
From: noah@example.com
Message: Can you set up a new GitHub repo for the mobile app?
---

[WORKER:abc123]
Status: COMPLETE
Summary: Updated pricing on landing page. Created PR #42.
Details:
- Modified src/components/Pricing.tsx
- Updated Basic to $29, Pro to $79
- All tests passing
- PR: https://github.com/client/landing-page/pull/42
---
```

## Command Protocol

### /spawn-worker

Conductor uses this to create a new worker VM:

```
/spawn-worker Update the pricing on client landing page. Basic=$29, Pro=$79.
              Create a PR when done.
```

Infrastructure:
1. Creates new E2B sandbox with same template
2. Injects worker system prompt + task
3. Returns worker ID to conductor
4. Routes worker stdout back to conductor

### /message-worker

Send additional instructions to a running worker:

```
/message-worker abc123 Actually, also update the FAQ section with the new prices.
```

### /kill-worker

Terminate a worker when done:

```
/kill-worker abc123
```

### /send-email, /send-sms

Send responses through appropriate channels:

```
/send-email client@example.com "Pricing Updated" "Hi! I've updated the pricing as requested. PR: https://..."
```

## Infrastructure Implementation

### 1. Message Router Service

```typescript
class MessageRouter {
  private conductorSandbox: Sandbox;

  async routeEmail(email: EmailWebhook): Promise<void> {
    const formatted = this.formatEmailMessage(email);
    await this.injectIntoConductor(formatted);
  }

  async routeSMS(sms: SMSWebhook): Promise<void> {
    const formatted = this.formatSMSMessage(sms);
    await this.injectIntoConductor(formatted);
  }

  async routeUserPrompt(prompt: UserPrompt): Promise<void> {
    const formatted = this.formatUserMessage(prompt);
    await this.injectIntoConductor(formatted);
  }

  async routeWorkerOutput(workerId: string, output: string): Promise<void> {
    const formatted = this.formatWorkerMessage(workerId, output);
    await this.injectIntoConductor(formatted);
  }

  private async injectIntoConductor(message: string): Promise<void> {
    // Write to conductor's stdin or a watched file
    await this.conductorSandbox.files.write('/workspace/inbox/next.msg', message);
    // Or use process stdin if we have that handle
  }
}
```

### 2. VM Manager Service

```typescript
class VMManager {
  private conductorSandbox: Sandbox | null = null;
  private workers: Map<string, Sandbox> = new Map();

  async startConductor(): Promise<void> {
    this.conductorSandbox = await Sandbox.create({
      template: process.env.E2B_CONDUCTOR_TEMPLATE,
      timeout: 0, // Keep alive indefinitely
    });

    // Inject system prompt and start agent
    await this.initializeConductor();

    // Watch for commands from conductor
    this.watchConductorCommands();
  }

  async spawnWorker(task: string): Promise<string> {
    const workerId = uuidv4().slice(0, 8);

    const sandbox = await Sandbox.create({
      template: process.env.E2B_WORKER_TEMPLATE,
      timeout: 3600000, // 1 hour max
    });

    // Inject worker prompt with task
    await this.initializeWorker(sandbox, workerId, task);

    // Route stdout back to conductor
    this.routeWorkerOutput(workerId, sandbox);

    this.workers.set(workerId, sandbox);
    return workerId;
  }

  async killWorker(workerId: string): Promise<void> {
    const sandbox = this.workers.get(workerId);
    if (sandbox) {
      await sandbox.kill();
      this.workers.delete(workerId);
    }
  }

  private watchConductorCommands(): void {
    // Monitor conductor output for commands
    // Parse /spawn-worker, /kill-worker, /send-email, etc.
    // Execute infrastructure actions
  }
}
```

### 3. Command Parser

```typescript
class CommandParser {
  parse(output: string): Command | null {
    const lines = output.split('\n');

    for (const line of lines) {
      if (line.startsWith('/spawn-worker ')) {
        return {
          type: 'spawn-worker',
          task: line.slice('/spawn-worker '.length),
        };
      }
      if (line.startsWith('/kill-worker ')) {
        return {
          type: 'kill-worker',
          workerId: line.slice('/kill-worker '.length).trim(),
        };
      }
      if (line.startsWith('/message-worker ')) {
        const rest = line.slice('/message-worker '.length);
        const [workerId, ...messageParts] = rest.split(' ');
        return {
          type: 'message-worker',
          workerId,
          message: messageParts.join(' '),
        };
      }
      if (line.startsWith('/send-email ')) {
        return this.parseEmailCommand(line);
      }
      if (line.startsWith('/send-sms ')) {
        return this.parseSMSCommand(line);
      }
    }

    return null;
  }
}
```

## Example Flow

### 1. Email Arrives

```
Infrastructure receives webhook:
{
  from: "client@example.com",
  to: "agent@yourdomain.com",
  subject: "Update pricing",
  body: "Please update Basic to $29..."
}

Formats and injects into conductor:
[EMAIL]
From: client@example.com
Subject: Update pricing
Body: Please update Basic to $29...
---
```

### 2. Conductor Decides

```
Conductor (thinking): This email requires action. I need to update
pricing on a website. This is a focused coding task, so I'll spawn
a worker.

Conductor output:
I'll handle this pricing update request.

/spawn-worker Update the pricing on the client landing page.
  Change Basic plan to $29/month and Pro plan to $79/month.
  The repo is at github.com/client/landing-page.
  Create a PR when done.
```

### 3. Worker Executes

```
Worker receives task, works autonomously:
- Clones repo
- Finds pricing component
- Updates values
- Runs tests
- Creates PR

Worker stdout (routed to conductor):
[WORKER:abc123]
Status: COMPLETE
Summary: Updated pricing and created PR #42
PR URL: https://github.com/client/landing-page/pull/42
Tests: All passing
---
```

### 4. Conductor Validates & Responds

```
Conductor receives worker output, evaluates:
"Worker completed the task. PR created, tests passing.
This looks good. I'll send the response and cleanup."

Conductor output:
The pricing update is complete. Sending confirmation.

/send-email client@example.com "Re: Update pricing" "Hi! I've updated the pricing as requested. Here's the PR for review: https://github.com/client/landing-page/pull/42"

/kill-worker abc123
```

## Key Advantages

1. **Natural Decision Making** - Conductor uses Claude's reasoning, no separate triage logic
2. **Simple Communication** - CLI stdin/stdout, no HTTP APIs between agents
3. **Stateless Infrastructure** - State lives in agent conversation, not database
4. **Easy to Debug** - Just read the conductor's conversation log
5. **Flexible** - Conductor can handle simple tasks directly, only spawn when needed

## Open Questions

1. **CLI Input Mechanism** - Best way to inject messages into running Claude agent?
   - Write to watched file that agent reads?
   - Pipe to stdin?
   - Use Claude Agent SDK's message API?

2. **Persistent VM** - E2B sandbox lifetime management
   - Keep-alive pings?
   - Auto-restart if crashed?
   - State recovery?

3. **Parallel Workers** - How does conductor track multiple simultaneous workers?
   - Worker IDs in messages
   - Conductor maintains mental map

4. **Cost Control** - Conductor VM runs 24/7
   - Could hibernate when no pending work
   - Or accept slightly higher baseline cost for simplicity
