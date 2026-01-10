# E2B Build System V2 - Setup Guide

This directory contains the E2B v2 template definition for Claude Agent Studio. The v2 build system uses SDK-based template definitions instead of the deprecated v1 system.

## Prerequisites

1. **E2B CLI** - Already installed globally
   ```bash
   npm install -g @e2b/cli
   ```

2. **Authentication** - You must authenticate with E2B before building:
   ```bash
   e2b auth login
   ```

   Or set an access token:
   ```bash
   export E2B_ACCESS_TOKEN=your-token-here
   ```
   Get your access token from: https://e2b.dev/dashboard?tab=personal

## Building the Template

### Development Build

```bash
cd agent-runtime
npm install  # Install dependencies including 'e2b' package
npm run build:dev
```

This will:
- Build the template from Dockerfile
- Create a new E2B sandbox template
- Output the template ID for your `.env` file

### Production Build

```bash
cd agent-runtime
npm run build:prod
```

Production builds use `--no-cache` for clean builds.

## Template Files

### `template.ts`
Main template definition using E2B SDK v2:
- Builds from `Dockerfile` using `fromDockerfile()`
- Sets start command: `node /workspace/server.js`
- Configures resources: 2 CPUs, 2GB RAM

### `build.dev.ts` / `build.prod.ts`
Build scripts that execute the template build and output the template ID.

### `Dockerfile`
Standard Dockerfile with:
- Ubuntu 22.04 base
- Node.js 20
- Claude Agent SDK
- Playwright for browser automation
- HTTP server for async execution

### `.e2bignore`
Excludes unnecessary files from template build (node_modules, logs, etc.)

## After Building

1. Copy the template ID from the build output
2. Add to your backend `.env` file:
   ```bash
   E2B_TEMPLATE_ID=your-template-id-here
   E2B_API_KEY=your-api-key-here
   ```

3. Deploy to Railway with environment variables:
   - `E2B_API_KEY` - Your E2B API key
   - `E2B_TEMPLATE_ID` - Template ID from build
   - `BACKEND_API_URL` - Your Railway backend URL
   - `INTERNAL_API_KEY` - Secure random key for container auth

## Template Architecture

```
E2B Container (Ubuntu 22.04)
├── Node.js 20
├── Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
├── Playwright (browser automation)
└── HTTP Server (port 8080)
    ├── POST /execute - Run agent with prompt
    ├── POST /upload - Upload files
    ├── POST /install - Install npm packages
    └── POST /health - Health check
```

## Migration from V1

The v1 build system (using `e2b template build` command) is deprecated. This template uses v2:
- ✅ SDK-based template definition
- ✅ Programmatic configuration
- ✅ TypeScript type safety
- ✅ Better error handling

## Resources

- [E2B Build System 2.0](https://e2b.dev/blog/introducing-build-system-2-0)
- [Migration Guide](https://e2b.dev/docs/template/migration-v2)
- [SDK Reference](https://e2b.dev/docs/sdk-reference/cli/v2.2.10/template)

## Troubleshooting

**"You must be logged in"**
- Run `e2b auth login` or set `E2B_ACCESS_TOKEN`

**"Module not found: e2b"**
- Run `npm install` in agent-runtime directory

**"Failed to parse Dockerfile"**
- Ensure Dockerfile uses supported instructions: FROM, RUN, COPY, ADD, WORKDIR, USER, ENV, ARG, CMD, ENTRYPOINT
- Our Dockerfile is compatible with E2B v2

**Template build is slow**
- First build takes longer (pulling Ubuntu base image, installing Node.js, etc.)
- Subsequent builds use layer caching
- Production builds with `--no-cache` are intentionally clean builds

## Cost Estimation

E2B charges $0.00015/second (~$0.27/hour) for running sandboxes:
- Template build: One-time operation, minimal cost
- Running sandboxes: Charged per second of uptime
- Auto-cleanup: Sandboxes timeout after 30 minutes by default

The E2BSandboxService automatically manages sandbox lifecycle to minimize costs.
