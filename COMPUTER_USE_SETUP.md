# Computer Use Setup for Workers

This guide explains how to enable computer use (browser automation, GUI interaction) for Claude workers in the Agent Studio system.

## Overview

Computer use allows workers to:
- Automate web browsers
- Interact with GUI applications
- Take screenshots for visual verification
- Handle legacy apps without APIs

**Cost**: ~$0.25 per task (1000-3000 tokens per screenshot)

**When to use**:
- Web automation/testing
- Legacy apps with no API
- Document creation requiring GUI
- After verifying no API exists (via research subagent)

## E2B Template Setup

### 1. Create Custom E2B Template

You need an E2B template with these components:
- **Ubuntu base** (already have this)
- **Claude CLI** (already installed)
- **Display server** (Xvfb for headless operation)
- **Mouse/keyboard tools** (xdotool)
- **Screenshot tool** (scrot)

### 2. Template Dockerfile

Create a custom E2B template with this Dockerfile:

```dockerfile
# Start from your existing template base
FROM e2b-template-base:latest

# Install display server and GUI tools
RUN apt-get update && apt-get install -y \
    xvfb \
    xdotool \
    scrot \
    x11vnc \
    fluxbox \
    && rm -rf /var/lib/apt/lists/*

# Set up virtual display
ENV DISPLAY=:99
ENV RESOLUTION=1024x768x24

# Create startup script for Xvfb
RUN echo '#!/bin/bash\n\
Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &\n\
sleep 1\n\
fluxbox > /dev/null 2>&1 &\n\
exec "$@"' > /usr/local/bin/start-display.sh \
    && chmod +x /usr/local/bin/start-display.sh

# Set entrypoint to start display server
ENTRYPOINT ["/usr/local/bin/start-display.sh"]
CMD ["/bin/bash"]
```

### 3. Build and Push Template

```bash
# Build the template
e2b template build

# This will create a new template ID
# Update E2B_TEMPLATE_ID in your .env file with the new ID
```

### 4. Update Environment Variables

Add to Railway environment variables:

```bash
E2B_TEMPLATE_ID=<your-new-template-id-with-computer-use>
ANTHROPIC_API_KEY=<your-api-key>
```

## Enabling Computer Use in Claude CLI

Computer use requires the beta API header. This is **automatically enabled** by Claude CLI when using computer use tools (no extra config needed).

The Claude CLI will:
1. Detect computer use tool requests
2. Add `anthropic-beta: computer-use-2024-10-22` header automatically
3. Handle screenshots and screen coordinates

## How Workers Use Computer Use

Workers are instructed to follow this pattern:

### 1. Research API First
```
Worker spawns research subagent:
Task tool: "Research if [Service] has an API for [action].
            Check official docs."
```

### 2. Decide Based on Findings
- ✅ **API exists** → Use it! (cheaper, faster, more reliable)
- ⚠️ **No API found** → Use computer use as fallback

### 3. Report Discovery to Conductor
```
Worker tells Stu:
"FYI: Stripe has /v1/customers API for user management -
no computer use needed for future Stripe tasks"
```

This enables **self-improvement**: The system learns about APIs over time and uses computer use less frequently.

## Self-Improving System Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Task: "Create a Stripe customer"                       │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│  Worker: Spawn research subagent                        │
│  "Does Stripe have an API for creating customers?"      │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
         ┌───────┴────────┐
         │                │
    API Found         No API Found
         │                │
         ▼                ▼
    Use Stripe API   Use Computer Use
    (Fast, cheap)    (Fallback)
         │                │
         └───────┬────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│  Worker reports to Stu:                                 │
