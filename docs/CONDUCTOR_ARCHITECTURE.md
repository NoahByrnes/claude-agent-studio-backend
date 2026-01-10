# Conductor/Worker Agent Architecture

## Overview

This document describes a two-tier agent architecture that enables fully autonomous task execution without human-in-the-loop validation. The **Conductor** replaces human judgment, while **Workers** execute tasks in isolated environments.

### The Problem

Current agent systems (like Claude Code) are designed for human-in-the-loop operation:
- Agent works on task
- Returns to human for questions/validation
- Human provides feedback
- Agent continues

This doesn't work for autonomous workflows where:
- Tasks arrive via webhooks (email, Slack, API)
- Work must complete without human intervention
- Results must be validated before final action
- Response must be sent back automatically

### The Solution

A two-tier architecture where the **Conductor** acts as the intelligent orchestrator:

```
┌─────────────────────────────────────────────────────────────────────┐
│                           CONDUCTOR                                  │
│        (Lightweight - Cloudflare Worker or Minimal Container)        │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │   Webhooks   │  │   Decision   │  │    Validation Loop       │  │
│  │              │  │   Engine     │  │                          │  │
│  │  • Email     │  │              │  │  1. Receive worker output│  │
│  │  • Slack     │  │  • Parse     │  │  2. Compare to request   │  │
│  │  • API       │  │  • Classify  │  │  3. Validate completion  │  │
│  │  • Schedule  │  │  • Route     │  │  4. Retry or finalize    │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                            │                      ▲                  │
│                            ▼                      │                  │
│                  ┌─────────────────────┐          │                  │
│                  │   Worker Manager    │──────────┘                  │
│                  │                     │                             │
│                  │  • Spin up VMs      │                             │
│                  │  • Pass context     │                             │
│                  │  • Monitor status   │                             │
│                  │  • Cleanup on done  │                             │
│                  └─────────────────────┘                             │
└─────────────────────────────────────────────────────────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
     ┌────────────┐     ┌────────────┐     ┌────────────┐
     │   WORKER   │     │   WORKER   │     │   WORKER   │
     │  (E2B VM)  │     │  (E2B VM)  │     │  (E2B VM)  │
     │            │     │            │     │            │
     │  Full env: │     │  Full env: │     │  Full env: │
     │  • Browser │     │  • Code    │     │  • APIs    │
     │  • Claude  │     │  • Git     │     │  • Data    │
     │  • MCP     │     │  • Deploy  │     │  • Files   │
     │  • Tools   │     │  • Test    │     │  • Email   │
     └────────────┘     └────────────┘     └────────────┘
```

---

## Conductor Agent

### Responsibilities

1. **Event Reception** - Receive incoming events via webhooks
2. **Triage** - Decide if event requires action or can be ignored
3. **Task Decomposition** - Break complex requests into worker tasks
4. **Worker Orchestration** - Spin up/down worker VMs as needed
5. **Validation** - Compare worker output against original request
6. **Retry Logic** - Handle failures, spin up fresh workers if needed
7. **Final Action** - Send response, update systems, trigger downstream

### Runtime Environment

The conductor is **lightweight** and doesn't need a full workstation:

**Option A: Cloudflare Worker**
- Pros: Always-on, auto-scaling, cheap, global edge
- Cons: Limited runtime (50ms CPU), no persistent state
- Best for: Simple triage + dispatch to workers

**Option B: Minimal Container (Railway/Fly.io)**
- Pros: More flexibility, can hold state, longer timeouts
- Cons: More infrastructure to manage
- Best for: Complex validation logic, multi-step orchestration

**Option C: Long-running E2B sandbox (minimal)**
- Pros: Same infra as workers, can run Claude SDK
- Cons: More expensive for always-on
- Best for: When conductor needs Claude reasoning

### Conductor Skills/Commands

The conductor has **limited direct capabilities** but can:

```typescript
// Built-in skills the conductor has access to
const conductorSkills = {
  // Webhook/Communication
  'receive-email': () => { /* parse incoming email */ },
  'send-email': (to, subject, body) => { /* send via SMTP */ },
  'send-slack': (channel, message) => { /* post to Slack */ },

  // Worker Management
  'spawn-worker': (task, context) => { /* spin up E2B VM */ },
  'check-worker': (workerId) => { /* get status/output */ },
  'kill-worker': (workerId) => { /* terminate VM */ },

  // Validation (these use Claude internally)
  'validate-completion': (task, output) => { /* did worker complete task? */ },
  'compare-to-request': (request, response) => { /* does output satisfy request? */ },
};
```

### Conductor State Machine

