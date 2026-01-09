# Claude Agent Studio - Backend

Backend API service for Claude Agent Studio.

## Tech Stack
- Fastify (API framework)
- Drizzle ORM + PostgreSQL
- BullMQ (job queue)
- Redis
- Supabase Auth

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
