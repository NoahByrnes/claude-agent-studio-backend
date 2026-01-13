# Example: BC Ferries Booking Flow

This document shows **exactly** how the self-improving system works with a real-world example: booking BC Ferries reservations.

## First Time - Learning Phase

### User Request (via SMS)
```
"Book a BC Ferries reservation from Tsawwassen to Swartz Bay for tomorrow at 3pm
using my BC Ferries account (username: user@example.com)"
```

### Stu's Response (Conductor)
```
SEND_SMS: +16041234567 | On it! Starting BC Ferries booking now. Will update you when complete.

SPAWN_WORKER: Book a BC Ferries reservation from Tsawwassen to Swartz Bay for tomorrow at 3pm.
Account credentials: username user@example.com (check if password needed).
Complete the full booking process and confirm reservation number.
```

### Worker's Actions

#### Step 1: Research API Availability
```
Worker spawns research subagent (Task tool):

Task: "Research if BC Ferries (bcferries.ca) has a public API for booking reservations.
       Check their official documentation, developer portal, and any available REST endpoints."
```

#### Step 2: Research Findings
```
Research subagent reports:
"No public API found. BC Ferries uses a web-based booking system at bcferries.com/reservations.
No developer documentation or API endpoints available."
```

#### Step 3: Worker Reports to Stu
```
Worker message to Stu:
"FYI: BC Ferries (bcferries.ca) has no public API - browser automation required for bookings"
```

#### Step 4: Stu Acknowledges and Remembers
```
Stu's internal thought:
"Got it! I'll remember that BC Ferries needs browser automation."

(This is automatically stored in ~/.claude-mem directory in Stu's sandbox,
which persists to Redis after the conversation)
```

#### Step 5: Worker Uses Playwright
```
Worker executes browser automation:

1. Launch Playwright browser
2. Navigate to bcferries.com
3. Click "Book a Reservation"
4. Log in with credentials
5. Select route: Tsawwassen → Swartz Bay
6. Select date: Tomorrow
7. Select departure: 3:00 PM
8. Select vehicle type (if needed)
9. Complete passenger details
10. Review and confirm booking
11. Capture confirmation number
```

#### Step 6: Worker Reports Completion
```
Worker message to Stu:
"Booking complete! Confirmation number: ABC123456.
Reservation for Tsawwassen → Swartz Bay, tomorrow at 3:00 PM.
Receipt sent to user@example.com."
```

#### Step 7: Stu Sends Results to User
```
SEND_SMS: +16041234567 | BC Ferries booking confirmed! Confirmation #ABC123456.
Tsawwassen → Swartz Bay tomorrow at 3pm. Receipt emailed to you.

KILL_WORKER: <worker-id>
```

### Cost Analysis - First Time
- Research subagent: ~$0.01
- Playwright automation: ~$0.25
- Worker overhead: ~$0.02
- **Total: ~$0.28**
- **Time: ~45 seconds**

---

## Second Time - Optimized with Knowledge

### User Request (via SMS)
```
"Cancel my BC Ferries booking #ABC123456"
```

### Stu's Response (With Prior Knowledge)
```
SEND_SMS: +16041234567 | On it! Canceling your BC Ferries reservation now.

SPAWN_WORKER: Cancel BC Ferries reservation #ABC123456.
NOTE: bcferries.ca has no API - use Playwright browser automation directly.
Log in to bcferries.com and navigate to "Manage Booking" to cancel.
```

### Worker's Actions (Optimized)

#### Step 1: No Research Needed
```
Worker sees NOTE in task:
"bcferries.ca has no API - use Playwright browser automation directly"

Worker skips research, proceeds immediately to browser automation.
```

#### Step 2: Worker Uses Playwright Directly
```
Worker executes browser automation:

1. Launch Playwright browser
2. Navigate to bcferries.com
3. Click "Manage Booking"
4. Enter confirmation #ABC123456
5. Click "Cancel Reservation"
6. Confirm cancellation
7. Capture cancellation confirmation
```

#### Step 3: Worker Reports Completion
```
Worker message to Stu:
"Cancellation complete! Booking #ABC123456 cancelled.
Refund confirmation sent to user@example.com."
```

#### Step 4: Stu Sends Results to User
```
SEND_SMS: +16041234567 | BC Ferries booking #ABC123456 cancelled.
Refund confirmation sent to your email.

KILL_WORKER: <worker-id>
```

### Cost Analysis - Second Time
- No research needed: $0
- Playwright automation: ~$0.25
- Worker overhead: ~$0.02
- **Total: ~$0.27**
- **Time: ~30 seconds (33% faster)**

### Savings
- **Cost**: 4% reduction (research eliminated)
- **Time**: 33% faster (no research delay)
- **Every future BC Ferries task benefits from this learned knowledge**

---

## Third Time - Different BC Ferries Task

### User Request
```
"What BC Ferries sailings are available from Horseshoe Bay to Nanaimo this weekend?"
```

