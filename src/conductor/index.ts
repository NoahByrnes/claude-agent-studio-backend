/**
 * Conductor Module
 *
 * The Conductor/Worker architecture for autonomous agent orchestration.
 * This replaces human-in-the-loop with agent-in-the-loop validation.
 *
 * Usage:
 * ```typescript
 * import { createConductor, IncomingEvent } from './conductor';
 *
 * const conductor = createConductor();
 *
 * // Handle an incoming event (email, Slack, webhook, etc.)
 * const result = await conductor.handleEvent(event);
 * ```
 */

// Export types
export * from "./types";

// Export services
export { ConductorService } from "./conductor.service";
export { ValidationService } from "./validation.service";
export { WorkerManagerService } from "./worker-manager.service";
export { NotificationService } from "./notification.service";
export { OrchestrationStore } from "./orchestration-store";

// Factory function for easy setup
import { ConductorService } from "./conductor.service";
import { ValidationService } from "./validation.service";
import { WorkerManagerService } from "./worker-manager.service";
import { NotificationService } from "./notification.service";
import { OrchestrationStore } from "./orchestration-store";

export interface ConductorConfig {
  anthropicApiKey?: string;
  conductorUrl?: string;
  internalApiKey?: string;
  defaultFromEmail?: string;
  emailProvider?: any;
  slackProvider?: any;
}

/**
 * Create a fully configured Conductor instance.
 */
export function createConductor(config: ConductorConfig = {}): ConductorService {
  const workerManager = new WorkerManagerService(
    config.conductorUrl,
    config.internalApiKey
  );

  const validator = new ValidationService(config.anthropicApiKey);

  const notifier = new NotificationService({
    emailProvider: config.emailProvider,
    slackProvider: config.slackProvider,
    defaultFromEmail: config.defaultFromEmail,
  });

  const store = new OrchestrationStore();

  return new ConductorService(
    workerManager,
    validator,
    notifier,
    store,
    config.anthropicApiKey
  );
}