```
                    ┌─────────────┐
                    │   IDLE      │
                    └──────┬──────┘
                           │ event received
                           ▼
                    ┌─────────────┐
              ┌─────│  TRIAGING   │─────┐
              │     └─────────────┘     │
              │ ignore                  │ action needed
              ▼                         ▼
       ┌────────────┐           ┌─────────────┐
       │  IGNORED   │           │  SPAWNING   │
       │  (log it)  │           │   WORKER    │
       └────────────┘           └──────┬──────┘
                                       │ worker started
                                       ▼
                                ┌─────────────┐
                          ┌─────│  MONITORING │◄────┐
                          │     └──────┬──────┘     │
                          │            │            │
            worker blocked│            │worker done │ retry
                          ▼            ▼            │
                   ┌────────────┐  ┌─────────────┐  │
                   │  HANDLING  │  │  VALIDATING │──┘
                   │  QUESTION  │  └──────┬──────┘
                   └─────┬──────┘         │ valid
                         │                ▼
                         │         ┌─────────────┐
                         └────────►│ FINALIZING  │
                                   └──────┬──────┘
                                          │
                                          ▼
                                   ┌─────────────┐
                                   │  COMPLETED  │
                                   └─────────────┘
```

---

## Worker Agent

### Responsibilities

1. **Task Execution** - Complete the assigned task fully
2. **Tool Usage** - Use all available tools (browser, code, APIs)
3. **Sub-agent Spawning** - Create child agents within its VM if needed
4. **Status Reporting** - Report progress, questions, completion to conductor

### Runtime Environment

Workers run in **full E2B sandboxes** with complete tooling:

```typescript
// Worker has access to everything
const workerCapabilities = {
  // Claude Agent SDK
  claude: true,          // Full Claude reasoning
  maxTurns: 100,         // High turn limit for complex tasks

  // Development tools
  browser: true,         // Playwright/Puppeteer
  terminal: true,        // Full bash access
  git: true,             // Version control
  docker: true,          // Container-in-container if needed

  // MCP servers
  filesystem: true,      // Read/write files
  databases: true,       // PostgreSQL, SQLite, etc.
  apis: true,            // HTTP client, OAuth

  // Communication (via conductor)
  email: 'via-conductor', // Worker requests conductor to send
  slack: 'via-conductor', // Worker requests conductor to send
};
```

### Worker Communication Protocol

Workers communicate with conductor via a simple protocol:

```typescript
type WorkerMessage =
  | { type: 'progress', message: string, percent?: number }
  | { type: 'question', question: string, context?: string }
  | { type: 'blocked', reason: string, suggestedAction?: string }
  | { type: 'done', result: WorkerResult }
  | { type: 'error', error: string, recoverable: boolean };

type WorkerResult = {
  success: boolean;
  summary: string;           // Human-readable summary
  artifacts?: Artifact[];    // Files, URLs, data produced
  validationHints?: string;  // Hints for conductor validation
};
```

### Worker Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                      WORKER LIFECYCLE                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   1. SPAWN                                                   │
│      - Conductor calls E2B.spawn()                          │
│      - Worker receives: { task, context, originalRequest }  │
│      - Worker acknowledges receipt                          │
│                                                              │
│   2. EXECUTE                                                 │
│      - Worker plans approach                                 │
│      - Worker executes using all available tools            │
│      - Worker sends progress updates periodically           │
│      - If stuck: sends 'question' or 'blocked' message      │
│                                                              │
│   3. COMPLETE                                                │
│      - Worker sends 'done' with result                      │
│      - Worker includes summary and artifacts                │
│      - Worker suggests validation approach                  │
│                                                              │
│   4. TERMINATE                                               │
│      - Conductor validates result                           │
│      - If valid: conductor kills VM, proceeds to finalize   │
│      - If invalid: conductor may retry with same or new VM  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Validation Loop (The Key Innovation)

The validation loop is what replaces human judgment:

### How It Works

```typescript
async function validateCompletion(
  originalRequest: Request,
  workerResult: WorkerResult
): Promise<ValidationResult> {

  // 1. Parse what was requested
  const requestedAction = await parseRequest(originalRequest);

  // 2. Parse what worker produced
  const producedOutput = await parseResult(workerResult);

  // 3. Compare using Claude
  const validation = await claude.validate({
    prompt: `
      Original Request:
      ${JSON.stringify(requestedAction)}

      Worker Output:
      ${JSON.stringify(producedOutput)}

      Questions:
      1. Did the worker complete the requested task?
      2. Are there any obvious errors or omissions?
      3. Is the output appropriate to send as a response?
      4. Confidence level (1-10)?

      Respond with: VALID, INVALID, or NEEDS_REVISION
    `
  });

  return validation;
}
```