### Stu's Response (Still Uses Learned Knowledge)
```
SEND_SMS: +16041234567 | Checking BC Ferries schedules now. One moment.

SPAWN_WORKER: Check BC Ferries schedule from Horseshoe Bay to Nanaimo for this weekend.
NOTE: bcferries.ca has no API - use Playwright browser automation directly.
Visit bcferries.com/schedules and gather sailing times for Saturday and Sunday.
```

### Key Point
**Stu's memory is domain-based**, not task-based:
- Learned: "bcferries.ca has no API"
- Applies to ALL BC Ferries tasks:
  - ✅ Bookings
  - ✅ Cancellations
  - ✅ Schedule checks
  - ✅ Account management
  - ✅ Any interaction with bcferries.ca

---

## Comparison: With API vs Without API

### Service WITH API (e.g., Stripe)

**First Time:**
```
Task: "Create Stripe customer"
→ Research: "Stripe has POST /v1/customers API"
→ Use API (cheap, fast)
→ Report: "FYI: Stripe has API"
Cost: $0.01, Time: 2 seconds
```

**Second Time:**
```
Task: "Update Stripe customer"
→ Stu provides: "NOTE: Stripe has API at api.stripe.com/v1"
→ Use API directly (no research)
Cost: $0.002, Time: 1 second
Savings: 80% cost reduction, 50% faster
```

### Service WITHOUT API (e.g., BC Ferries)

**First Time:**
```
Task: "Book BC Ferries"
→ Research: "No API found"
→ Use Playwright (expensive, slower)
→ Report: "FYI: No API - browser required"
Cost: $0.28, Time: 45 seconds
```

**Second Time:**
```
Task: "Cancel BC Ferries"
→ Stu provides: "NOTE: bcferries.ca has no API - use Playwright"
→ Use Playwright directly (no research)
Cost: $0.27, Time: 30 seconds
Savings: 4% cost, 33% faster (research eliminated)
```

---

## Memory Persistence Details

### How Knowledge is Stored

**Worker reports to Stu:**
```
"FYI: BC Ferries (bcferries.ca) has no public API - browser automation required"
```

**Stu's memory (via claude-mem plugin):**
- Automatically stored in conversation history
- Key information: "bcferries.ca → no API → browser automation"
- Persists in ~/.claude-mem directory
- Exported to Redis after conversation
- Available immediately in next conversation

**Redis Storage:**
- Key: `conductor:memory:<conductorId>`
- Value: Tarball of ~/.claude-mem (base64)
- TTL: 7 days
- Restored on conductor startup

### Memory Format
The claude-mem plugin handles formatting automatically. Stu's memory includes:
- Conversation history
- User preferences
- Learned API knowledge
- Past task outcomes
- Relationship context

Example internal representation (abstracted):
```
Memory snapshot:
- User prefers SMS for urgent updates
- BC Ferries (bcferries.ca): No API, use browser automation
- Stripe (stripe.com): Has API at api.stripe.com/v1
- Last interaction: 2 hours ago
- Active context: BC Ferries bookings
```

---

## System Intelligence Growth

### Week 1 (Cold Start)
```
Services encountered: 10
Known APIs: 2 (20%)
Computer use required: 8 tasks (80%)
Average task cost: $0.20
```

### Week 4 (Learning)
```
Services encountered: 40
Known APIs: 28 (70%)
Computer use required: 12 tasks (30%)
Average task cost: $0.08
60% cost reduction!
```

### Week 12 (Mature)
```
Services encountered: 100
Known APIs: 90 (90%)
Computer use required: 10 tasks (10%)
Average task cost: $0.03
85% cost reduction!
```

---

## Testing the BC Ferries Flow

### Test Message 1 (Learning)
```
SMS to Stu:
"Research if BC Ferries has an API for checking schedules"

Expected:
1. Worker spawns research subagent
2. Finds: No API
3. Reports: "FYI: BC Ferries has no API"
4. Stu confirms: "Got it!"
```

### Test Message 2 (Using Knowledge)
```
SMS to Stu:
"What time is the next ferry from Tsawwassen to Swartz Bay?"

Expected:
1. Stu spawns worker with NOTE
2. Worker skips research
3. Uses Playwright immediately
4. Returns schedule info
```

### Verification
Check if Stu remembers:
```
SMS to Stu:
"What do you know about BC Ferries?"

Expected:
"BC Ferries (bcferries.ca) doesn't have a public API.
I use browser automation for all BC Ferries tasks."
```

---

## Summary

This is **exactly** how the self-improving system works:

1. ✅ **User asks for BC Ferries task**
2. ✅ **Stu spawns worker**
3. ✅ **Worker spawns research subagent** (Task tool)
4. ✅ **Research finds: No API**
5. ✅ **Worker reports to Stu: "No API for bcferries.ca"**
6. ✅ **Stu stores in memory** (claude-mem → Redis)
7. ✅ **Worker uses Playwright** to complete task
8. ✅ **Worker reports completion**
9. ✅ **Next time: Stu includes NOTE in SPAWN_WORKER**
10. ✅ **Future workers skip research, use Playwright directly**

**Result**: System learns once, benefits forever. No manual configuration needed.
