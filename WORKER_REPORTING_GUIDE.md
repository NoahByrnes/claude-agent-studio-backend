# Worker Reporting Guide

Quick reference for how workers should report API/capability discoveries to Stu.

## Reporting Format

### When API Found
```
Format: "FYI: [Service Name] has [API details] for [task type] - no computer use needed"

Examples:
✓ "FYI: Stripe has POST /v1/customers API for user management - no computer use needed"
✓ "FYI: Twilio has REST API at api.twilio.com/2010-04-01 for SMS - no computer use needed"
✓ "FYI: GitHub has /repos/{owner}/{repo}/issues endpoint for issue creation - no computer use needed"
```

### When No API Found
```
Format: "FYI: [Service Name] ([domain]) has no public API - browser automation required"

Examples:
✓ "FYI: BC Ferries (bcferries.ca) has no public API - browser automation required"
✓ "FYI: Local Credit Union (mycu.com) has no public API - browser automation required"
✓ "FYI: Restaurant Booking System (opentable.ca) has no public API - browser automation required"
```

### When API Exists But Authentication Blocked
```
Format: "FYI: [Service] has API but requires [auth type] - browser automation may be easier"

Examples:
✓ "FYI: SomeService has API but requires OAuth2 flow - browser automation may be easier for one-time tasks"
✓ "FYI: Platform X has API but requires API key from admin dashboard - browser automation used this time"
```

## Why This Format Matters

### Domain Inclusion is Critical
Always include the domain name when reporting "no API":
```
✓ "BC Ferries (bcferries.ca) has no public API"
✗ "BC Ferries has no public API" (missing domain)
```

Why? Stu needs the domain to match future tasks to stored knowledge.

### Service Name Consistency
Use the same service name the user uses:
```
User says: "Book a BC Ferries reservation"
Report as: "BC Ferries (bcferries.ca)" ✓
Not: "British Columbia Ferry Services" ✗
```

### Specificity Helps
The more specific, the better Stu can guide future workers:
```
Good: "Stripe has POST /v1/customers API"
Better: "Stripe has POST /v1/customers API at api.stripe.com/v1"
```

## Stu's Response Examples

### When Learning New Knowledge
```
Worker: "FYI: BC Ferries (bcferries.ca) has no public API - browser automation required"
Stu: "Got it! I'll remember that BC Ferries needs browser automation."
```

### When Confirming API Discovery
```
Worker: "FYI: Stripe has /v1/customers API for user management - no computer use needed"
Stu: "Thanks! I'll remember that for future Stripe tasks."
```

### When Knowledge Already Known
```
Worker: "FYI: GitHub has REST API"
Stu: "Yep, I knew that already, but good to confirm!"
```

## How Stu Uses This Knowledge

### Next Time User Asks for Same Service

**Scenario 1: API Exists**
```
User: "Create another Stripe customer"

Stu spawns worker:
"SPAWN_WORKER: Create Stripe customer with email test@example.com.
NOTE: Stripe has REST API at api.stripe.com/v1 - use that instead of browser automation."

Worker sees NOTE → Uses API directly → Skips research
```

**Scenario 2: No API**
```
User: "Check my BC Ferries booking status"

Stu spawns worker:
"SPAWN_WORKER: Check BC Ferries booking status for reservation #ABC123.
NOTE: bcferries.ca has no API - use Playwright browser automation directly."

Worker sees NOTE → Uses Playwright directly → Skips research
```

## Research Subagent Pattern

### How to Research APIs

```python
# Worker spawns research subagent using Task tool
Task(
    subagent_type="general-purpose",
    prompt="""Research if [Service Name] has a public API for [specific action].

Steps:
1. Check official website developer section
2. Search for "[Service] API documentation"
3. Look for REST endpoints, GraphQL, or SDK
4. Note authentication requirements
5. Confirm if public API exists or if it's private/internal only

Report: API status, endpoints found (if any), authentication method."""
)
```

### What Research Should Find

**Positive Finding:**
- API exists: ✅
- Endpoint: `/v1/customers`
- Base URL: `api.service.com`
- Auth: API key in header
- Documentation: `service.com/docs/api`

**Negative Finding:**
- API exists: ❌
- Only web interface available
- Checked: developer section, documentation, search results
- Conclusion: Browser automation required

## Common Mistakes to Avoid

### ❌ Don't Report Generic Findings
```
❌ "No API found"
✓ "BC Ferries (bcferries.ca) has no public API - browser automation required"
```

### ❌ Don't Skip Domain Names
```
❌ "Service X has no API"
✓ "Service X (servicex.com) has no API - browser automation required"
```

### ❌ Don't Report Internal/Private APIs as Available
```
❌ "API exists but requires enterprise license"
✓ "API exists but private - browser automation used for this task"
```

### ❌ Don't Over-Specify When Not Needed
```
❌ "API found with 47 endpoints, OAuth2 flow, rate limits..."
✓ "Service has REST API at api.service.com - no computer use needed"
```

## Edge Cases

### API Requires Complex Setup
```
Report: "FYI: Service has API but requires OAuth2 flow - browser automation may be easier for one-time tasks"
Stu's response: "Got it. I'll decide case-by-case based on task frequency."
```

### API Documentation Found But Deprecated
```
Report: "FYI: Service (service.com) has deprecated API, new web-only interface - browser automation required"
Stu's response: "Thanks! I'll use browser automation for Service tasks."
```

### Multiple API Versions
```
Report: "FYI: Service has REST API v2 at api.service.com/v2 (v1 deprecated) - no computer use needed"
Stu's response: "Got it! I'll tell future workers to use v2."
```

## Summary

**Golden Rule:** Always report what you find, whether API exists or not.

**Format to remember:**
- API found: `"FYI: [Service] has [endpoint] for [task] - no computer use needed"`
- No API: `"FYI: [Service] ([domain]) has no public API - browser automation required"`

**Why it matters:**
- First worker does research → reports findings
- Stu stores in memory → persists to Redis
- Future workers skip research → 33-80% faster
- System learns once, benefits forever
