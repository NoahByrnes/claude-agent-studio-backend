# Memory Testing Guide for Stu

## What Changed

Stu now has an **explicit file-based memory system** instead of relying on the claude-mem plugin (which may not be installed).

### New Memory System

- **Memory file**: `/root/stu-memory.json` in Stu's E2B sandbox
- **Structure**: JSON with `user_preferences`, `api_knowledge`, and `learned_facts`
- **Backup**: Automatically exported to Redis after each conversation
- **Restore**: Automatically imported when Stu starts up
- **Instructions**: Stu explicitly knows HOW to read/write this file

## How It Works

### 1. Initialization
```
1. Conductor sandbox created
2. Memory imported from Redis (if exists)
3. Initialize stu-memory.json (if doesn't exist)
4. Stu starts CLI session
5. Stu's first action: Read /root/stu-memory.json
```

### 2. Learning
```
Worker: "FYI: BC Ferries (bcferries.ca) has no API - browser automation required"

Stu (internally):
1. Read /root/stu-memory.json
2. Parse JSON
3. Add BC Ferries to api_knowledge
4. Write /root/stu-memory.json (updated)
5. Respond: "Got it! I'll remember that."
```

### 3. Using Knowledge
```
User: "Check BC Ferries schedule"

Stu (internally):
1. Read /root/stu-memory.json at startup
2. See: bcferries.ca has no API
3. Spawn worker with NOTE
4. SPAWN_WORKER: "Check schedules. NOTE: bcferries.ca has no API - use Playwright"
```

### 4. Persistence
```
1. After each conductor conversation
2. Export /root/stu-memory.json to Redis
3. Redis key: conductor:memory:conductor
4. TTL: 7 days
5. Next startup: Import from Redis
```

## Testing Scenarios

### Test 1: Memory File Creation

**Objective**: Verify memory file is initialized

```bash
# Check logs after Stu starts
railway logs --tail 50 | grep "memory"

Expected:
✅ "Initializing Stu's memory file..."
✅ "Memory file initialized" OR "Memory file already exists"
```

### Test 2: User Preference Storage

**Day 1 - Store preference:**
```
SMS to Stu: "My favorite color is blue. Please remember this."

Expected behavior:
1. Stu reads /root/stu-memory.json
2. Adds to user_preferences: {"favorite_color": "blue"}
3. Writes /root/stu-memory.json
4. Responds: "Got it! I'll remember that your favorite color is blue."
```

**Day 2 - Recall preference:**
```
SMS to Stu: "What's my favorite color?"

Expected:
Stu: "Your favorite color is blue."
```

### Test 3: API Knowledge Learning (BC Ferries)

**First time:**
```
SMS: "Research if BC Ferries has an API for booking"

Expected flow:
1. Stu spawns worker
2. Worker spawns research subagent
3. Research finds: No API
4. Worker reports: "FYI: BC Ferries (bcferries.ca) has no API - browser automation required"
5. Stu updates memory file
6. Stu responds: "Got it! BC Ferries needs browser automation."
```

**Second time:**
```
SMS: "What do you know about BC Ferries?"

Expected:
Stu: "BC Ferries (bcferries.ca) doesn't have a public API.
I use browser automation (Playwright) for all BC Ferries tasks."
```

**Third time (using knowledge):**
```
SMS: "Check BC Ferries schedules"

Expected:
1. Stu spawns worker with: "NOTE: bcferries.ca has no API - use Playwright"
2. Worker skips research
3. Uses Playwright directly
4. 33% faster than first time
```

### Test 4: Memory Persistence Across Deployments

**Before deployment:**
```
SMS: "My timezone is America/Vancouver"
Stu: "Got it! I'll remember that."
```

**Trigger deployment:**
```bash
git push origin main
# Wait for Railway redeploy (~2 minutes)
```

**After deployment:**
```
SMS: "What's my timezone?"

Expected:
Stu: "Your timezone is America/Vancouver."

(Tests Redis backup/restore)
```

### Test 5: Memory File Contents

