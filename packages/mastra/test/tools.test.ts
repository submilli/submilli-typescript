import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { InMemoryStore } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { z } from "zod";
import { Submilli } from "@submilli/sdk";
import { FakeServer, SERVER, TOKEN } from "../../sdk/test/fake-server.ts";
import { call, execute, Scripted, type Turn } from "../../ai-sdk/test/scripted.ts";
import {
  createSubmilliTools,
  EXECUTE,
  memorySessionStore,
  type ApprovalPayload,
  type ExecuteOutput,
  type SubmilliToolsOptions,
} from "../src/index.ts";

const THREAD = { thread: "t1", resource: "u_ada" };

/** A Mastra app on the fake server: one agent, with memory unless asked not to, and the turns it will take. */
function app(options: Partial<SubmilliToolsOptions>, turns: Turn[], { memory = true, storage = new InMemoryStore() } = {}) {
  const fake = new FakeServer();
  const client = new Submilli({ baseURL: SERVER, token: TOKEN, fetch: fake.fetch });
  const submilli = createSubmilliTools({ client, blueprint: "research", variables: { userId: "u_ada" }, ...options });
  const model = new Scripted(...turns);
  const agent = mastraAgent(model, () => submilli.tools(), storage, memory);
  return { fake, client, submilli, model, agent, storage };
}

function mastraAgent(model: Scripted, tools: () => Promise<object>, storage: InMemoryStore, memory = true) {
  const agent = new Agent({
    id: "assistant",
    name: "assistant",
    instructions: "Use Submilli.",
    // Mastra runs AI SDK v4-spec models; its own model type wants a stream-shaped doGenerate.
    model: model as never,
    tools: tools as never,
    ...(memory ? { memory: new Memory() } : {}),
  });
  return new Mastra({ agents: { assistant: agent }, storage, logger: false }).getAgent("assistant");
}

/** What the execute tool returned in a generate result, in order. */
function outputs(result: { toolResults: { payload: { toolName: string; result: unknown } }[] }): ExecuteOutput[] {
  return result.toolResults
    .filter((part) => part.payload.toolName === EXECUTE)
    .map((part) => part.payload.result as ExecuteOutput);
}

function shown(model: Scripted): Record<string, unknown> {
  return model.toolResults().at(-1) as Record<string, unknown>;
}

const lookup = createTool({
  id: "lookup",
  description: "Look up an order.",
  inputSchema: z.object({ id: z.number() }),
  outputSchema: z.object({ id: z.number(), status: z.string() }),
  execute: async ({ id }) => ({ id, status: id === 1 ? "shipped" : "pending" }),
});

const refunds: unknown[] = [];
const refund = createTool({
  id: "refund",
  description: "Refund an order.",
  inputSchema: z.object({ id: z.number(), amount: z.number() }),
  requireApproval: true,
  execute: async (input) => {
    refunds.push(input);
    return { refunded: input.id, amount: input.amount };
  },
});

