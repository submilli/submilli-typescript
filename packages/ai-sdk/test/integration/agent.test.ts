// The AI SDK integration against a real submilli-server, with a scripted model.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { generateText, isStepCount, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { Submilli } from "@submilli/sdk";
import { ManagedServer, skip } from "../../../sdk/test/integration/server.ts";
import {
  EXECUTE,
  memorySessionStore,
  RESUME,
  submilliTools,
  SubmilliSessionMismatchError,
  type ExecuteOutput,
  type SubmilliToolsOptions,
} from "../../src/index.ts";
import { call, execute, Scripted, type Turn } from "../scripted.ts";

const BLUEPRINT = `kind: blueprint
name: shop
variables:
  userId:
    required: true
vfs:
  mode: per_session
  cwd: /notes
  mounts:
    /notes:
      mode: named
      volume: notes
      subPath: \${vars.userId}
default: deny
permissions:
  main:
  - {capability: fs.read, action: allow}
  - {capability: fs.write, action: allow}
  - {capability: fs.list, action: allow}
  - {capability: fs.stat, action: allow}
  - capability: tools.call
    filter: tool == "lookup" or tool == "refund"
    action: allow
`;

const NOTE = `
import fs from "submilli:fs";

function main(): string {
    const before: string[] = [];
    for (const entry of fs.list(".", false)) before.push(entry.name);
    fs.writeText("check.md", "# Written by a check\\n");
    return \`notes before: \${before.join(", ") || "none"}\`;
}
`;

const LOOKUP = `
import tools from "@tools";

function main(): string {
    const order = tools.lookup({ id: 1 });
    return \`order \${order.id} is \${order.status}\`;
}
`;

const REFUNDS = `
import tools from "@tools";

function main(): string {
    const order = tools.lookup({ id: 2 });
    try {
        tools.refund({ id: order.id, amount: 40 });
        return "refunded";
    } catch (e) {
        if (e instanceof PermissionDeniedError) return \`refused: \${e.message}\`;
        throw e;
    }
}
`;

const SECRET = `
import tools from "@tools";

function main(): string {
    tools.secret_tool();
    return "ran";
}
`;

const lookup = tool({
  description: "Look up an order.",
  inputSchema: z.object({ id: z.number() }),
  outputSchema: z.object({ id: z.number(), status: z.string() }),
  execute: async ({ id }) => ({ id, status: id === 1 ? "shipped" : "pending" }),
});

