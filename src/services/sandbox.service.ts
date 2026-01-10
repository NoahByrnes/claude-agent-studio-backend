import type { Agent } from '../../db/schema.js';
import { AgentService } from './agent.service.js';
// DEPRECATED: Replaced with container-based execution
// import { AgentExecutorService } from './agent-executor.service.js';

export interface SandboxDeployment {
  id: string;
  agentId: string;
  url?: string;
  status: 'deploying' | 'running' | 'stopped' | 'error';
  sandbox: 'cloudflare' | 'e2b' | 'local';
}

export class SandboxService {
  private agentService: AgentService;
  // DEPRECATED: Replaced with container-based execution
  // private executorService: AgentExecutorService;
  private deployments: Map<string, SandboxDeployment>;
  private runningAgents: Map<string, NodeJS.Timeout>;

  constructor() {
    this.agentService = new AgentService();
    // DEPRECATED: Replaced with container-based execution
    // this.executorService = new AgentExecutorService();
    this.deployments = new Map();
    this.runningAgents = new Map();
  }

  async deploy(agentId: string, userId: string): Promise<SandboxDeployment> {
    const agent = await this.agentService.getById(agentId, userId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const config = agent.config as any;
    const deploymentConfig = config.deployment;

    // Update agent status to deploying
    await this.agentService.updateStatus(agentId, userId, 'deploying');

    const deployment: SandboxDeployment = {
      id: `deployment-${agentId}`,
      agentId,
      status: 'deploying',
      sandbox: deploymentConfig.sandbox,
    };

    this.deployments.set(agentId, deployment);

    try {
      // Deploy based on sandbox type
      switch (deploymentConfig.sandbox) {
        case 'cloudflare':
          await this.deployToCloudflare(agent, deployment);
          break;
        case 'e2b':
          await this.deployToE2B(agent, deployment);
          break;
        case 'local':
          await this.deployLocally(agent, deployment);
          break;
        default:
          throw new Error(`Unsupported sandbox type: ${deploymentConfig.sandbox}`);
      }

      deployment.status = 'running';
      await this.agentService.updateStatus(agentId, userId, 'running');

      console.log(`✅ Agent ${agentId} deployed successfully to ${deploymentConfig.sandbox}`);
    } catch (error: any) {
      deployment.status = 'error';
      await this.agentService.updateStatus(agentId, userId, 'error');
      console.error(`❌ Failed to deploy agent ${agentId}:`, error);
      throw error;
    }

    return deployment;
  }

  async stop(agentId: string, userId: string): Promise<void> {
    const deployment = this.deployments.get(agentId);
    if (!deployment) {
      throw new Error(`No deployment found for agent ${agentId}`);
    }

    // Stop the running agent if it's local
    const interval = this.runningAgents.get(agentId);
    if (interval) {
      clearInterval(interval);
      this.runningAgents.delete(agentId);
    }

    // For Cloudflare/E2B, we would make API calls here to stop the workers
    // TODO: Implement actual sandbox termination for cloud providers

    deployment.status = 'stopped';
    await this.agentService.updateStatus(agentId, userId, 'stopped');
    this.deployments.delete(agentId);

    console.log(`🛑 Agent ${agentId} stopped successfully`);
  }

  async getDeployment(agentId: string): Promise<SandboxDeployment | undefined> {
    return this.deployments.get(agentId);
  }

  async getAllDeployments(): Promise<SandboxDeployment[]> {
    return Array.from(this.deployments.values());
  }

  private async deployToCloudflare(
    agent: Agent,
    deployment: SandboxDeployment
  ): Promise<void> {
    // TODO: Implement Cloudflare Workers deployment
    // This would involve:
    // 1. Bundling the agent code
    // 2. Using Cloudflare Workers API to deploy
    // 3. Setting up Durable Objects for state management
    // 4. Configuring cron triggers for scheduled execution

    console.log(`📦 Deploying to Cloudflare Workers (stub implementation)`);

    // For now, just simulate deployment
    await new Promise(resolve => setTimeout(resolve, 1000));

    deployment.url = `https://agent-${agent.id}.workers.dev`;
  }

  private async deployToE2B(agent: Agent, deployment: SandboxDeployment): Promise<void> {
    // TODO: Implement E2B sandbox deployment
    // This would involve:
    // 1. Using E2B SDK to create a sandbox
    // 2. Installing dependencies
    // 3. Running the agent code in the sandbox
    // 4. Setting up webhook listeners for events

    console.log(`📦 Deploying to E2B sandbox (stub implementation)`);

    // For now, just simulate deployment
    await new Promise(resolve => setTimeout(resolve, 1000));

    deployment.url = `https://e2b.dev/sandbox/${agent.id}`;
  }

  private async deployLocally(agent: Agent, deployment: SandboxDeployment): Promise<void> {
    const config = agent.config as any;
    const deploymentType = config.deployment.type;

    console.log(`🏠 Deploying locally as ${deploymentType} agent`);

    if (deploymentType === 'long-running') {
      // For long-running agents, start a background process that executes periodically
      const sessionId = `${agent.id}-long-running`;

      // Execute immediately
      this.executeAgentLocally(agent, sessionId).catch(err => {
        console.error(`Error in initial execution for agent ${agent.id}:`, err);
      });

      // Then execute every 5 minutes
      const interval = setInterval(() => {
        this.executeAgentLocally(agent, sessionId).catch(err => {
          console.error(`Error in scheduled execution for agent ${agent.id}:`, err);
        });
      }, 5 * 60 * 1000); // 5 minutes

      this.runningAgents.set(agent.id, interval);

      deployment.url = `local://agent-${agent.id}`;
    } else {
      // Event-driven agents don't need a background process
      // They're executed when events come in via the queue
      deployment.url = `local://event-driven/${agent.id}`;
    }
  }

  private async executeAgentLocally(agent: Agent, sessionId: string): Promise<void> {
    console.log(`🤖 Executing agent ${agent.id} (${agent.name})`);

    // TODO: Replace with container-based execution
    console.log(`⚠️  Container-based execution not yet implemented`);
    console.log(`   Agent will be deployed to E2B/Cloudflare containers in Phase 2`);

    /* DEPRECATED - Old custom agentic framework approach
    try {
      const result = await this.executorService.execute({
        agent,
        sessionId,
      });

      if (result.success) {
        console.log(`✅ Agent ${agent.id} execution completed`);
        console.log(`   Output: ${result.output}`);
        console.log(`   Tools used: ${result.toolsUsed?.join(', ') || 'none'}`);
      } else {
        console.error(`❌ Agent ${agent.id} execution failed: ${result.error}`);
      }
    } catch (error: any) {
      console.error(`❌ Error executing agent ${agent.id}:`, error);
    }
    */
  }
}
