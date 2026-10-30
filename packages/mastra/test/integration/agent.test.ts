// The Mastra integration against a real submilli-server, with a scripted model.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { InMemoryStore } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { z } from "zod";
import { Submilli } from "@submilli/sdk";
import { ManagedServer, skip } from "../../../sdk/test/integration/server.ts";
import { call, execute, Scripted, type Turn } from "../../../ai-sdk/test/scripted.ts";
import { createSubmilliTools, EXECUTE, type ApprovalPayload, type ExecuteOutput, type SubmilliToolsOptions } from "../../src/index.ts";

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

const lookup = createTool({
  id: "lookup",
  description: "Look up an order.",
  inputSchema: z.object({ id: z.number() }),
  outputSchema: z.object({ id: z.number(), status: z.string() }),
  execute: async ({ id }) => ({ id, status: id === 1 ? "shipped" : "pending" }),
});

const refunded: unknown[] = [];
const refund = createTool({
  id: "refund",
  description: "Refund an order.",
  inputSchema: z.object({ id: z.number(), amount: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
  requireApproval: true,
  execute: async (input) => {
    refunded.push(input);
    return { ok: true };
  },
});

const secret_tool = createTool({
  id: "secret_tool",
  description: "Not granted by the Blueprint.",
  execute: async () => "should never run",
});

function shown(model: Scripted): ExecuteOutput {
  return model.toolResults().at(-1) as ExecuteOutput;
}

describe("the Mastra integration against submilli-server", { skip }, () => {
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

  /** An agent with memory on `storage`, whose user is the memory resource. */
  function agent(options: Partial<SubmilliToolsOptions>, turns: Turn[], storage = new InMemoryStore()) {
    const submilli = createSubmilliTools({
      client,
      blueprint: "shop",
      variables: ({ resourceId }) => ({ userId: resourceId ?? "" }),
      ...options,
    });
    const model = new Scripted(...turns);
    const built = new Agent({
      id: "shop",
      name: "shop",
      instructions: "Use Submilli.",
      model: model as never,
      memory: new Memory(),
      tools: () => submilli.tools(),
    });
    const mastra = new Mastra({ agents: { shop: built }, storage, logger: false });
    return { submilli, model, agent: mastra.getAgent("shop"), storage };
  }

  test("each user sees only their own notes, and a thread keeps its session", async () => {
    const [ada, grace] = [`ada_${Date.now()}`, `grace_${Date.now()}`];
    const { submilli, model, agent: shop } = agent({}, [[execute(NOTE)], "one", [execute(NOTE)], "two", [execute(NOTE)], "three"]);
    await shop.generate("note", { memory: { thread: `t_${ada}`, resource: ada } });
    assert.equal(shown(model).result, "notes before: none");
    assert.match(model.description(EXECUTE) ?? "", /strict TypeScript subset/);
    await shop.generate("note", { memory: { thread: `t_${grace}`, resource: grace } });
    assert.equal(shown(model).result, "notes before: none");
    await shop.generate("note", { memory: { thread: `t_${ada}`, resource: ada } });
    assert.equal(shown(model).result, "notes before: check.md");
    const memory = (await shop.getMemory())!;
    const session = await submilli.session({ threadId: `t_${ada}`, memory });
    assert.ok(session);
    assert.equal(await submilli.close({ threadId: `t_${ada}`, memory }), true);
    assert.equal(await submilli.close({ threadId: `t_${grace}`, memory }), true);
  });

  test("a failing program, a compile error, and the last run", async () => {
    const { model, agent: shop } = agent({}, [
      [execute('function main(): void { console.log("seen"); throw new Error("boom"); }')],
      [call("submilli__typescript__last_run", {})],
      [execute("function main(): number { return ; }")],
      "done",
    ]);
    await shop.generate("go", { memory: { thread: `fail_${Date.now()}`, resource: "u" } });
    const [failed, last, compile] = model.toolResults() as Record<string, any>[];
    assert.equal(failed?.error.kind, "runtime_error");
    assert.deepEqual(last?.console, ["seen"]);
    assert.equal(compile?.error.kind, "compile_error");
  });

  test("a program calls the application's tools, typed by their schemas", async () => {
    const { model, agent: shop } = agent({ ptc: { lookup } }, [
      [call("submilli__typescript__packages__docs", { name: "@tools" })],
      [execute(LOOKUP)],
      "done",
    ]);
    await shop.generate("go", { memory: { thread: `lookup_${Date.now()}`, resource: "u" } });
    const [docs, ran] = model.toolResults() as [string, ExecuteOutput];
    assert.match(docs, /lookup\(args: \{ id: number \}\): \{ id: number; status: string \}/);
    assert.equal(ran.result, "order 1 is shipped", JSON.stringify(ran.error));
    assert.deepEqual(ran.tool_calls, [{ tool: "lookup", args: { id: 1 }, outcome: "ok" }]);
  });

  test("the Blueprint refuses a tool it does not grant, and the application never sees the call", async () => {
    const { model, agent: shop } = agent({ ptc: { lookup, secret_tool } }, [[execute(SECRET)], "done"]);
    await shop.generate("go", { memory: { thread: `secret_${Date.now()}`, resource: "u" } });
    const output = shown(model);
    assert.equal(output.denied, true);
    assert.equal((output.error as { source: string }).source, "policy");
  });

  test("onApprovalRequired decides while the program waits", async () => {
    refunded.length = 0;
    const { model, agent: shop } = agent(
      {
        ptc: { lookup, refund },
        onApprovalRequired: ({ toolName, input }) => {
          assert.equal(toolName, "refund");
          assert.deepEqual(input, { id: 2, amount: 40 });
          return { approved: false, reason: "over the limit" };
        },
      },
      [[execute(REFUNDS)], "done"],
    );
    await shop.generate("go", { memory: { thread: `ask_${Date.now()}`, resource: "u" } });
    assert.match(String(shown(model).result), /refused: .*over the limit/);
    assert.deepEqual(refunded, []);
  });

  test("an approval through Mastra's suspend and resume, in another instance", async () => {
    refunded.length = 0;
    const storage = new InMemoryStore();
    const memory = { thread: `approve_${Date.now()}`, resource: "u" };
    const first = agent({ ptc: { lookup, refund } }, [[execute(REFUNDS)]], storage);
    const suspended = await first.agent.generate("refund order 2", { memory });
    assert.equal(suspended.finishReason, "suspended");
    const payload = (suspended.suspendPayload as { suspendPayload: ApprovalPayload }).suspendPayload;
    assert.deepEqual(payload.calls, [{ tool: "refund", args: { id: 2, amount: 40 } }]);
    assert.deepEqual(refunded, []);

    // Another instance, as after a restart: its own tools and agent, the same storage.
    const second = agent({ ptc: { lookup, refund } }, ["refunded"], storage);
    const { runs } = await second.agent.listSuspendedRuns({ threadId: memory.thread, resourceId: memory.resource });
    assert.equal(runs[0]?.runId, suspended.runId);
    const resumed = await second.agent.resumeGenerate({ approved: true }, { runId: suspended.runId, memory });
    assert.equal(resumed.text, "refunded");
    assert.equal(shown(second.model).result, "refunded", JSON.stringify(shown(second.model).error));
    assert.deepEqual(refunded, [{ id: 2, amount: 40 }]);
    const run = await client.runs.retrieve(payload.execution_id);
    assert.equal(run.status, "finished");
  });

  test("a refused approval: the program sees the person's reason", async () => {
    refunded.length = 0;
    const memory = { thread: `refuse_${Date.now()}`, resource: "u" };
    const { model, agent: shop } = agent({ ptc: { lookup, refund } }, [[execute(REFUNDS)], "not refunded"]);
    const suspended = await shop.generate("refund order 2", { memory });
    await shop.resumeGenerate({ approved: false, reason: "no refunds" }, { runId: suspended.runId, memory });
    assert.match(String(shown(model).result), /refused: .*no refunds/);
    assert.deepEqual(shown(model).tool_calls?.map((record) => record.decision ?? record.outcome), ["ok", "denied"]);
    assert.deepEqual(refunded, []);
  });

  test("a person who moves on: the next agent run on the thread refuses the waiting call", async () => {
    refunded.length = 0;
    const memory = { thread: `moved_on_${Date.now()}`, resource: `moved_${Date.now()}` };
    const { model, agent: shop } = agent({ ptc: { lookup, refund } }, [[execute(REFUNDS)], [execute(NOTE)], "done"]);
    const suspended = await shop.generate("refund order 2", { memory });
    const waiting = (suspended.suspendPayload as { suspendPayload: ApprovalPayload }).suspendPayload.execution_id;
    await shop.generate("something else", { memory, requestContext: new RequestContext() });
    assert.match(String(shown(model).result), /notes before/);
    assert.deepEqual(refunded, []);
    const refusedRun = await client.runs.retrieve(waiting);
    assert.ok(refusedRun.status === "finished");
    assert.match(String(refusedRun.result), /refused: .*moved on/);
  });
});