const refunded: unknown[] = [];
const refund = tool({
  description: "Refund an order.",
  inputSchema: z.object({ id: z.number(), amount: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    refunded.push(input);
    return { ok: true };
  },
});

const secret_tool = tool({
  inputSchema: z.object({}),
  execute: async () => "should never run",
});

function shown(model: Scripted): ExecuteOutput {
  return model.toolResults().at(-1) as ExecuteOutput;
}

describe("the AI SDK integration against submilli-server", { skip }, () => {
  let server: ManagedServer;
  let client: Submilli;

  before(async () => {
    server = await ManagedServer.start("volumes:\n  notes:\n    kind: managed-local\n    size_limit: unlimited\n");
    await server.apply("shop", BLUEPRINT);
    client = new Submilli({ baseURL: server.url, token: server.token });
  });

  after(async () => {
    await server?.stop();
  });

  async function run(options: Partial<SubmilliToolsOptions>, turns: Turn[], messages?: ModelMessage[]) {
    const submilli = await submilliTools({ client, blueprint: "shop", ...options });
    const model = new Scripted(...turns);
    const prompt: ModelMessage[] = messages ?? [{ role: "user", content: "go" }];
    const result = await generateText({ model, tools: submilli.tools, messages: prompt, stopWhen: isStepCount(10) });
    return { submilli, model, result, messages: [...prompt, ...result.responseMessages] };
  }

  test("each user sees only their own notes, and a conversation keeps its session", async () => {
    const store = memorySessionStore();
    const [ada, grace] = [`ada_${Date.now()}`, `grace_${Date.now()}`];
    const first = await run({ store, conversationId: "a", variables: { userId: ada } }, [[execute(NOTE)], "done"]);
    assert.equal(shown(first.model).result, "notes before: none");
    assert.match(first.model.description(EXECUTE) ?? "", /strict TypeScript subset/);
    const other = await run({ store, conversationId: "g", variables: { userId: grace } }, [[execute(NOTE)], "done"]);
    assert.equal(shown(other.model).result, "notes before: none");
    const again = await run({ store, conversationId: "a", variables: { userId: ada } }, [[execute(NOTE)], "done"]);
    assert.equal(shown(again.model).result, "notes before: check.md");
    assert.equal((await again.submilli.session())?.id, (await first.submilli.session())?.id);
    await assert.rejects(
      submilliTools({ client, blueprint: "shop", store, conversationId: "a", variables: { userId: grace } }),
      SubmilliSessionMismatchError,
    );
    assert.equal(await again.submilli.close(), true);
  });

  test("a failing program, a compile error, and the last run", async () => {
    const { model } = await run({ variables: { userId: "u" } }, [
      [execute('function main(): void { console.log("seen"); throw new Error("boom"); }')],
      [call("submilli__typescript__last_run", {})],
      [execute("function main(): number { return ; }")],
      "done",
    ]);
    const [failed, last, compile] = model.toolResults() as Record<string, any>[];
    assert.equal(failed?.error.kind, "runtime_error");
    assert.deepEqual(last?.console, ["seen"]);
    assert.equal(compile?.error.kind, "compile_error");
  });

  test("a program calls the application's tools, typed by their schemas", async () => {
    const { model, result } = await run({ variables: { userId: "u" }, ptc: { lookup } }, [
      [call("submilli__typescript__packages__docs", { name: "@tools" })],
      [execute(LOOKUP)],
      "done",
    ]);
    const [docs, ran] = model.toolResults() as [string, ExecuteOutput];
    assert.match(docs, /lookup\(args: \{ id: number \}\): \{ id: number; status: string \}/);
    assert.equal(ran.result, "order 1 is shipped", JSON.stringify(ran.error));
    const output = result.steps[1]!.toolResults[0]!.output as ExecuteOutput;
    assert.deepEqual(output.tool_calls, [{ call_id: output.tool_calls![0]!.call_id, tool: "lookup", args: { id: 1 }, outcome: "ok" }]);
  });

  test("the Blueprint refuses a tool it does not grant, and the application never sees the call", async () => {
    const { model } = await run({ variables: { userId: "u" }, ptc: { lookup, secret_tool } }, [[execute(SECRET)], "done"]);
    const output = shown(model);
    assert.equal(output.denied, true);
    assert.equal((output.error as { source: string }).source, "policy");
  });

  test("tools routed by experimental_toolCallers", async () => {
    const submilli = await submilliTools({ client, blueprint: "shop", variables: { userId: "u" } });
    const model = new Scripted([execute(LOOKUP)], "done");
    await generateText({
      model,
      tools: { ...submilli.tools, lookup },
      experimental_toolCallers: { lookup: [EXECUTE] },
      prompt: "go",
      stopWhen: isStepCount(5),
    });
    assert.equal(shown(model).result, "order 1 is shipped", JSON.stringify(shown(model).error));
  });

  test("onApprovalRequired decides while the program waits", async () => {
    refunded.length = 0;
    const { model } = await run(
      {
        variables: { userId: "u" },
        ptc: { lookup, refund },
        toolApproval: { refund: "user-approval" },
        onApprovalRequired: ({ toolName, input }) => {
          assert.equal(toolName, "refund");
          assert.deepEqual(input, { id: 2, amount: 40 });
          return { approved: false, reason: "over the limit" };
        },
      },
      [[execute(REFUNDS)], "done"],
    );
    assert.match(String(shown(model).result), /refused: .*over the limit/);
    assert.deepEqual(refunded, []);
  });

  test("an approval through the AI SDK's flow, across requests", async () => {
    refunded.length = 0;
    const store = memorySessionStore();
    const options = {
      store,
      conversationId: `approve_${Date.now()}`,
      variables: { userId: "u" },
      ptc: { lookup, refund: tool({ ...refund, needsApproval: true }) },
    };
    const first = await run(options, [
      [execute(REFUNDS)],
      (prompt) => {
        const awaiting = JSON.parse(JSON.stringify(prompt.prompt)).flatMap((message: any) =>
          message.role === "tool" ? message.content : [],
        ).at(-1).output.value.awaiting_approval;
        assert.deepEqual(awaiting.resume_input.calls, [{ tool: "refund", args: { id: 2, amount: 40 } }]);
        return [call(RESUME, awaiting.resume_input)];
      },
    ]);
    const approval = first.result.content.find((part) => part.type === "tool-approval-request");
    assert.ok(approval);
    assert.deepEqual(refunded, []);

    // A new request, as from another process: new tools, the same store.
    const second = await run(options, ["done"], [
      ...first.messages,
      { role: "tool", content: [{ type: "tool-approval-response", approvalId: approval.approvalId, approved: true }] },
    ]);
    assert.equal(shown(second.model).result, "refunded", JSON.stringify(shown(second.model).error));
    assert.deepEqual(refunded, [{ id: 2, amount: 40 }]);
  });

  test("a refused approval: the program sees the refusal before the next program runs", async () => {
    refunded.length = 0;
    const store = memorySessionStore();
    const options = {
      store,
      conversationId: `refuse_${Date.now()}`,
      variables: { userId: "u" },
      ptc: { lookup, refund },
      toolApproval: { refund: "user-approval" as const },
    };
    let waiting = "";
    const first = await run(options, [
      [execute(REFUNDS)],
      (prompt) => {
        const awaiting = JSON.parse(JSON.stringify(prompt.prompt)).flatMap((message: any) =>
          message.role === "tool" ? message.content : [],
        ).at(-1).output.value.awaiting_approval;
        waiting = awaiting.resume_input.execution_id;
        return [call(RESUME, awaiting.resume_input)];
      },
    ]);
    const approval = first.result.content.find((part) => part.type === "tool-approval-request")!;
    const second = await run(options, [[call("submilli__typescript__last_run", {})], [execute(NOTE)], [call("submilli__typescript__last_run", {})], "done"], [
      ...first.messages,
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: approval.approvalId, approved: false, reason: "no refunds" }],
      },
    ]);
    const results = second.model.toolResults() as Record<string, any>[];
    // last_run, asked first, already shows the refused program, finished with the person's reason.
    assert.match(String(results.at(-3)!.result), /refused: .*no refunds/);
    // The denial the AI SDK reports, then the next program, which ran.
    const note = results.at(-2)!;
    assert.match(String(note.result), /notes before/);
    assert.deepEqual(refunded, []);
    // The refused program finished, with the person's reason, before the next one ran.
    const refusedRun = await client.runs.retrieve(waiting);
    assert.ok(refusedRun.status === "finished");
    assert.match(String(refusedRun.result), /refused: .*no refunds/);
  });

  test("a person who moves on: a denied result in the resume call's place refuses the waiting call", async () => {
    refunded.length = 0;
    const options = {
      store: memorySessionStore(),
      conversationId: `moved_on_${Date.now()}`,
      variables: { userId: "u" },
      ptc: { lookup, refund },
      toolApproval: { refund: "user-approval" as const },
    };
    let waiting = "";
    const first = await run(options, [
      [execute(REFUNDS)],
      (prompt) => {
        const awaiting = JSON.parse(JSON.stringify(prompt.prompt)).flatMap((message: any) =>
          message.role === "tool" ? message.content : [],
        ).at(-1).output.value.awaiting_approval;
        waiting = awaiting.resume_input.execution_id;
        return [call(RESUME, awaiting.resume_input)];
      },
    ]);
    const approval = first.result.content.find((part) => part.type === "tool-approval-request")!;
    const second = await run(options, [[execute(NOTE)], "done"], [
      ...first.messages,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: approval.toolCall.toolCallId,
            toolName: RESUME,
            output: { type: "execution-denied", reason: "went to lunch" },
          },
        ],
      },
      { role: "user", content: "something else" },
    ]);
    assert.match(String(shown(second.model).result), /notes before/);
    assert.deepEqual(refunded, []);
    const refusedRun = await client.runs.retrieve(waiting);
    assert.ok(refusedRun.status === "finished");
    assert.match(String(refusedRun.result), /refused: .*went to lunch/);
  });
});
