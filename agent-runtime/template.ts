import { Template } from 'e2b'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * E2B Template Definition for Claude Agent Studio
 *
 * This template creates a full Ubuntu 22.04 environment with:
 * - Node.js 20
 * - Claude Agent SDK
 * - Playwright for browser automation
 * - HTTP server for async execution
 */

// Read Dockerfile content
const dockerfileContent = readFileSync(join(__dirname, 'Dockerfile'), 'utf-8')

// Create template from Dockerfile
export default Template()
  .fromDockerfile(dockerfileContent)
  .onStart({ cmd: 'node /workspace/server.js' })
  .cpuCount(2)
  .memoryMB(2048) // 2GB for browser automation