### Validation Decision Tree

```
                     Worker reports DONE
                            │
                            ▼
                ┌───────────────────────┐
                │  Parse worker output  │
                └───────────┬───────────┘
                            │
                            ▼
                ┌───────────────────────┐
                │  Compare to original  │
                │       request         │
                └───────────┬───────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
       ┌─────────┐    ┌──────────┐    ┌───────────┐
       │  VALID  │    │  PARTIAL │    │  INVALID  │
       └────┬────┘    └────┬─────┘    └─────┬─────┘
            │              │                │
            ▼              ▼                ▼
      ┌──────────┐   ┌──────────┐    ┌──────────┐
      │ Finalize │   │  Retry   │    │  New     │
      │  & Send  │   │  Same VM │    │  Worker  │
      └──────────┘   └──────────┘    └──────────┘
```

### Retry Strategies

1. **Same VM Retry** - If partially complete, give worker more guidance
2. **Fresh VM Retry** - If worker got confused, start clean
3. **Different Approach** - If approach failed, try alternative strategy
4. **Escalate** - If multiple retries fail, notify human

---

## Implementation Plan

### Phase 1: Conductor Core

```typescript
// src/conductor/conductor.service.ts

export class ConductorService {
  constructor(
    private workerManager: WorkerManagerService,
    private validator: ValidationService,
    private notifier: NotificationService,
  ) {}

  async handleEvent(event: IncomingEvent): Promise<void> {
    // 1. Triage
    const decision = await this.triage(event);
    if (decision.action === 'ignore') {
      await this.logIgnored(event, decision.reason);
      return;
    }

    // 2. Spawn worker
    const task = this.createTask(event, decision);
    const worker = await this.workerManager.spawn(task);

    // 3. Monitor and validate
    const result = await this.monitorWorker(worker);
    const validation = await this.validator.validate(task, result);

    // 4. Retry or finalize
    if (validation.status === 'valid') {
      await this.finalize(event, result);
    } else {
      await this.retry(event, task, validation);
    }
  }

  private async triage(event: IncomingEvent): Promise<TriageDecision> {
    // Use Claude to analyze event and decide action
  }

  private async finalize(event: IncomingEvent, result: WorkerResult): Promise<void> {
    // Send response email, post to Slack, etc.
  }
}
```

### Phase 2: Worker Manager

```typescript
// src/conductor/worker-manager.service.ts

export class WorkerManagerService {
  constructor(private e2b: E2BSandboxService) {}

  async spawn(task: Task): Promise<Worker> {
    // Create E2B sandbox
    const sandbox = await this.e2b.create({
      template: 'worker-template',
      timeout: task.timeout || 3600, // 1 hour default
    });

    // Inject task context
    await sandbox.exec(`
      export TASK='${JSON.stringify(task)}'
      export CONDUCTOR_URL='${this.conductorUrl}'
      npm start
    `);

    return {
      id: sandbox.id,
      status: 'running',
      startedAt: new Date(),
    };
  }

  async getStatus(workerId: string): Promise<WorkerStatus> {
    // Check worker progress
  }

  async kill(workerId: string): Promise<void> {
    await this.e2b.stop(workerId);
  }
}
```

### Phase 3: Validation Service

```typescript
// src/conductor/validation.service.ts

export class ValidationService {
  async validate(
    task: Task,
    result: WorkerResult
  ): Promise<ValidationResult> {

    // Use Claude to validate completion
    const response = await this.claude.message({
      model: 'claude-sonnet-4-5',
      messages: [{
        role: 'user',
        content: this.buildValidationPrompt(task, result)
      }]
    });

    return this.parseValidation(response);
  }

  private buildValidationPrompt(task: Task, result: WorkerResult): string {
    return `
You are validating whether a task was completed correctly.

## Original Task
${task.description}

## Original Request
${JSON.stringify(task.originalRequest)}

## Worker Output
${result.summary}

## Artifacts Produced
${JSON.stringify(result.artifacts)}

## Validation Questions
1. Was the core request fulfilled?
2. Are there any errors or issues?
3. Is the output ready to be used/sent?

Respond in JSON:
{
  "status": "valid" | "partial" | "invalid",
  "confidence": 1-10,
  "issues": ["list of issues if any"],
  "suggestion": "what to do if not valid"
}
`;
  }
}
```

### Phase 4: Notification Service

