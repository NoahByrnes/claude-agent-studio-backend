# Conductor/Worker Architecture - Session Context

> This document captures the design decisions and discoveries from an architecture session.
> Feed this to Claude Code to continue development.

## Project Overview

Building an **autonomous agent platform** where:
- Agents receive tasks via webhooks (email, SMS, API)
- Complete work without human-in-the-loop
- Validate their own output
- Send responses back automatically

Repository: `claude-agent-studio-backend`
Branch: `claude/agent-orchestration-design-OIndq`

---

## Architecture Decision: Conductor/Worker Pattern

### The Model

```
┌─────────────────────────────────────────────────────────────────┐
│                      CONDUCTOR                                   │
│           (Receives all incoming messages)                       │
│                                                                  │
│  • Triages: "Does this need action?"                            │
│  • Delegates: Spawns workers for complex tasks                  │
│  • Validates: Checks worker output against original request     │
│  • Responds: Sends email/SMS back when complete                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                    spawns workers
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       ┌───────────┐   ┌───────────┐   ┌───────────┐
       │  WORKER   │   │  WORKER   │   │  WORKER   │
       │           │   │           │   │           │
       │ Executes  │   │ Executes  │   │ Executes  │
       │ one task  │   │ one task  │   │ one task  │
       │           │   │           │   │           │
       │ Reports   │   │ Reports   │   │ Reports   │
       │ back to   │   │ back to   │   │ back to   │
       │ conductor │   │ conductor │   │ conductor │
       └───────────┘   └───────────┘   └───────────┘
```

### Key Insight

The conductor **replaces human-in-the-loop** with **agent-in-the-loop**:
- Human would validate output → Conductor validates output
- Human would answer questions → Conductor answers questions
- Human would decide next steps → Conductor decides next steps

---

## Technology Choice: Claude Code CLI (not Agent SDK)

### Why CLI over SDK

| CLI | SDK |
|-----|-----|
| Full Claude Code experience | Stripped down programmatic API |
| All tools, skills, computer use | Limited tool set |
| Interactive development style | Batch processing style |
| Session persistence built-in | Manual state management |

### CLI Session Management

**Key Discovery**: Two CLI sessions CAN communicate using `--resume`:

```bash
# 1. Start conductor, capture session ID
CONDUCTOR_ID=$(claude -p "You are a conductor..." --output-format json | jq -r '.session_id')

# 2. Start worker, capture session ID
WORKER_ID=$(claude -p "You are a worker..." --output-format json | jq -r '.session_id')

# 3. Send message to conductor's session
claude -p --resume $CONDUCTOR_ID "[EMAIL] From: client@... Subject: ..." --output-format json

# 4. Send task to worker's session
claude -p --resume $WORKER_ID "Task: update the pricing..." --output-format json

# 5. Send worker result back to conductor
claude -p --resume $CONDUCTOR_ID "[WORKER:abc] Result: PR created" --output-format json
```

**Key Flags**:
- `-p` = print mode (non-interactive, no TTY needed)
- `--resume <session-id>` = continue specific session
- `--output-format json` = get structured response with session_id
- `--output-format stream-json` = get all messages as NDJSON

**Sessions persist** in `~/.claude/projects/` as JSONL files.

---

## Open Question: Single VM vs Multiple VMs

### Option A: Single VM
- Conductor and workers run on same machine
- Different session IDs, same `~/.claude/` directory
- Simpler, but less isolation

### Option B: Multiple VMs (E2B sandboxes)
- Conductor in one VM, workers in separate VMs
- Each VM has own `~/.claude/`
- Communication via HTTP between VMs (backend routes messages)
- More isolation, parallel execution

### Explored: Shared Network Drive
Could mount network storage at `~/.claude/projects/` so all VMs see same sessions.

**Challenges discovered**:
- `CLAUDE_HOME` env var doesn't work (ignored by CLI)
- Symlinking `~/.claude/` has security restrictions
- Symlinking subdirectories might work
- HPC/network filesystem users report path resolution issues

**Verdict**: Uncertain without testing. HTTP routing between VMs is more reliable.

---

## Implementation Created

### 1. Test Script
`scripts/test-conductor-worker-communication.sh`
- Demonstrates two-way CLI session communication
- Creates conductor + worker sessions
- Routes messages between them

### 2. TypeScript Implementation
`src/conductor-cli/`
- `types.ts` - CLI response types, session types
- `cli-executor.ts` - Wraps `claude` command
- `conductor-manager.ts` - Orchestrates sessions

### 3. Previous Implementations (for reference)
`src/conductor/` - Service-based approach (separate triage/validation services)
`src/conductor-vm/` - VM-based approach with file watching

---

## Message Format (Conductor receives these)

```
[EMAIL]
From: client@example.com
To: agent@mycompany.com
Subject: Please update the pricing
Body:
Change Basic to $29 and Pro to $79.
---

[SMS]
From: +1234567890
Message: Is the build passing?
---

[WORKER:abc123]
Status: COMPLETE
Summary: Updated pricing, created PR #42
Details:
- Modified src/components/Pricing.tsx
- All tests passing
- PR: https://github.com/...
---
```

## Command Format (Conductor outputs these)

```
SPAWN_WORKER: Update pricing on landing page. Basic=$29, Pro=$79.

SEND_EMAIL: client@example.com | Re: Update pricing | Done! PR: https://...

SEND_SMS: +1234567890 | Build is green!

KILL_WORKER: abc123
```

---

## Next Steps

1. **Test the CLI pattern locally**
   - Run `scripts/test-conductor-worker-communication.sh`
   - Verify sessions persist and resume correctly

2. **Decide: Single VM or Multi-VM?**
   - Single VM = simpler, start here
   - Multi-VM = more robust, add later

3. **Build the message router**
   - Webhook receives email/SMS
   - Formats as message
   - Calls `claude -p --resume $CONDUCTOR_ID "message"`

4. **Build the command executor**
   - Parse conductor output for commands
   - Execute SPAWN_WORKER, SEND_EMAIL, etc.

5. **Test end-to-end**
   - Email arrives
   - Conductor triages
   - Worker executes
   - Conductor validates
   - Email sent back

---

## Files Changed (this session)

```
docs/CONDUCTOR_ARCHITECTURE.md      # Original service-based design
docs/CONDUCTOR_VM_ARCHITECTURE.md   # VM-based design
src/conductor/                      # Service-based implementation
src/conductor-vm/                   # VM-based implementation
src/conductor-cli/                  # CLI-based implementation ← CURRENT
scripts/test-conductor-worker-communication.sh  # Test script
```

---

## Commands to Get Started

```bash
# Clone and checkout the branch
git clone <repo>
cd claude-agent-studio-backend
git checkout claude/agent-orchestration-design-OIndq

# Look at the CLI implementation
cat src/conductor-cli/conductor-manager.ts

# Run the test script (requires claude CLI installed)
./scripts/test-conductor-worker-communication.sh
```