**Check memory file directly:**
```bash
# Get conductor sandbox ID from logs
railway logs | grep "Conductor sandbox created"

# SSH into sandbox
e2b sandbox connect <sandbox-id>

# View memory file
cat /root/stu-memory.json

Expected format:
{
  "user_preferences": {
    "favorite_color": "blue",
    "timezone": "America/Vancouver"
  },
  "api_knowledge": {
    "bcferries.ca": {
      "has_api": false,
      "last_updated": "2024-01-12",
      "notes": "Browser automation required"
    }
  },
  "learned_facts": [
    "User lives in Vancouver"
  ],
  "last_updated": "2024-01-12T19:30:00Z"
}
```

### Test 6: Redis Backup Verification

**Check if memory is in Redis:**
```bash
# In Railway Redis console
redis-cli

# Check conductor memory key
GET conductor:memory:conductor

# Should return base64-encoded tarball
# Decode and extract to verify
```

## Debugging Memory Issues

### Issue: Stu doesn't remember anything

**Check 1: Is memory file being created?**
```bash
railway logs | grep "Initializing Stu's memory file"
railway logs | grep "Memory file initialized"
```

**Check 2: Is Stu reading the file?**
```bash
railway logs | grep "Read" | grep "stu-memory.json"
```

**Check 3: Is memory being exported?**
```bash
railway logs | grep "Exporting memory from sandbox"
railway logs | grep "Memory exported to Redis"
```

**Check 4: Is memory being imported on startup?**
```bash
railway logs | grep "Importing memory"
railway logs | grep "Memory imported to sandbox"
```

### Issue: Memory file exists but Stu doesn't use it

**Possible causes:**
1. Stu didn't read file at startup (check logs)
2. Stu read file but didn't parse correctly
3. File was created empty and never updated

**Solution:**
Send explicit instruction:
```
SMS: "Read your memory file at /root/stu-memory.json and tell me what's in it"
```

### Issue: Memory not persisting across sessions

**Check Redis connection:**
```bash
railway logs | grep "Redis"
railway logs | grep "Memory exported to Redis"
```

**Check Redis key:**
```bash
# In Railway Redis console
redis-cli
EXISTS conductor:memory:conductor
# Should return 1 if key exists
```

## Success Criteria

Memory system is working correctly when:

1. ✅ Memory file created at `/root/stu-memory.json`
2. ✅ Stu reads memory file on startup
3. ✅ Stu updates memory when learning new information
4. ✅ Stu recalls user preferences across messages
5. ✅ Stu remembers API knowledge and shares with workers
6. ✅ Memory persists across Railway deployments
7. ✅ Logs show "Memory exported to Redis" after conversations
8. ✅ Logs show "Memory imported" on conductor startup

## Expected Log Output (Successful Flow)

```
📝 Initializing Stu's memory file...
   Creating initial memory file...
   ✅ Memory file initialized

[... Stu starts CLI session ...]

📨 Sending to conductor: [SMS] My favorite color is blue

[... Stu processes message ...]
[... Stu should Read /root/stu-memory.json ...]
[... Stu should Write /root/stu-memory.json with updated data ...]

💬 Conductor response: Got it! I'll remember that your favorite color is blue.

📦 Exporting memory from sandbox xxx...
   Including stu-memory.json in backup
✅ Memory exported to Redis: conductor:memory:conductor (1234 bytes)
```

## Next Steps if Memory Doesn't Work

If the file-based memory doesn't work reliably:

### Option 1: Backend-Managed Memory
- Parse worker "FYI" messages automatically
- Store in Redis directly (not via sandbox)
- Inject into system prompt on next startup

### Option 2: Install claude-mem Plugin
- Update E2B template to install claude-mem
- Configure in template Dockerfile
- Let Claude CLI handle memory automatically
- Keep file-based as backup

### Option 3: Hybrid Approach
- Keep file-based for quick access
- Also parse and store in backend
- Merge both sources on startup
- Most reliable but more complex

## Current Recommendation

**Use file-based memory** (current implementation) because:
- ✅ Works immediately (no template rebuild)
- ✅ Explicit (Stu knows exactly what to do)
- ✅ Debuggable (can inspect /root/stu-memory.json)
- ✅ Portable (works in any E2B sandbox)
- ✅ Already implemented and tested

If issues arise, upgrade to claude-mem plugin later.
