import { Sandbox } from 'e2b';
import type { Agent } from '../../db/schema.js';
import { AgentService } from './agent.service.js';

export interface E2BSandboxDeployment {
  id: string;
  sandboxId: string;
  agentId: string;
  status: 'creating' | 'ready' | 'running' | 'stopped' | 'error';
  createdAt: Date;
  template: string;
}

interface SandboxInstance {
  sandbox: Sandbox;
  deployment: E2BSandboxDeployment;
}

/**
 * E2B Sandbox Service
 *
 * Manages agent deployment to E2B sandboxes.
 * Each sandbox runs the Claude Agent SDK in a full Ubuntu environment.
 */
export class E2BSandboxService {
  private agentService: AgentService;
  private sandboxes: Map<string, SandboxInstance> = new Map();
  private apiKey: string;
  private templateId: string;

  constructor() {
    this.agentService = new AgentService();

    // Get E2B configuration from environment
    this.apiKey = process.env.E2B_API_KEY || '';
    this.templateId = process.env.E2B_TEMPLATE_ID || '';

    if (!this.apiKey) {
      console.warn('⚠️  E2B_API_KEY not configured - sandbox deployment will fail');
    }
    if (!this.templateId) {
      console.warn('⚠️  E2B_TEMPLATE_ID not configured - sandbox deployment will fail');
    }
  }

