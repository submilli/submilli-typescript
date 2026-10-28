// Runs agent.ts with a scripted model in place of Claude, so it needs no API key.
//
// Start the server first (see README.md). It asserts that two users who write
// the same note each see only their own.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MockLanguageModelV4 } from "ai/test";
import { answer, close } from "./agent.ts";

const PROGRAM = readFileSync(new URL("note.ts", import.meta.url), "utf8");
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

// Runs note.ts, then answers with the result it was shown.
function scripted(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt, tools }) => {
      const execute = tools?.find((tool) => tool.name === "submilli__typescript__execute");
      assert.ok(execute?.type === "function", "the execute tool is offered");
      assert.match(execute.description ?? "", /TypeScript/);
      const result = prompt.find((message) => message.role === "tool");
      return {
        content: result
          ? [{ type: "text", text: JSON.stringify(result.content) }]
          : [
              {
                type: "tool-call",
                toolCallId: `call-${crypto.randomUUID()}`,
                toolName: "submilli__typescript__execute",
                input: JSON.stringify({ code: PROGRAM }),
              },
            ],
        finishReason: { unified: result ? "stop" : "tool-calls", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

const [ada, grace] = [`ada_${Date.now()}`, `grace_${Date.now()}`];
try {
  assert.match(await answer("note", ada, ada, scripted()), /notes before: none/);
  assert.match(await answer("note", grace, grace, scripted()), /notes before: none/);
  assert.match(await answer("note", ada, ada, scripted()), /notes before: check\.md/);
} finally {
  await close(ada, ada);
  await close(grace, grace);
}
console.log("research: ok");
