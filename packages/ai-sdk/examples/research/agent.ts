// The research agent from submilli-runtime's harness tutorials, on @submilli/ai-sdk.
//
// Every program the model writes runs on submilli-server, under the `research`
// Blueprint, as the user the request names.

import { readFileSync } from "node:fs";
import { anthropic } from "@ai-sdk/anthropic";
import { submilliTools } from "@submilli/ai-sdk";
import { generateText, isStepCount, type LanguageModel } from "ai";

// The agent's brief, kept beside the Blueprint.
export const INSTRUCTIONS: string = readFileSync(new URL("prompt.txt", import.meta.url), "utf8");

/**
 * Answer one message of a conversation. Server and token come from
 * SUBMILLI_SERVER and SUBMILLI_SERVER_TOKEN.
 */
export async function answer(
  question: string,
  userId: string,
  conversationId: string,
  model: LanguageModel = anthropic("claude-sonnet-5"),
): Promise<string> {
  // One per request: the user comes from the request, and the conversation's
  // session is found again by its id.
  const submilli = await submilliTools({ blueprint: "research", conversationId, variables: { userId } });
  const result = await generateText({
    model,
    system: INSTRUCTIONS,
    tools: submilli.tools,
    prompt: question,
    stopWhen: isStepCount(20),
  });
  for (const step of result.steps) {
    for (const output of step.toolResults) {
      // Where each program's run is in the server's audit trail.
      const executionId = (output.output as { execution_id?: string } | undefined)?.execution_id;
      if (executionId) console.error(`[${output.toolName}] execution ${executionId}`);
    }
  }
  return result.text;
}

/** End a conversation's session, once the conversation is over. */
export async function close(userId: string, conversationId: string): Promise<void> {
  const submilli = await submilliTools({ blueprint: "research", conversationId, variables: { userId } });
  await submilli.close();
}

if (import.meta.filename === process.argv[1]) {
  const question =
    process.argv.slice(2).join(" ") || "What is new in the latest stable release of Rust? Save a note with your sources.";
  try {
    // In a real application the user comes from the signed-in session.
    console.log(await answer(question, "u_ada", "example"));
  } finally {
    await close("u_ada", "example");
  }
}
