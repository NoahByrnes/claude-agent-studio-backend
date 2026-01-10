#!/usr/bin/env node
/**
 * Claude Agent Studio - Agent Runtime
 *
 * This is the agent executor that runs inside containers.
 * It receives prompts via command line and streams output as JSON.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Main agent execution
 */
async function main() {
  // Get prompt from command line arguments
  const prompt = process.argv.slice(2).join(" ");

  if (!prompt) {
    console.error("❌ Error: Please provide a prompt");
    console.error("\nUsage: npm start <prompt>");
    console.error("Example: npm start 'Check my email and summarize important messages'");
    process.exit(1);
  }

  // Log to stderr (won't interfere with JSON stdout)
  console.error("=".repeat(60));
  console.error("Claude Agent Studio Runtime");
  console.error("=".repeat(60));
  console.error(`\nPrompt: ${prompt}\n`);

  const debug = process.env.DEBUG === 'true';

  if (debug) {
    console.error('[DEBUG] Environment check:');
    console.error(`[DEBUG] - Working directory: ${process.cwd()}`);
    console.error(`[DEBUG] - Node version: ${process.version}`);
    console.error(`[DEBUG] - ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET'}`);
    console.error('');
  }

  try {
    let messageCount = 0;
    const startTime = Date.now();

    // Execute agent using Claude Agent SDK
    for await (const message of query({
      prompt,
      options: {
        // Set working directory for skill discovery
        cwd: process.cwd(),

        // Allow agent to use tools
        // Skills are custom tools defined in .claude/skills/
        allowedTools: ["Skill", "Read", "Write", "Edit", "Bash", "Grep", "Glob"],

        // Load skills from project .claude/skills/ directory
        settingSources: ["project"],

        // Allow up to 50 turns for complex multi-step tasks
        maxTurns: 50,
      },
    })) {
      messageCount++;
      const elapsed = Date.now() - startTime;

      if (debug) {
        console.error(`[DEBUG] Message #${messageCount} at ${elapsed}ms - Type: ${message?.type || 'unknown'}`);
      }

      // Stream output to stdout as JSON (for parsing by container server)
      // Each message is a complete JSON object on its own line
      if (message && typeof message === "object") {
        console.log(JSON.stringify(message));
      }

      if (debug && messageCount % 5 === 0) {
        console.error(`[DEBUG] Progress: ${messageCount} messages in ${elapsed}ms`);
      }
    }

    if (debug) {
      const totalTime = Date.now() - startTime;
      console.error(`[DEBUG] Completed: ${messageCount} messages in ${totalTime}ms`);
    }

    console.error("\n" + "=".repeat(60));
    console.error("Task Complete!");
    console.error("=".repeat(60));

  } catch (error) {
    console.error("\n❌ Failed to complete task:");
    console.error(error);
    process.exit(1);
  }
}

// Run the agent
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
