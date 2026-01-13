# Memory Persistence Troubleshooting

## Problem

The claude-mem plugin may not be installed or working in the E2B sandbox, which means Stu's memory isn't persisting across sessions as expected.

## Quick Test

SSH into a conductor sandbox and check:

```bash
# Connect to running conductor sandbox
e2b sandbox connect <sandbox-id>

# Check if claude-mem directory exists
ls -la /root/.claude-mem

# Check if claude-mem plugin is available
claude --help | grep mem

# Check Claude CLI version
claude --version
```

## How Memory Should Work

### With claude-mem Plugin (Ideal)
1. Claude CLI automatically creates ~/.claude-mem
2. Stores conversation context and learned knowledge
3. Our backup service exports to Redis
4. Restored on next conductor startup
5. Stu has full conversation history

### Without claude-mem (Current Reality?)
1. Claude CLI session stores history internally
2. No persistent ~/.claude-mem directory
3. Memory lost between sessions
4. Need alternative approach

## Solution Options

### Option 1: Install claude-mem in E2B Template

Update E2B template to install claude-mem:

```dockerfile
FROM e2b-base:latest

# Install Claude CLI (if not already installed)
RUN npm install -g @anthropic-ai/claude-cli

# Install claude-mem plugin
RUN claude plugins install claude-mem

# Configure claude-mem (create config)
RUN mkdir -p /root/.config/claude
RUN echo '{"plugins": {"claude-mem": {"enabled": true}}}' > /root/.config/claude/config.json
```

Then rebuild template and update E2B_TEMPLATE_ID.

### Option 2: Manual Memory Storage (Interim Solution)

Instead of relying on claude-mem, have Stu explicitly manage memory using files.

Add to Stu's system prompt:

```
## Memory Management (CRITICAL)

You have persistent memory via a simple file-based system:

**Reading your memory:**
Before starting work, check your memory file:
"Read the file /root/stu-memory.json"

**Updating your memory:**
After learning something important (API knowledge, user preferences), update it:
"Write to /root/stu-memory.json with updated JSON containing all learned knowledge"

**Memory format (JSON):**
{
  "user_preferences": {
    "favorite_color": "blue",
    "timezone": "America/Vancouver"
  },
  "api_knowledge": {
    "bcferries.ca": {
      "has_api": false,
      "notes": "Browser automation required, no public API"
    },
    "stripe.com": {
      "has_api": true,
      "endpoint": "api.stripe.com/v1",
      "notes": "REST API for customer management"
    }
  },
  "task_history": [
    {
      "date": "2024-01-12",
      "task": "BC Ferries booking",
      "outcome": "success",
      "learned": "No API, use Playwright"
    }
  ]
}

**When to update memory:**
- After worker reports API discovery/no-API finding
- When user shares preferences
- After completing significant tasks
- When learning new capabilities

**Example flow:**
1. Worker reports: "FYI: BC Ferries has no API"
2. You respond: "Got it!"
3. You immediately update memory:
   "Write to /root/stu-memory.json [updated JSON with BC Ferries info]"
```

### Option 3: Redis-Based Memory (Backend-Managed)

Store memory in Redis, managed by the backend:

1. After each conductor response, extract knowledge from conversation
2. Parse worker FYI messages automatically
3. Store in Redis: `conductor:knowledge:<domain>`
4. Inject into next conductor session's system prompt

**Pros**: Reliable, doesn't depend on claude-mem
**Cons**: More complex backend logic, less flexible

## Recommended Immediate Fix

Use **Option 2** (Manual Memory) as an interim solution:

1. Add explicit memory management to Stu's system prompt
2. Have Stu read/write `/root/stu-memory.json`
3. Backup service already backs up entire /root directory structure
4. Works immediately without E2B template changes

Then migrate to **Option 1** (claude-mem) when E2B template is rebuilt.

## Testing Memory Persistence

### Test 1: Check if claude-mem Works

```bash
# In Railway logs, look for:
grep "No .claude-mem directory found" logs

# If you see this frequently, claude-mem isn't working
```

### Test 2: Manual Memory Test

Send to Stu via SMS:
```
"My favorite color is blue. Store this in your memory."
```

Wait 5 minutes (let session close), then:
```
"What's my favorite color?"
```

If Stu doesn't remember: Memory isn't working

### Test 3: API Knowledge Test

Day 1:
```
"Research if BC Ferries has an API"
```

Day 2:
```
"What do you know about BC Ferries?"
```

If Stu doesn't remember: Memory isn't working

## Implementation Plan

### Immediate (No E2B changes needed)

1. ✅ Update Stu's system prompt with explicit memory file instructions
2. ✅ Add memory read at conductor initialization
3. ✅ Add memory write after each significant learning event
4. ✅ Update memory service to back up /root/stu-memory.json specifically
5. ✅ Test with SMS: store preference, recall preference

### Later (Requires E2B template update)

1. Install claude-mem plugin in E2B template
2. Configure claude-mem in template
3. Test that ~/.claude-mem directory is created
4. Remove manual memory file approach
5. Switch to claude-mem plugin fully

## Files to Update

### 1. `src/conductor-cli/conductor-e2b.service.ts`
Add to system prompt:
- Memory file instructions
- When to read/write memory
- JSON format specification

### 2. `src/services/memory.service.ts`
Add function:
```typescript
export async function initializeMemoryFile(sandbox: Sandbox): Promise<void> {
  // Check if memory file exists
  const checkResult = await sandbox.commands.run('test -f /root/stu-memory.json && echo "exists" || echo "missing"');

  if (checkResult.stdout.trim() === 'missing') {
    // Create initial empty memory
    const initialMemory = {
      user_preferences: {},
      api_knowledge: {},
      task_history: []
    };
    await sandbox.files.write('/root/stu-memory.json', JSON.stringify(initialMemory, null, 2));
  }
}
```

## Success Criteria

Memory is working when:
- ✅ User tells Stu a preference, Stu remembers it next day
- ✅ Worker reports API knowledge, Stu includes NOTE in next spawn
- ✅ Stu references past conversations without being told
- ✅ Logs show "Memory imported" and "Memory exported" messages
- ✅ Redis contains memory data with correct key

## Current Status

**Memory backup/restore**: ✅ Working (Redis-based)
**claude-mem plugin**: ❓ Unknown, likely not installed
**Stu memory usage**: ❌ Not explicitly instructed
**Testing**: ❌ Not validated end-to-end

**Action needed**: Implement Option 2 (Manual Memory) immediately
