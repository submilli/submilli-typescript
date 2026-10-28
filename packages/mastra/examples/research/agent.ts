// The research agent from submilli-runtime's harness tutorials, on @submilli/mastra.
//
// Every program the model writes runs on submilli-server, under the `research`
// Blueprint, as the user who owns the memory thread.

import { readFileSync } from "node:fs";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { InMemoryStore } from "@mastra/core/storage";
import { Memory } from "@mastra/memory";
import { createSubmilliTools } from "@submilli/mastra";

type Model = ConstructorParameters<typeof Agent>[0]["model"];

// The agent's brief, kept beside the Blueprint.
export const INSTRUCTIONS: string = readFileSync(new URL("prompt.txt", import.meta.url), "utf8");

// One per process. Server and token come from SUBMILLI_SERVER and
// SUBMILLI_SERVER_TOKEN; the user comes from each agent run's memory resource.
export const submilli = createSubmilliTools({
  blueprint: "research",
  variables: ({ resourceId }) => {
    if (!resourceId) throw new Error("run the agent with memory: { thread, resource }");
    return { userId: resourceId };
  },
});

// A real deployment uses persistent storage (LibSQLStore, PostgresStore), so
// threads, and the Submilli session each one keeps, survive restarts.
const storage = new InMemoryStore();
const memory = new Memory();

export function researcher(model: Model = "anthropic/claude-sonnet-5"): Agent {
  const agent = new Agent({
    id: "researcher",
    name: "Researcher",
    instructions: INSTRUCTIONS,
    model,
    memory,
    tools: () => submilli.tools(),
  });
  return new Mastra({ agents: { researcher: agent }, storage, logger: false }).getAgent("researcher");
}

/** Answer one message of a conversation: a memory thread of the user's. */
export async function answer(question: string, userId: string, threadId: string, agent = researcher()): Promise<string> {
  const result = await agent.generate(question, { memory: { thread: threadId, resource: userId }, maxSteps: 20 });
  for (const part of result.toolResults) {
    // Where each program's run is in the server's audit trail.
    const executionId = (part.payload.result as { execution_id?: string } | undefined)?.execution_id;
    if (executionId) console.error(`[${part.payload.toolName}] execution ${executionId}`);
  }
  return result.text;
}

/** End a thread's session, once the conversation is over. */
export async function close(threadId: string): Promise<void> {
  await submilli.close({ threadId, memory });
}

if (import.meta.filename === process.argv[1]) {
  const question =
    process.argv.slice(2).join(" ") || "What is new in the latest stable release of Rust? Save a note with your sources.";
  try {
    // In a real application the user comes from the signed-in session.
    console.log(await answer(question, "u_ada", "example"));
  } finally {
    await close("example");
  }
}
