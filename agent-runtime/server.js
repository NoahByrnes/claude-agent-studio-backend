/**
 * HTTP server for Claude Agent Studio containers
 *
 * This server runs inside the container and:
 * 1. Receives prompt execution requests via HTTP
 * 2. Spawns detached agent processes that run in background
 * 3. Responds immediately with taskId
 * 4. Agent writes output to storage as it executes
 *
 * This architecture avoids Cloudflare Workers timeout issues
 * because the Worker gets an immediate response while the
 * agent continues running in the container.
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = process.env.PORT || 8080;

// Storage configuration (passed from Worker)
let storageConfig = null;

/**
 * Write to storage via REST API
 * Supports PostgreSQL (via API) or Cloudflare KV
 */
async function writeToStorage(key, value) {
  console.log(`[Container] writeToStorage called for key: ${key}`);

  if (!storageConfig) {
    console.error('[Container] ERROR: Storage config not set');
    return;
  }

  try {
    const { type, apiUrl, apiKey } = storageConfig;

    if (type === 'postgresql') {
      // Write to PostgreSQL via backend API
      const response = await fetch(`${apiUrl}/api/internal/logs`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          key,
          value,
          timestamp: new Date().toISOString()
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Container] Storage write FAILED for key ${key}:`, error);
      } else {
        console.log(`[Container] Storage write SUCCESS for key: ${key}`);
      }
    } else if (type === 'cloudflare-kv') {
      // Write to Cloudflare KV via REST API
      const { accountId, namespaceId, apiToken } = storageConfig;
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`;

      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'text/plain',
        },
        body: value
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Container] KV write FAILED for key ${key}:`, error);
      } else {
        console.log(`[Container] KV write SUCCESS for key: ${key}`);
      }
    }
  } catch (error) {
    console.error(`[Container] Storage write EXCEPTION for key ${key}:`, error.message);
  }
}

/**
 * Append to existing storage value
 */
async function appendToStorage(key, chunk) {
  if (!storageConfig) {
    console.error('[Container] Storage config not set');
    return;
  }

  try {
    const { type, apiUrl, apiKey } = storageConfig;

    if (type === 'postgresql') {
      // Append to PostgreSQL via backend API
      await fetch(`${apiUrl}/api/internal/logs/append`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          key,
          chunk,
          timestamp: new Date().toISOString()
        })
      });
    } else if (type === 'cloudflare-kv') {
      // For KV: Get current value, append, write back
      const { accountId, namespaceId, apiToken } = storageConfig;

      const getResponse = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`,
        { headers: { 'Authorization': `Bearer ${apiToken}` } }
      );

      let currentValue = '';
      if (getResponse.ok) {
        currentValue = await getResponse.text();
      }

      const newValue = currentValue + chunk;
      await writeToStorage(key, newValue);
    }
  } catch (error) {
    console.error(`[Container] Storage append error for key ${key}:`, error.message);
  }
}

/**
 * Run agent task in background and write output to storage
 */
function runAgentAsync(agentId, sessionId, prompt, customEnv) {
  console.log(`[Container] Starting async agent execution`);
  console.log(`[Container] Agent ID: ${agentId}`);
  console.log(`[Container] Session ID: ${sessionId}`);
  console.log(`[Container] Prompt: ${prompt}`);

  const startTime = Date.now();

  // Spawn detached process so it continues after response is sent
  const proc = spawn('npm', ['start', '--', prompt], {
    cwd: '/workspace/agent-runtime',
    env: {
      ...process.env,
      ...customEnv,
      FORCE_COLOR: '0',
      DEBUG: process.env.DEBUG || 'false',
    },
    detached: true,  // Run in background
    stdio: ['ignore', 'pipe', 'pipe']  // Capture stdout/stderr
  });

  console.log(`[Container] Background agent spawned with PID: ${proc.pid}`);

  let outputBuffer = '';
  let lastStorageWrite = Date.now();
  const STORAGE_WRITE_INTERVAL = 2000; // Write every 2 seconds

  // Capture stdout (JSON messages from agent)
  proc.stdout.on('data', async (data) => {
    const chunk = data.toString();
    outputBuffer += chunk;

    // Write to storage periodically
    const now = Date.now();
    if (now - lastStorageWrite >= STORAGE_WRITE_INTERVAL) {
      if (outputBuffer) {
        await appendToStorage(`agent:${agentId}:session:${sessionId}:output`, outputBuffer);
        outputBuffer = '';
        lastStorageWrite = now;
      }
    }
  });

  // Capture stderr (debug logs)
  let stderrBuffer = '';
  proc.stderr.on('data', (data) => {
    const chunk = data.toString();
    stderrBuffer += chunk;
    console.error(`[Agent stderr] ${chunk}`);
  });

  // Handle completion
  proc.on('close', async (code) => {
    const duration = Date.now() - startTime;
    console.log(`[Container] Agent completed in ${duration}ms with code ${code}`);

    // Write any remaining output
    if (outputBuffer) {
      await appendToStorage(`agent:${agentId}:session:${sessionId}:output`, outputBuffer);
    }

    // Write stderr if any
    if (stderrBuffer) {
      await appendToStorage(`agent:${agentId}:session:${sessionId}:stderr`, stderrBuffer);
    }

    // Write completion status
    await writeToStorage(
      `agent:${agentId}:session:${sessionId}:status`,
      code === 0 ? 'completed' : 'failed'
    );

    if (code !== 0) {
      await writeToStorage(
        `agent:${agentId}:session:${sessionId}:error`,
        `Process exited with code ${code}`
      );
    }
  });

  // Handle errors
  proc.on('error', async (err) => {
    console.error(`[Container] Agent error:`, err);
    await writeToStorage(`agent:${agentId}:session:${sessionId}:status`, 'error');
    await writeToStorage(`agent:${agentId}:session:${sessionId}:error`, err.message);
  });

  // Detach so process continues after parent exits
  proc.unref();
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // Health check endpoint
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      storageConfigured: storageConfig !== null,
      nodeVersion: process.version
    }));
    return;
  }

  // Agent execution endpoint
  if (req.method === 'POST' && req.url === '/execute') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const { agentId, sessionId, prompt, env, storage } = JSON.parse(body);

        if (!agentId || !sessionId || !prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'agentId, sessionId, and prompt are required'
          }));
          return;
        }

        // Store storage config if provided
        if (storage) {
          storageConfig = storage;
          console.log(`[Container] Storage config received: ${storage.type}`);
        }

        console.log(`[Container] Received execution request`);
        console.log(`[Container] Agent ID: ${agentId}`);
        console.log(`[Container] Session ID: ${sessionId}`);
        console.log(`[Container] Prompt: ${prompt.substring(0, 100)}...`);

        // Start agent in background
        runAgentAsync(agentId, sessionId, prompt, env || {});

        // Respond immediately
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          agentId,
          sessionId,
          status: 'started',
          message: 'Agent execution started in background'
        }));

      } catch (error) {
        console.error('[Container] Request parsing error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });

    return;
  }

  // 404 for other routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// CRITICAL: Bind to 0.0.0.0 (not localhost) for containers
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Container] HTTP server listening on 0.0.0.0:${PORT}`);
  console.log(`[Container] Health: http://0.0.0.0:${PORT}/health`);
  console.log(`[Container] Execute: POST http://0.0.0.0:${PORT}/execute`);
  console.log(`[Container] Node.js version: ${process.version}`);
});

// Handle shutdown gracefully
process.on('SIGTERM', () => {
  console.log('[Container] SIGTERM received, shutting down...');
  server.close(() => {
    console.log('[Container] Server closed');
    process.exit(0);
  });
});
