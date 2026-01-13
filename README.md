# Claude Agent Studio - Backend

Backend API service for Claude Agent Studio - an autonomous AI agent system with conductor-worker architecture.

## What's New 🎉

### Stu - Your Persistent Conductor
Meet **Stu**, the conductor agent with:
- **Persistent memory** across sessions (Redis-backed)
- **Self-improving intelligence** that learns APIs over time
- **Human-like worker management** (checks in, mentors, makes decisions)

### Computer Use for Workers
Workers can now:
- Automate browsers and GUI applications
- Fall back to visual interaction when APIs don't exist
- Research API availability first (self-optimization pattern)
- Report discoveries back to Stu for future efficiency

See [COMPUTER_USE_SETUP.md](./COMPUTER_USE_SETUP.md) for setup guide.

### Self-Improving System
The system gets smarter and cheaper over time:
- Workers research APIs before using computer use
- Discoveries are reported to Stu and remembered
- Future tasks use APIs instead of expensive computer use
- 50-250x cost reduction as knowledge accumulates

## Architecture

### Conductor-Worker Pattern
- **1 Conductor** (Stu): Persistent orchestrator managing all tasks
- **N Workers**: Ephemeral agents spawned for specific tasks
- All run Claude CLI inside isolated E2B sandboxes

### Tech Stack
- Fastify (API framework)
- Drizzle ORM + PostgreSQL (Supabase)
- Redis (memory persistence)
- E2B (sandbox runtime)
- Claude CLI (agent execution)
- SendGrid (email) + Twilio (SMS)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set environment variables (copy from .env.example)

3. Run migrations:
```bash
npm run db:migrate
```

4. Start:
```bash
npm run dev
```

## Deployment

Deploys to Railway with automatic builds from main branch.