  /**
   * Deploy agent to E2B sandbox
   */
  async deploy(agentId: string, userId: string): Promise<E2BSandboxDeployment> {
    const agent = await this.agentService.getById(agentId, userId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (!this.apiKey || !this.templateId) {
      throw new Error('E2B_API_KEY and E2B_TEMPLATE_ID must be configured');
    }

    console.log(`🚀 Deploying agent ${agentId} to E2B...`);
    console.log(`   Template: ${this.templateId}`);

    // Update agent status
    await this.agentService.updateStatus(agentId, userId, 'deploying');

    try {
      // Create E2B sandbox from template
      const sandbox = await Sandbox.create(this.templateId, {
        apiKey: this.apiKey,
        metadata: {
          agentId,
          userId,
          deployedAt: new Date().toISOString(),
        },
        // 30 minute timeout
        timeoutMs: 1800000,
        // 5 minute timeout for sandbox creation
        requestTimeoutMs: 300000,
      });

      console.log(`✅ E2B sandbox created: ${sandbox.sandboxId}`);

      // Wait for HTTP server to be ready (port 8080)
      console.log(`   Waiting for HTTP server on port 8080...`);
      await this.waitForPort(sandbox, 8080, 30000);

      const deployment: E2BSandboxDeployment = {
        id: `e2b-${agentId}`,
        sandboxId: sandbox.sandboxId,
        agentId,
        status: 'ready',
        createdAt: new Date(),
        template: this.templateId,
      };

      this.sandboxes.set(agentId, { sandbox, deployment });

      await this.agentService.updateStatus(agentId, userId, 'running');

      console.log(`✅ Agent ${agentId} deployed successfully`);
      console.log(`   Sandbox ID: ${sandbox.sandboxId}`);
      console.log(`   HTTP endpoint: http://${sandbox.getHost(8080)}`);

      return deployment;
    } catch (error: any) {
      console.error(`❌ Deployment failed for agent ${agentId}:`, error.message);
      await this.agentService.updateStatus(agentId, userId, 'stopped');
      throw new Error(`E2B deployment failed: ${error.message}`);
    }
  }

  /**
   * Wait for a port to be ready
   */
  private async waitForPort(
    sandbox: Sandbox,
    port: number,
    timeoutMs: number = 30000
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Try to connect to the port using curl
        const result = await sandbox.commands.run(`curl -f http://localhost:${port}/health || exit 1`);

        if (result.exitCode === 0) {
          console.log(`   ✅ Port ${port} is ready`);
          return;
        }
      } catch (error) {
        // Port not ready yet, wait and retry
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error(`Timeout waiting for port ${port} to be ready`);
  }

  /**
   * Execute prompt in agent sandbox
   */
  async execute(
    agentId: string,
    sessionId: string,
    prompt: string,
    env?: Record<string, string>
  ): Promise<{ sessionId: string; status: string }> {
    const instance = this.sandboxes.get(agentId);
    if (!instance) {
      throw new Error(`No sandbox found for agent ${agentId}. Deploy first.`);
    }

    const { sandbox, deployment } = instance;

    console.log(`🤖 Executing prompt in agent ${agentId}...`);
    console.log(`   Sandbox: ${sandbox.sandboxId}`);
    console.log(`   Session: ${sessionId}`);
    console.log(`   Prompt: ${prompt.substring(0, 100)}...`);

    try {
      deployment.status = 'running';

      // Send HTTP request to container's /execute endpoint
      const response = await sandbox.commands.run(`curl -X POST http://localhost:8080/execute \\
          -H "Content-Type: application/json" \\
          -d '${JSON.stringify({
            agentId,
            sessionId,
            prompt,
            env: {
              ...env,
              BACKEND_API_URL: process.env.BACKEND_API_URL,
              INTERNAL_API_KEY: process.env.INTERNAL_API_KEY,
            }
          }).replace(/'/g, "'\"'\"'")}'`);

      if (response.exitCode !== 0) {
        throw new Error(`HTTP request failed: ${response.stderr}`);
      }

      console.log(`✅ Prompt execution started`);
      console.log(`   Response: ${response.stdout.substring(0, 200)}`);

      return {
        sessionId,
        status: 'started',
      };
    } catch (error: any) {
      console.error(`❌ Execution failed:`, error.message);
      deployment.status = 'error';
      throw new Error(`Execution failed: ${error.message}`);
    }
  }

  /**
   * Stop and cleanup sandbox
   */
  async stop(agentId: string, userId: string): Promise<void> {
    const instance = this.sandboxes.get(agentId);

    if (instance) {
      console.log(`🛑 Stopping sandbox for agent ${agentId}...`);

      try {
        await Sandbox.kill(instance.sandbox.sandboxId);
        console.log(`   ✅ Sandbox ${instance.sandbox.sandboxId} closed`);
      } catch (error: any) {
        console.error(`   ⚠️  Error closing sandbox:`, error.message);
      }

      this.sandboxes.delete(agentId);
    }

    await this.agentService.updateStatus(agentId, userId, 'stopped');
    console.log(`✅ Agent ${agentId} stopped`);
  }

  /**
   * Get deployment info
   */
  async getDeployment(agentId: string): Promise<E2BSandboxDeployment | undefined> {
    const instance = this.sandboxes.get(agentId);
    return instance?.deployment;
  }

  /**
   * Get all deployments
   */
  async getAllDeployments(): Promise<E2BSandboxDeployment[]> {
    return Array.from(this.sandboxes.values()).map(i => i.deployment);
  }

  /**
   * Upload files to sandbox
   */
  async uploadFiles(
    agentId: string,
    files: { path: string; content: string }[]
  ): Promise<void> {
    const instance = this.sandboxes.get(agentId);
    if (!instance) {
      throw new Error(`No sandbox found for agent ${agentId}`);
    }

    console.log(`📁 Uploading ${files.length} files to sandbox ${agentId}...`);

    for (const file of files) {
      try {
        await instance.sandbox.files.write(file.path, file.content);
        console.log(`   ✅ Uploaded: ${file.path}`);
      } catch (error: any) {
        console.error(`   ❌ Failed to upload ${file.path}:`, error.message);
        throw error;
      }
    }

    console.log(`✅ All files uploaded successfully`);
  }

  /**
   * Install npm packages in sandbox
   */
  async installPackages(agentId: string, packages: string[]): Promise<void> {
    const instance = this.sandboxes.get(agentId);
    if (!instance) {
      throw new Error(`No sandbox found for agent ${agentId}`);
    }

    console.log(`📦 Installing packages in sandbox ${agentId}: ${packages.join(', ')}`);

    try {
      const result = await instance.sandbox.commands.run(`cd /workspace/agent-runtime && npm install ${packages.join(' ')}`);

      if (result.exitCode !== 0) {
        throw new Error(`npm install failed: ${result.stderr}`);
      }

      console.log(`✅ Packages installed successfully`);
      console.log(result.stdout);
    } catch (error: any) {
      console.error(`❌ Package installation failed:`, error.message);
      throw error;
    }
  }

  /**
   * Execute command in sandbox
   */
  async exec(
    agentId: string,
    command: string,
    options?: { timeout?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const instance = this.sandboxes.get(agentId);
    if (!instance) {
      throw new Error(`No sandbox found for agent ${agentId}`);
    }

    console.log(`⚙️  Executing command in sandbox ${agentId}: ${command}`);

    try {
      const result = await instance.sandbox.commands.run(command);

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
      };
    } catch (error: any) {
      console.error(`❌ Command execution failed:`, error.message);
      throw error;
    }
  }
}