```typescript
// src/conductor/notification.service.ts

export class NotificationService {
  async sendEmail(params: EmailParams): Promise<void> {
    // Use Resend, SendGrid, etc.
  }

  async postSlack(params: SlackParams): Promise<void> {
    // Use Slack API
  }

  async respond(
    originalEvent: IncomingEvent,
    result: WorkerResult
  ): Promise<void> {
    // Route response based on event type
    switch (originalEvent.type) {
      case 'email':
        await this.sendEmailReply(originalEvent, result);
        break;
      case 'slack':
        await this.postSlackReply(originalEvent, result);
        break;
      // etc.
    }
  }
}
```

---

## Email Workflow Example

```
┌─────────────────────────────────────────────────────────────────┐
│                     EMAIL WORKFLOW EXAMPLE                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. EMAIL ARRIVES                                                │
│     From: client@example.com                                    │
│     Subject: "Please update the pricing on our landing page"    │
│                                                                  │
│  2. CONDUCTOR RECEIVES (via webhook)                             │
│     - Parses email content                                       │
│     - Identifies: ACTION_REQUIRED (not spam/marketing)          │
│     - Extracts: Task = "Update pricing on landing page"         │
│                                                                  │
│  3. CONDUCTOR SPAWNS WORKER                                      │
│     Task: {                                                      │
│       description: "Update pricing on landing page",            │
│       context: {                                                 │
│         email: { from, subject, body },                         │
│         project: "client-landing-page",                         │
│         repo: "github.com/client/landing-page"                  │
│       }                                                          │
│     }                                                            │
│                                                                  │
│  4. WORKER EXECUTES                                              │
│     - Clones repo                                                │
│     - Finds pricing component                                    │
│     - Updates values                                             │
│     - Commits changes                                            │
│     - Opens PR                                                   │
│     - Reports: DONE { pr_url: "..." }                           │
│                                                                  │
│  5. CONDUCTOR VALIDATES                                          │
│     - Checks PR exists                                           │
│     - Verifies pricing was changed                              │
│     - Confirms no breaking changes                               │
│     - Result: VALID                                              │
│                                                                  │
│  6. CONDUCTOR FINALIZES                                          │
│     - Sends email reply:                                         │
│       "Hi! I've updated the pricing. Here's the PR: [link]"    │
│     - Kills worker VM                                            │
│     - Logs completion                                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Architecture Decisions

### Why Separate Conductor and Worker?

| Aspect | Conductor | Worker |
|--------|-----------|--------|
| Runtime | Always-on, lightweight | Ephemeral, full VM |
| Cost | Low (minimal compute) | Higher (full sandbox) |
| State | Persistent (tracks tasks) | Stateless (dies after task) |
| Tools | Limited (spawn, validate) | Full (browser, code, etc.) |
| Failure mode | Must be reliable | Can be killed/retried |

### Why Not Just One Big Agent?

1. **Cost** - A single always-on VM with full tooling is expensive
2. **Reliability** - If worker gets stuck, we can kill and retry
3. **Isolation** - Each task runs in clean environment
4. **Scalability** - Can run many workers in parallel
5. **Security** - Workers are sandboxed, conductor has limited privileges

### Conductor Hosting Options

| Option | Pros | Cons | Best For |
|--------|------|------|----------|
| Cloudflare Worker | Cheap, always-on, global | Limited CPU time | Simple triage |
| Railway/Fly.io | More flexible | More to manage | Complex orchestration |
| E2B Sandbox | Same as workers | More expensive | When conductor needs Claude |
| Existing Backend | Already running | Might be overloaded | Integration simplicity |

**Recommendation**: Start with the existing backend (add conductor as a service), then extract to Cloudflare Worker when patterns are clear.

---

## Open Questions

1. **How does conductor access project context?**
   - Option A: Conductor has read-only access to repos
   - Option B: Context is stored in DB, passed to workers
   - Option C: Workers fetch their own context

2. **How do workers communicate back?**
   - Option A: HTTP callbacks to conductor
   - Option B: Shared message queue (Redis)
   - Option C: WebSocket connection

3. **What happens if conductor itself fails?**
   - Need persistence layer for in-progress tasks
   - Recovery mechanism to resume orchestration

4. **How to handle long-running tasks?**
   - Workers have timeouts
   - Conductor can checkpoint progress
   - Resume with context if interrupted

---

## Next Steps

1. [ ] Implement ConductorService in existing backend
2. [ ] Create worker communication protocol
3. [ ] Build ValidationService with Claude
4. [ ] Add email notification capability
5. [ ] Test end-to-end with email workflow
6. [ ] Extract conductor to standalone service (optional)
