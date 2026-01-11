/**
 * Conductor CLI Module
 *
 * CLI-based conductor/worker architecture using:
 * - claude -p (print mode) for non-interactive execution
 * - --resume <session-id> for stateful conversations
 * - --output-format json for structured responses
 *
 * This approach:
 * - Keeps sessions persistent across invocations
 * - No long-running process needed
 * - Each message = one CLI call with --resume
 * - Two sessions CAN message each other via session IDs
 *
 * Usage:
 * ```typescript
 * import { ConductorManager } from './conductor-cli';
 *
 * const conductor = new ConductorManager({
 *   workingDirectory: '/path/to/workspace',
 * }, {
 *   onSendEmail: async (to, subject, body) => {
 *     // Send email via your provider
 *   },
 * });
 *
 * // Initialize conductor session
 * await conductor.initConductor();
 *
 * // Send email to conductor
 * await conductor.sendToConductor({
 *   source: 'EMAIL',
 *   content: 'From: client@example.com\nSubject: Update pricing\n...',
 * });
 * ```
 */

export * from './types';
export { CLIExecutor, type ExecuteOptions } from './cli-executor';
export { ConductorManager, type ConductorManagerEvents } from './conductor-manager';
