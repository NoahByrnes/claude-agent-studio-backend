/**
 * Conductor VM Module
 *
 * CLI-based conductor/worker architecture where:
 * - Conductor is an agent running in its own E2B VM
 * - Messages are injected into conductor's CLI
 * - Conductor spawns worker VMs for tasks
 * - Workers report back via CLI output
 *
 * Usage:
 * ```typescript
 * import { VMManager, MessageFormatter } from './conductor-vm';
 *
 * const manager = new VMManager({
 *   e2bApiKey: process.env.E2B_API_KEY!,
 *   conductorTemplateId: process.env.E2B_CONDUCTOR_TEMPLATE!,
 *   workerTemplateId: process.env.E2B_WORKER_TEMPLATE!,
 *   anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
 * }, {
 *   onEmailSend: async (to, subject, body) => {
 *     // Send email via your provider
 *   },
 * });
 *
 * await manager.startConductor();
 *
 * // Inject email webhook
 * await manager.injectMessage(
 *   MessageFormatter.createEmailMessage({
 *     from: 'client@example.com',
 *     to: 'agent@yourdomain.com',
 *     subject: 'Please update pricing',
 *     body: 'Change Basic to $29...',
 *   })
 * );
 * ```
 */

export * from './types';
export { MessageFormatter } from './message-formatter';
export { CommandParser } from './command-parser';
export { VMManager, type VMManagerEvents } from './vm-manager';