describe("tools", () => {
  test("the agent gets the server's tools and descriptions, and a program runs", async () => {
    const { fake, model, agent } = app({ variables: { userId: "u_ada" } }, [[execute("function main() {}", "toolu_1")], "done"]);
    const result = await agent.generate("go", { memory: THREAD });
    assert.deepEqual(model.toolNames().sort(), [
      "submilli__typescript__builtins__docs",
      "submilli__typescript__builtins__list",
      "submilli__typescript__execute",
      "submilli__typescript__last_run",
      "submilli__typescript__packages__docs",
      "submilli__typescript__packages__search",
    ]);
    assert.match(model.description(EXECUTE) ?? "", /strict TypeScript subset/);
    assert.equal(model.description("submilli__typescript__last_run"), "The last run.");
    assert.deepEqual(shown(model), { result: "ok", console: [], error: null, denied: false });
    const [output] = outputs(result);
    assert.equal(output?.session_id, [...fake.sessions.keys()][0]);
    assert.ok(output?.execution_id);
    const [request] = fake.calls("POST", /\/execute$/);
    assert.equal(request?.headers.get("idempotency-key"), "toolu_1");
    assert.deepEqual(request?.body, { code: "function main() {}" });
  });

  test("a denial is marked final for the model", async () => {
    const { fake, model, agent } = app({}, [[execute("x")], "done"]);
    fake.outcome = {
      result: null,
      console: [],
      error: { kind: "permission_denied", message: "denied", source: "policy" },
      denied: true,
    };
    await agent.generate("go", { memory: THREAD });
    assert.match(String(shown(model).note), /final/);
  });

  test("discovery tools use the Blueprint", async () => {
    const { fake, model, agent } = app({}, [
      [
        call("submilli__typescript__packages__search", { query: "jina" }),
        call("submilli__typescript__packages__docs", { name: "@submilli/jina" }),
        call("submilli__typescript__builtins__list", {}),
        call("submilli__typescript__builtins__docs", { names: ["Map"] }),
      ],
      "done",
    ]);
    await agent.generate("go", { memory: THREAD });
    const [search, docs, list, builtins] = model.toolResults();
    assert.deepEqual(search, { results: [{ name: "@submilli/jina", description: "jina", source: "registry" }] });
    assert.match(String(docs), /searchJson/);
    assert.deepEqual(list, { namespaces: ["JSON"], types: ["Map"] });
    assert.deepEqual(builtins, { results: [{ name: "Map", declarations: "..." }] });
    assert.equal(fake.sessions.size, 0, "discovery without ptc opens no session");
  });

  test("a thread keeps its session in its metadata across agent runs, and close ends it", async () => {
    const { fake, submilli, agent } = app({ variables: ({ resourceId }) => ({ userId: resourceId! }) }, [
      [execute("a")],
      "one",
      [execute("b")],
      "two",
    ]);
    await agent.generate("go", { memory: THREAD });
    await agent.generate("again", { memory: THREAD });
    assert.equal(fake.sessions.size, 1);
    const [id] = fake.sessions.keys();
    assert.deepEqual(fake.sessions.get(id!)?.variables, { userId: "u_ada" });
    const memory = await agent.getMemory();
    const thread = await memory!.getThreadById({ threadId: "t1" });
    assert.equal((thread?.metadata?.submilli as { id: string }).id, id);
    assert.equal((await submilli.session({ threadId: "t1", memory: memory! }))?.id, id);
    assert.equal(await submilli.close({ threadId: "t1", memory: memory! }), true);
    assert.equal(fake.sessions.size, 0);
    assert.equal((await memory!.getThreadById({ threadId: "t1" }))?.metadata?.submilli, null);
    assert.equal(await submilli.close({ threadId: "t1", memory: memory! }), false);
  });

  test("variables come from the request context; another binding on the thread is refused", async () => {
    const variables = ({ requestContext }: { requestContext: RequestContext | undefined }) => ({
      userId: String(requestContext?.get("userId")),
    });
    const { fake, model, agent } = app({ variables }, [[execute("a")], "one", [execute("b")], "two"]);
    const ada = new RequestContext([["userId", "u_ada"]]);
    await agent.generate("go", { memory: THREAD, requestContext: ada });
    assert.deepEqual([...fake.sessions.values()][0]?.variables, { userId: "u_ada" });
    const grace = new RequestContext([["userId", "u_grace"]]);
    await agent.generate("go", { memory: THREAD, requestContext: grace });
    assert.match(JSON.stringify(shown(model)), /different variables[^"]*differing: userId/);
    assert.equal(fake.sessions.size, 1);
  });

  test("without memory, each agent run has its own session", async () => {
    const { fake, agent } = app({}, [[execute("a")], "one", [execute("b")], "two"], { memory: false });
    await agent.generate("go");
    await agent.generate("again");
    assert.equal(fake.sessions.size, 2);
  });

  test("an explicit store keeps sessions by thread id", async () => {
    const store = memorySessionStore();
    const { fake, agent } = app({ store }, [[execute("a")], "one"]);
    await agent.generate("go", { memory: THREAD });
    assert.equal((await store.get("t1"))?.id, [...fake.sessions.keys()][0]);
  });

  test("parallel calls open one session", async () => {
    const { fake, agent } = app({}, [[execute("a"), execute("b"), execute("c")], "done"]);
    await agent.generate("go", { memory: THREAD });
    assert.equal(fake.sessions.size, 1);
  });

  test("an ended session is replaced once, and the model is told", async () => {
    const { fake, model, agent } = app({}, [[execute("a")], "one", [execute("b")], "two"]);
    await agent.generate("go", { memory: THREAD });
    fake.sessions.clear();
    await agent.generate("again", { memory: THREAD });
    assert.match(String(shown(model).notice), /new session was opened/);
    assert.equal(fake.sessions.size, 1);
  });

  test("lost harness secrets are sent again", async () => {
    const { fake, agent } = app({ secrets: { apiKey: "k" } }, [[execute("a")], "one", [execute("b")], "two"]);
    fake.requiredSecrets = ["apiKey"];
    await agent.generate("go", { memory: THREAD });
    const [id] = fake.sessions.keys();
    fake.lostSecrets.add(id!);
    await agent.generate("again", { memory: THREAD });
    assert.equal(fake.calls("POST", /\/rebind$/).length, 1);
    assert.equal(fake.sessions.get(id!)?.secrets.apiKey, "k");
  });

  test("an idempotency refusal is explained to the model", async () => {
    const { fake, model, agent } = app({}, [[execute("a")], "done"]);
    fake.refuseNext = [[409, { error: "idempotency_conflict", message: "conflict" }]];
    await agent.generate("go", { memory: THREAD });
    assert.match(String((shown(model).error as { message: string }).message), /Nothing ran/);
  });
});

describe("ptc", () => {
  test("programs call ptc tools as @tools, declared with their schemas", async () => {
    let context: unknown;
    const whoami = createTool({
      id: "whoami",
      description: "The signed-in user.",
      execute: async (_input, ctx) => {
        context = ctx.requestContext.get("userId");
        return { user: context };
      },
    });
    const { fake, model, agent } = app({ ptc: { lookup, whoami } }, [[execute("orders")], "done"]);
    fake.programs.set("orders", [
      ["lookup", { id: 1 }],
      ["whoami", {}],
    ]);
    const result = await agent.generate("go", { memory: THREAD, requestContext: new RequestContext([["userId", "u_ada"]]) });
    const [session] = fake.sessions.values();
    assert.deepEqual(session?.tools, [
      {
        name: "lookup",
        description: "Look up an order.",
        input_schema: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
        output_schema: {
          type: "object",
          properties: { id: { type: "number" }, status: { type: "string" } },
          required: ["id", "status"],
          additionalProperties: false,
        },
      },
      {
        name: "whoami",
        description: "The signed-in user.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
    ]);
    assert.equal(context, "u_ada");
    assert.match(model.description(EXECUTE) ?? "", /`@tools`[^]*`lookup`, `whoami`/);
    assert.deepEqual(shown(model), {
      result: JSON.stringify([{ id: 1, status: "shipped" }, { user: "u_ada" }]),
      console: [],
      error: null,
      denied: false,
      tool_calls: [
        { tool: "lookup", args: { id: 1 }, outcome: "ok" },
        { tool: "whoami", args: {}, outcome: "ok" },
      ],
    });
    const [output] = outputs(result);
    assert.match(output?.tool_calls?.[0]?.call_id ?? "", /:1$/);
  });

  test("a failing tool or bad input fails the program's call", async () => {
    const broken = createTool({
      id: "broken",
      description: "Throws.",
      execute: async () => {
        throw new Error("boom");
      },
    });
    const sloppy = createTool({
      id: "sloppy",
      description: "Returns the wrong shape.",
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: "yes" }) as never,
    });
    const { fake, model, agent } = app({ ptc: { lookup, broken, sloppy } }, [[execute("bad")], "done"]);
    fake.programs.set("bad", [
      ["lookup", { id: "one" }],
      ["broken", {}],
      ["sloppy", {}],
    ]);
    await agent.generate("go", { memory: THREAD });
    const output = shown(model) as { tool_calls: { outcome: string }[]; error: { message: string } };
    assert.deepEqual(
      output.tool_calls.map((record) => record.outcome),
      ["failed", "failed", "failed"],
    );
    assert.match(output.error.message, /Invalid input for tool 'lookup'/);
    const answers = [...fake.suspended.values()][0]?.answers as { error: { message: string } }[];
    assert.match(answers[1]!.error.message, /Error: boom/);
    assert.match(answers[2]!.error.message, /output validation failed/i);
  });

  test("a ptc tool that suspends fails the program's call", async () => {
    const asks = createTool({
      id: "asks",
      description: "Asks the user.",
      execute: async (_input, ctx) => ctx.agent?.suspend({ question: "which?" }),
    });
    const { fake, agent } = app({ ptc: { asks } }, [[execute("ask")], "done"]);
    fake.programs.set("ask", [["asks", {}]]);
    const result = await agent.generate("go", { memory: THREAD });
    assert.equal(result.finishReason, "stop");
    const answers = [...fake.suspended.values()][0]?.answers as { error: { message: string } }[];
    assert.match(answers[0]!.error.message, /asked to suspend/);
  });

  test("with ptc, discovery goes through the session and includes @tools", async () => {
    const { fake, model, agent } = app({ ptc: { lookup } }, [
      [call("submilli__typescript__packages__docs", { name: "@tools" })],
      "done",
    ]);
    await agent.generate("go", { memory: THREAD });
    assert.match(String(model.toolResults()[0]), /function lookup/);
    assert.equal(fake.sessions.size, 1);
  });

  test("names must be identifiers, and tools must execute", () => {
    assert.throws(() => createSubmilliTools({ blueprint: "b", token: "t", ptc: { "not-a-name": lookup } }), /identifier/);
    const inert = createTool({ id: "inert", description: "No execute." });
    assert.throws(() => createSubmilliTools({ blueprint: "b", token: "t", ptc: { inert } }), /no execute/);
  });
});

describe("approvals", () => {
  test("onApprovalRequired decides while the program waits", async () => {
    const asked: unknown[] = [];
    const { fake, model, agent } = app(
      {
        ptc: { lookup, refund },
        onApprovalRequired: (request) => {
          asked.push(request);
          return { approved: false, reason: "too much" };
        },
      },
      [[execute("refunds")], "done"],
    );
    fake.programs.set("refunds", [
      ["lookup", { id: 2 }],
      ["refund", { id: 2, amount: 40 }],
    ]);
    await agent.generate("go", { memory: THREAD });
    assert.equal(asked.length, 1);
    assert.deepEqual((asked[0] as { input: unknown }).input, { id: 2, amount: 40 });
    const output = shown(model) as { tool_calls: unknown[]; error: { kind: string } };
    assert.equal(output.error.kind, "permission_denied");
    assert.deepEqual(output.tool_calls[1], { tool: "refund", args: { id: 2, amount: 40 }, outcome: "denied", decision: "denied" });
    assert.match(model.description(EXECUTE) ?? "", /refusal throws `PermissionDeniedError`/);
  });

  test("requireToolApproval gates calls as Mastra does for the model's own", async () => {
    const asked: string[] = [];
    const { fake, agent } = app(
      {
        ptc: { lookup },
        requireToolApproval: ({ args }) => (args as { id: number }).id === 2,
        onApprovalRequired: ({ input }) => {
          asked.push(JSON.stringify(input));
          return "approved";
        },
      },
      [[execute("two")], "done"],
    );
    fake.programs.set("two", [
      ["lookup", { id: 1 }],
      ["lookup", { id: 2 }],
    ]);
    await agent.generate("go", { memory: THREAD });
    assert.deepEqual(asked, ['{"id":2}']);
  });

  test("through Mastra's suspend: the agent run suspends, and a resume approves and finishes", async () => {
    refunds.length = 0;
    const { fake, model, agent } = app({ ptc: { lookup, refund } }, [[execute("refunds", "toolu_r")], "refunded"]);
    fake.programs.set("refunds", [
      ["lookup", { id: 2 }],
      ["refund", { id: 2, amount: 40 }],
    ]);
    const first = await agent.generate("refund order 2", { memory: THREAD });
    assert.equal(first.finishReason, "suspended");
    const suspended = first.suspendPayload as { toolCallId: string; toolName: string; suspendPayload: ApprovalPayload };
    assert.equal(suspended.toolName, EXECUTE);
    assert.equal(suspended.toolCallId, "toolu_r");
    assert.deepEqual(suspended.suspendPayload.calls, [{ tool: "refund", args: { id: 2, amount: 40 } }]);
    assert.deepEqual(
      suspended.suspendPayload.tool_calls?.map(({ call_id: _id, ...record }) => record),
      [{ tool: "lookup", args: { id: 2 }, outcome: "ok" }],
    );
    assert.equal(refunds.length, 0);

    const resumed = await agent.resumeGenerate(
      { approved: true },
      { runId: first.runId, toolCallId: suspended.toolCallId, memory: THREAD },
    );
    assert.equal(resumed.text, "refunded");
    assert.deepEqual(refunds, [{ id: 2, amount: 40 }]);
    const output = shown(model) as { result: string; tool_calls: unknown[] };
    assert.equal(output.result, JSON.stringify([{ id: 2, status: "pending" }, { refunded: 2, amount: 40 }]));
    assert.deepEqual(output.tool_calls, [
      { tool: "lookup", args: { id: 2 }, outcome: "ok" },
      { tool: "refund", args: { id: 2, amount: 40 }, outcome: "ok", decision: "approved" },
    ]);
    assert.equal(fake.calls("POST", /\/execute$/).length, 1, "the resume runs no new program");
    const memory = await agent.getMemory();
    const thread = await memory!.getThreadById({ threadId: "t1" });
    assert.equal((thread?.metadata?.submilli as { waiting?: unknown }).waiting, undefined);
  });

  test("a refusal with a reason reaches the program", async () => {
    refunds.length = 0;
    const { fake, model, agent } = app({ ptc: { refund } }, [[execute("refund")], "not refunded"]);
    fake.programs.set("refund", [["refund", { id: 2, amount: 40 }]]);
    const first = await agent.generate("go", { memory: THREAD });
    await agent.resumeGenerate({ approved: false, reason: "over the limit" }, { runId: first.runId, memory: THREAD });
    assert.equal(refunds.length, 0);
    const answers = [...fake.suspended.values()][0]?.answers as { error: { kind: string; message: string } }[];
    assert.deepEqual(answers[0]?.error, { kind: "denied", message: "A person refused this call: over the limit" });
    const output = shown(model) as { tool_calls: unknown[] };
    assert.deepEqual(output.tool_calls, [{ tool: "refund", args: { id: 2, amount: 40 }, outcome: "denied", decision: "denied" }]);
  });

  test("a second gated call suspends the agent run again", async () => {
    refunds.length = 0;
    const { fake, agent } = app({ ptc: { refund } }, [[execute("two")], "done"]);
    fake.programs.set("two", [
      ["refund", { id: 1, amount: 10 }],
      ["refund", { id: 2, amount: 20 }],
    ]);
    const first = await agent.generate("go", { memory: THREAD });
    const second = await agent.resumeGenerate({ approved: true }, { runId: first.runId, memory: THREAD });
    assert.equal(second.finishReason, "suspended");
    assert.deepEqual((second.suspendPayload as { suspendPayload: ApprovalPayload }).suspendPayload.calls, [
      { tool: "refund", args: { id: 2, amount: 20 } },
    ]);
    const done = await agent.resumeGenerate({ approved: true }, { runId: first.runId, memory: THREAD });
    assert.equal(done.text, "done");
    assert.deepEqual(refunds, [
      { id: 1, amount: 10 },
      { id: 2, amount: 20 },
    ]);
  });

  test("a run left waiting is refused when the thread moves on", async () => {
    refunds.length = 0;
    const { fake, model, agent } = app({ ptc: { refund } }, [[execute("refund")], [execute("next")], "moved on"]);
    fake.programs.set("refund", [["refund", { id: 2, amount: 40 }]]);
    const first = await agent.generate("refund it", { memory: THREAD });
    assert.equal(first.finishReason, "suspended");
    await agent.generate("never mind, do something else", { memory: THREAD });
    const [waiting] = fake.suspended.values();
    assert.match((waiting?.answers[0] as { error: { message: string } }).error.message, /moved on/);
    assert.equal(waiting?.finished?.status, "finished");
    assert.equal(refunds.length, 0);
    assert.equal(shown(model).result, "ok");
  });

  test("last_run on a thread that moved on shows the refused program", async () => {
    refunds.length = 0;
    const { fake, model, agent } = app({ ptc: { refund } }, [
      [execute("refund")],
      [call("submilli__typescript__last_run", {})],
      "moved on",
    ]);
    fake.programs.set("refund", [["refund", { id: 2, amount: 40 }]]);
    await agent.generate("refund it", { memory: THREAD });
    await agent.generate("what happened?", { memory: THREAD });
    const [waiting] = fake.suspended.values();
    assert.equal(waiting?.finished?.status, "finished");
    assert.match(JSON.stringify(shown(model)), /permission_denied/);
    assert.equal(refunds.length, 0);
  });

  test("a resume in another process uses the thread's stored session", async () => {
    refunds.length = 0;
    const storage = new InMemoryStore();
    const { fake, client, agent } = app({ ptc: { refund } }, [[execute("refund")]], { storage });
    fake.programs.set("refund", [["refund", { id: 2, amount: 40 }]]);
    const first = await agent.generate("go", { memory: THREAD });
    // Another instance: its own toolset and agent, the same storage and server.
    const other = createSubmilliTools({ client, blueprint: "research", variables: { userId: "u_ada" }, ptc: { refund } });
    const model = new Scripted("refunded");
    const elsewhere = mastraAgent(model, () => other.tools(), storage);
    const resumed = await elsewhere.resumeGenerate({ approved: true }, { runId: first.runId, memory: THREAD });
    assert.equal(resumed.text, "refunded");
    assert.deepEqual(refunds, [{ id: 2, amount: 40 }]);
    assert.equal(fake.sessions.size, 1);
  });

  test("a resume whose calls the run no longer waits on answers nothing", async () => {
    const { fake, model, agent } = app({ ptc: { refund } }, [[execute("refund")], "stale"]);
    fake.programs.set("refund", [["refund", { id: 2, amount: 40 }]]);
    const first = await agent.generate("go", { memory: THREAD });
    const [run] = fake.suspended.values();
    run!.answers.push({ call_id: `${run!.id}:1`, ok: false, error: { kind: "timeout", message: "timed out" } });
    await agent.resumeGenerate({ approved: true }, { runId: first.runId, memory: THREAD });
    assert.equal((shown(model).error as { kind: string }).kind, "approval_stale");
  });

  test("without a way to suspend or ask, a gated call is refused", async () => {
    const fake = new FakeServer();
    const tools = await createSubmilliTools({
      client: new Submilli({ baseURL: SERVER, token: TOKEN, fetch: fake.fetch }),
      blueprint: "research",
      variables: { userId: "u_ada" },
      ptc: { refund },
    }).tools();
    fake.programs.set("refund", [["refund", { id: 2, amount: 40 }]]);
    const output = (await tools.submilli__typescript__execute.execute!({ code: "refund" }, {
      requestContext: new RequestContext(),
    } as never)) as ExecuteOutput;
    assert.match(String((output.error as { message: string }).message), /PermissionDeniedError/);
  });
});
