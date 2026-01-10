/**
 * Validation Service
 *
 * The core innovation of the Conductor architecture - this service replaces
 * human judgment by using Claude to validate whether worker output satisfies
 * the original request.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  Task,
  WorkerResult,
  ValidationResult,
  ValidationStatus,
  ValidationIssue,
  RetryStrategy,
  IncomingEvent,
} from "./types";

export class ValidationService {
  private anthropic: Anthropic;

  constructor(anthropicApiKey?: string) {
    this.anthropic = new Anthropic({
      apiKey: anthropicApiKey || process.env.ANTHROPIC_API_KEY,
    });
  }

  /**
   * Validate whether a worker's result satisfies the original task.
   */
  async validate(task: Task, result: WorkerResult): Promise<ValidationResult> {
    // Step 1: Basic sanity checks
    const sanityCheck = this.runSanityChecks(result);
    if (sanityCheck) {
      return sanityCheck;
    }

    // Step 2: AI-powered deep validation
    const deepValidation = await this.deepValidate(task, result);

    // Step 3: Determine retry strategy if needed
    if (deepValidation.status !== "valid") {
      deepValidation.retryStrategy = await this.determineRetryStrategy(
        task,
        result,
        deepValidation
      );
    }

    return deepValidation;
  }

  /**
   * Quick sanity checks before AI validation.
   */
  private runSanityChecks(result: WorkerResult): ValidationResult | null {
    const issues: ValidationIssue[] = [];

    // Check if worker reported success but has no output
    if (result.success && !result.summary && result.artifacts.length === 0) {
      issues.push({
        severity: "error",
        description: "Worker reported success but produced no output or artifacts",
      });
    }

    // Check if worker failed
    if (!result.success) {
      issues.push({
        severity: "error",
        description: `Worker reported failure: ${result.summary}`,
      });
    }

    // Check for error patterns in summary
    const errorPatterns = [
      /error:/i,
      /failed to/i,
      /could not/i,
      /unable to/i,
      /exception/i,
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(result.summary)) {
        issues.push({
          severity: "warning",
          description: `Summary contains error language: "${result.summary.substring(0, 100)}"`,
        });
      }
    }

    // If we have critical issues, fail fast
    if (issues.some((i) => i.severity === "error")) {
      return {
        status: "invalid",
        confidence: 0.9,
        issues,
        suggestion: "Worker did not complete successfully. Retry needed.",
      };
    }

    return null; // Continue to deep validation
  }

  /**
   * Use Claude to deeply validate the result against the task.
   */
  private async deepValidate(
    task: Task,
    result: WorkerResult
  ): Promise<ValidationResult> {
    const prompt = this.buildValidationPrompt(task, result);

    const response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    return this.parseValidationResponse(text);
  }

  private buildValidationPrompt(task: Task, result: WorkerResult): string {
    const originalEvent = task.context.originalEvent;

    return `You are a meticulous quality assurance agent. Your job is to validate whether a worker agent successfully completed a task.

## ORIGINAL REQUEST
${this.formatOriginalEvent(originalEvent)}

## TASK GIVEN TO WORKER
${task.description}

Instructions:
${task.instructions}

## WORKER'S RESULT
Success Reported: ${result.success}

Summary:
${result.summary}

${result.detailedReport ? `Detailed Report:\n${result.detailedReport}` : ""}

Actions Taken:
${result.actions.map((a) => `- ${a.action} on ${a.target}: ${a.result}`).join("\n") || "None recorded"}

Artifacts Produced:
${result.artifacts.map((a) => `- ${a.type}: ${a.name} - ${a.description || "No description"}`).join("\n") || "None"}

${result.validationHints ? `Worker's Validation Hints:\n${result.validationHints.howToVerify}\nExpected Outcome: ${result.validationHints.expectedOutcome}` : ""}

## YOUR VALIDATION TASK
Carefully analyze whether the worker's output satisfies the original request. Consider:

1. **Completeness**: Did the worker do everything that was asked?
2. **Correctness**: Is the work done correctly, without errors?
3. **Quality**: Is the output of acceptable quality?
4. **Response Ready**: If a response needs to be sent back, is it appropriate?

## RESPONSE FORMAT (JSON)
{
  "status": "valid" | "partial" | "invalid" | "needs_human",
  "confidence": 0.0-1.0,
  "issues": [
    {
      "severity": "info" | "warning" | "error",
      "description": "What's the issue?",
      "location": "Where in the output? (optional)"
    }
  ],
  "reasoning": "Your detailed reasoning for this verdict",
  "suggestion": "What should be done next? (especially if not valid)"
}

Be thorough but fair. Minor issues don't require retries. Focus on whether the core request was fulfilled.

Respond with only the JSON.`;
  }

  private formatOriginalEvent(event: IncomingEvent): string {
    switch (event.type) {
      case "email":
        const email = event.payload as any;
        return `Type: Email
From: ${email.from}
To: ${email.to}
Subject: ${email.subject}
Body:
${email.body}`;

      case "slack":
        const slack = event.payload as any;
        return `Type: Slack Message
Channel: ${slack.channel}
User: ${slack.user}
Message:
${slack.text}`;

      default:
        return `Type: ${event.type}
Payload:
${JSON.stringify(event.payload, null, 2)}`;
    }
  }

  private parseValidationResponse(text: string): ValidationResult {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }
      const parsed = JSON.parse(jsonMatch[0]);

      return {
        status: this.normalizeStatus(parsed.status),
        confidence: parsed.confidence || 0.5,
        issues: (parsed.issues || []).map((i: any) => ({
          severity: i.severity || "info",
          description: i.description || "Unknown issue",
          location: i.location,
        })),
        suggestion: parsed.suggestion,
      };
    } catch (error) {
      console.error("Failed to parse validation response:", error);
      return {
        status: "needs_human",
        confidence: 0,
        issues: [
          {
            severity: "error",
            description: "Failed to parse validation response",
          },
        ],
        suggestion: "Manual review required",
      };
    }
  }

  private normalizeStatus(status: string): ValidationStatus {
    const normalized = status?.toLowerCase();
    if (["valid", "partial", "invalid", "needs_human"].includes(normalized)) {
      return normalized as ValidationStatus;
    }
    return "needs_human";
  }

  /**
   * Determine the best retry strategy based on validation result.
   */
  private async determineRetryStrategy(
    task: Task,
    result: WorkerResult,
    validation: ValidationResult
  ): Promise<RetryStrategy | undefined> {
    // If needs human, don't suggest retry
    if (validation.status === "needs_human") {
      return { type: "escalate", reason: validation.suggestion || "Needs human review" };
    }

    // Analyze issues to determine strategy
    const errorCount = validation.issues.filter((i) => i.severity === "error").length;
    const warningCount = validation.issues.filter((i) => i.severity === "warning").length;

    // If partial with only warnings, try same worker with guidance
    if (validation.status === "partial" && errorCount === 0) {
      return {
        type: "same_worker",
        additionalInstructions: this.buildAdditionalInstructions(validation),
      };
    }

    // If invalid or has errors, analyze if we should try new approach
    const prompt = `Based on this failed task attempt, what's the best retry strategy?

Task: ${task.description}

Issues Found:
${validation.issues.map((i) => `- [${i.severity}] ${i.description}`).join("\n")}

Suggestion: ${validation.suggestion}

Previous Attempts: ${task.context.previousAttempts?.length || 0}

Options:
1. same_worker - Give the same worker more specific instructions
2. new_worker - Start fresh with a different approach
3. split_task - Break into smaller subtasks
4. escalate - Give up and ask for human help

Respond with JSON:
{
  "strategy": "same_worker" | "new_worker" | "split_task" | "escalate",
  "instructions": "Specific instructions for the chosen strategy",
  "subtasks": ["Only if split_task, list the subtasks"]
}`;

    const response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found");
      }
      const parsed = JSON.parse(jsonMatch[0]);

      switch (parsed.strategy) {
        case "same_worker":
          return {
            type: "same_worker",
            additionalInstructions: parsed.instructions,
          };
        case "new_worker":
          return { type: "new_worker", newApproach: parsed.instructions };
        case "split_task":
          return { type: "split_task", subtasks: parsed.subtasks || [] };
        case "escalate":
          return { type: "escalate", reason: parsed.instructions };
        default:
          return { type: "escalate", reason: "Unable to determine retry strategy" };
      }
    } catch {
      return {
        type: "same_worker",
        additionalInstructions: this.buildAdditionalInstructions(validation),
      };
    }
  }

  private buildAdditionalInstructions(validation: ValidationResult): string {
    const issues = validation.issues
      .filter((i) => i.severity !== "info")
      .map((i) => `- ${i.description}`)
      .join("\n");

    return `The previous attempt had these issues that need to be fixed:
${issues}

${validation.suggestion || "Please address these issues and try again."}`;
  }

  /**
   * Validate that a suggested response is appropriate.
   * Called before sending emails, Slack messages, etc.
   */
  async validateResponse(
    originalEvent: IncomingEvent,
    suggestedResponse: string
  ): Promise<{ approved: boolean; reason: string; revisedResponse?: string }> {
    const prompt = `You are reviewing a draft response before it's sent. Ensure it's professional and appropriate.

## ORIGINAL MESSAGE
${JSON.stringify(originalEvent.payload, null, 2)}

## PROPOSED RESPONSE
${suggestedResponse}

## REVIEW CRITERIA
1. Is the tone professional and appropriate?
2. Does it address the original request?
3. Is it factually accurate based on what we know?
4. Is it free of errors, typos, and awkward phrasing?
5. Does it make any promises we might not be able to keep?

## RESPONSE FORMAT (JSON)
{
  "approved": true | false,
  "reason": "Why approved or not",
  "revisedResponse": "If not approved, provide a revised version (optional)"
}

Respond with only the JSON.`;

    const response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found");
      }
      const parsed = JSON.parse(jsonMatch[0]);

      return {
        approved: parsed.approved ?? false,
        reason: parsed.reason || "No reason provided",
        revisedResponse: parsed.revisedResponse,
      };
    } catch {
      return {
        approved: false,
        reason: "Failed to parse validation response",
      };
    }
  }
}