│  "FYI: Stripe has POST /v1/customers API"              │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│  Stu remembers in persistent memory                     │
│  (Next Stripe task will use API directly)               │
└─────────────────────────────────────────────────────────┘
```

## Cost Analysis

### Computer Use Costs
- **Per screenshot**: ~1000-3000 tokens
- **Typical task**: 3-5 screenshots = 3,000-15,000 tokens
- **At Sonnet 4.5 rates**: ~$0.25 per typical task

### API Costs
- **Most API calls**: 0 additional tokens (just HTTP)
- **Response processing**: 100-500 tokens typically
- **At Sonnet 4.5 rates**: ~$0.001-0.005 per API call

**Savings**: Using APIs instead of computer use = 50-250x cost reduction

## Best Practices

### When to Use Computer Use
✅ Web automation and testing
✅ Legacy applications without APIs
✅ Document creation requiring visual layout
✅ One-off tasks where API research time > computer use cost
✅ After confirming no API exists

### When NOT to Use Computer Use
❌ High-frequency operations (too expensive)
❌ Real-time tasks (too slow - 5-10s per interaction)
❌ When APIs exist (much cheaper)
❌ Production workflows (APIs are more reliable)

### Optimization Strategy

1. **First time**: Research API existence
   - Worker spawns research subagent
   - Checks official documentation
   - Reports findings to Stu

2. **Subsequent times**: Use learned knowledge
   - Stu remembers API exists
   - Worker uses API directly
   - No computer use needed

3. **System improves over time**:
   - Week 1: 80% computer use, 20% API
   - Week 4: 30% computer use, 70% API
   - Week 12: 10% computer use, 90% API

## Testing Computer Use

### 1. Test E2B Template

```bash
# SSH into E2B sandbox
e2b sandbox connect <sandbox-id>

# Verify display server
echo $DISPLAY  # Should show :99

# Test screenshot
scrot test.png

# Test mouse/keyboard
xdotool mousemove 100 100
xdotool click 1
```

### 2. Test via SMS

Send a test message to Stu:
```
"Check if Tesla has an API for getting vehicle data.
If not, use computer use to visit their website."
```

Expected flow:
1. Worker spawns research subagent
2. Finds Tesla API exists: https://developer.tesla.com/docs/fleet-api
3. Reports: "FYI: Tesla has Fleet API for vehicle data"
4. Uses API instead of computer use
5. Stu remembers for next time

### 3. Test Fallback to Computer Use

Send a message requiring computer use:
```
"Screenshot the homepage of example.com and describe it"
```

Expected flow:
1. Worker spawns research subagent
2. No API for screenshots (correct)
3. Uses computer use as fallback
4. Takes screenshot with scrot
5. Analyzes and responds

## Monitoring

### Dashboard Visibility

Workers using computer use will show in:
- `/` - Dashboard (worker cards)
- `/worker/:id` - Live CLI output stream
- `/cli-feed` - Global feed with all activity

### Cost Tracking

Monitor Anthropic API usage:
```bash
# Check token usage in logs
railway logs | grep "total_cost"

# View in Anthropic Console
https://console.anthropic.com/settings/usage
```

## Troubleshooting

### Display Server Not Starting

**Error**: `cannot open display :99`

**Fix**:
```bash
# In E2B sandbox
Xvfb :99 -screen 0 1024x768x24 &
export DISPLAY=:99
```

### Screenshot Tool Missing

**Error**: `scrot: command not found`

**Fix**: Rebuild E2B template with scrot installed

### Computer Use Not Working

**Error**: `computer use tools not available`

**Check**:
1. E2B template has display server
2. Claude CLI version supports computer use
3. Anthropic API key has beta access
4. Beta header is included (automatic in CLI)

## Security Considerations

### E2B Sandbox Isolation
- Workers run in isolated E2B sandboxes
- No access to host system
- Automatic cleanup after 1 hour
- Full isolation between workers

### Safe for Autonomous Operation
- No persistent state between tasks
- Can't access other workers' data
- Conductor manages all worker lifecycle
- Safe to use computer use autonomously

## Future Enhancements

### Planned Features
- [ ] VNC streaming to dashboard (watch workers in real-time)
- [ ] Screenshot history in worker detail view
- [ ] Computer use cost tracking per worker
- [ ] API knowledge base UI for Stu's memory
- [ ] Automatic API documentation scraping

### Optimization Ideas
- Pre-load common APIs in Stu's initial memory
- Cache API research results in Redis
- Build API knowledge graph over time
- Share learned capabilities across conductor instances

## Summary

Computer use enables workers to handle any task, even without APIs. The self-improving pattern means:

1. **Week 1**: Workers research APIs, use computer use when needed
2. **Week 4**: Stu has learned many APIs, less computer use needed
3. **Week 12**: Highly efficient system using APIs for most tasks

The system gets smarter and cheaper over time automatically.

---

**Questions?** Check logs with `railway logs` or test in `/cli-feed` dashboard.
