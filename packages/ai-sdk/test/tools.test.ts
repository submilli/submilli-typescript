import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateText, isStepCount, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { Submilli } from "@submilli/sdk";
import { FakeServer, SERVER, TOKEN } from "../../sdk/test/fake-server.ts";
import {
  EXECUTE,
  memorySessionStore,
  RESUME,
  submilliTools,
  SubmilliSessionMismatchError,
  type ExecuteOutput,
  type SubmilliToolsOptions,
} from "../src/index.ts";
import { call, execute, Scripted, type Turn } from "./scripted.ts";

function setup(): { fake: FakeServer; client: Submilli } {
  const fake = new FakeServer();
  return { fake, client: new Submilli({ baseURL: SERVER, token: TOKEN, fetch: fake.fetch }) };
}

async function run(
  options: SubmilliToolsOptions,
  turns: Turn[],
  messages: ModelMessage[] = [{ role: "user", content: "go" }],
) {
  const submilli = await submilliTools(options);
  const model = new Scripted(...turns);
  const result = await generateText({ model, tools: submilli.tools, messages, stopWhen: isStepCount(10) });
  return { submilli, model, result, messages: [...messages, ...result.responseMessages] };
}

function outputs(result: { steps: { toolResults: { output: unknown }[] }[] }): ExecuteOutput[] {
  return result.steps.flatMap((step) => step.toolResults.map((part) => part.output as ExecuteOutput));
}

const lookup = tool({
  description: "Look up an order.",
  inputSchema: z.object({ id: z.number() }),
  outputSchema: z.object({ id: z.number(), status: z.string() }),
  execute: async ({ id }) => ({ id, status: id === 1 ? "shipped" : "pending" }),
});

const refund = tool({
  description: "Refund an order.",
  inputSchema: z.object({ id: z.number(), amount: z.number() }),
  execute: async ({ id, amount }) => ({ refunded: id, amount }),
});

describe("tools", () => {
  test("the model gets the server's tools and descriptions, and a program runs", async () => {
    const { fake, client } = setup();
    const { model, result } = await run(
      { client, blueprint: "research", variables: { userId: "u_ada" } },
      [[execute("function main() {}", "toolu_1")], "done"],
    );
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
    const [shown] = model.toolResults();
    assert.deepEqual(shown, { result: "ok", console: [], error: null, denied: false });
    const [output] = outputs(result);
    assert.equal(output?.session_id, [...fake.sessions.keys()][0]);
    assert.ok(output?.execution_id);
    const [request] = fake.calls("POST", /\/execute$/);
    assert.equal(request?.headers.get("idempotency-key"), "toolu_1");
    assert.deepEqual(request?.body, { code: "function main() {}" });
  });

  test("a denial is marked final for the model", async () => {
    const { fake, client } = setup();
    fake.outcome = {
      result: null,
      console: [],
      error: { kind: "permission_denied", message: "denied", capability: "example.com/op", source: "policy" },
    };
    const { model } = await run({ client, blueprint: "research", variables: { userId: "u" } }, [[execute("x")], "done"]);
    const [shown] = model.toolResults() as Record<string, unknown>[];
    assert.equal(shown?.denied, true);
    assert.match(String(shown?.note), /final/);
  });

  test("discovery tools use the Blueprint", async () => {
    const { client } = setup();
    const { model } = await run({ client, blueprint: "research", variables: { userId: "u" } }, [
      [
        call("submilli__typescript__packages__search", { query: "jina" }),
        call("submilli__typescript__packages__docs", { name: "@submilli/jina" }),
        call("submilli__typescript__builtins__list", {}),
        call("submilli__typescript__builtins__docs", { names: ["Map"] }),
        call("submilli__typescript__last_run", {}),
      ],
      "done",
    ]);
    const [search, docs, list, builtins, last] = model.toolResults();
    assert.equal((search as { results: unknown[] }).results.length, 1);
    assert.match(String(docs), /searchJson/);
    assert.deepEqual((list as { types: string[] }).types, ["Map"]);
    assert.equal((builtins as { results: unknown[] }).results.length, 1);
    assert.match(String(last), /No program has run/);
  });
});

describe("sessions", () => {
  test("a conversation keeps its session across requests, and close ends it", async () => {
    const { fake, client } = setup();
    const store = memorySessionStore();
    const options = { client, store, blueprint: "research", conversationId: "chat-1", variables: { userId: "u" } };
    await run(options, [[execute("a")], "done"]);
    const { submilli } = await run(options, [[execute("b")], "done"]);
    assert.equal(fake.sessions.size, 1);
    assert.equal(fake.calls("POST", /^\/v1\/sessions$/).length, 1);
    const stored = await submilli.session();
    assert.equal(stored?.id, [...fake.sessions.keys()][0]);
    assert.equal(await submilli.close(), true);
    assert.equal(fake.sessions.size, 0);
    assert.equal(await submilli.session(), undefined);
    assert.equal(await submilli.close(), false);
  });

  test("another binding on the conversation is refused before the model runs", async () => {
    const { client } = setup();
    const store = memorySessionStore();
    const options = { client, store, blueprint: "research", conversationId: "chat-1" };
    await run({ ...options, variables: { userId: "ada" } }, [[execute("a")], "done"]);
    await assert.rejects(submilliTools({ ...options, variables: { userId: "grace" } }), (error) => {
      assert.ok(error instanceof SubmilliSessionMismatchError);
      assert.match(error.message, /differing: userId/);
      assert.doesNotMatch(error.message, /grace|ada/);
      return true;
    });
  });

  test("parallel calls open one session", async () => {
    const { fake, client } = setup();
    await run({ client, blueprint: "research", variables: { userId: "u" } }, [[execute("a"), execute("b"), execute("c")], "done"]);
    assert.equal(fake.sessions.size, 1);
  });

  test("an ended session is replaced once, and the model is told", async () => {
    const { fake, client } = setup();
    const store = memorySessionStore();
    const options = { client, store, blueprint: "research", conversationId: "chat-1", variables: { userId: "u" } };
    await run(options, [[execute("a")], "done"]);
    fake.sessions.clear();
    const { model } = await run(options, [[execute("b"), execute("c")], "done"]);
    assert.equal(fake.sessions.size, 1);
    for (const shown of model.toolResults() as Record<string, unknown>[]) {
      assert.match(String(shown.notice), /new session was opened/);
    }
    assert.equal((await store.get("chat-1"))?.id, [...fake.sessions.keys()][0]);
  });

  test("lost harness secrets are sent again", async () => {
    const { fake, client } = setup();
    fake.requiredSecrets = ["API_KEY"];
    const options = { client, blueprint: "research", variables: { userId: "u" }, secrets: { API_KEY: "k" } };
    const submilli = await submilliTools(options);
    await generateText({ model: new Scripted([execute("a")], "done"), tools: submilli.tools, prompt: "go", stopWhen: isStepCount(5) });
    const id = (await submilli.session())!.id;
    fake.lostSecrets.add(id);
    const model = new Scripted([execute("b")], "done");
    await generateText({ model, tools: submilli.tools, prompt: "go", stopWhen: isStepCount(5) });
    assert.equal(fake.calls("POST", /\/rebind$/).length, 1);
    assert.equal((model.toolResults()[0] as { result: string }).result, "ok");
  });

  test("an idempotency refusal is explained to the model", async () => {
    const { fake, client } = setup();
    const submilli = await submilliTools({ client, blueprint: "research", variables: { userId: "u" } });
    await generateText({ model: new Scripted([execute("a", "same")], "done"), tools: submilli.tools, prompt: "go", stopWhen: isStepCount(5) });
    const model = new Scripted([execute("b", "same")], "done");
    await generateText({ model, tools: submilli.tools, prompt: "go", stopWhen: isStepCount(5) });
    const [shown] = model.toolResults() as { error: { kind: string; message: string } }[];
    assert.equal(shown?.error.kind, "idempotency_conflict");
    assert.match(shown!.error.message, /Nothing ran/);
    assert.equal(fake.totalRuns(), 1);
  });

  test("an app error is the AI SDK's tool error", async () => {
    const { client } = setup();
    const { model } = await run({ client, blueprint: "research" }, [[execute("a")], "done"]);
    assert.match(JSON.stringify(model.toolResults()), /required variable 'userId'/);
  });
});

describe("application tools", () => {
  test("programs call ptc tools as @tools, declared with their schemas", async () => {
    const { fake, client } = setup();
    fake.programs.set("orders", [
      ["lookup", { id: 1 }],
      ["lookup", { id: 2 }],
    ]);
    const { model, result } = await run(
      { client, blueprint: "research", variables: { userId: "u" }, ptc: { lookup } },
      [[execute("orders")], "done"],
    );
    assert.ok(!model.toolNames().includes("lookup"), "ptc tools are not given to the model");
    assert.ok(!model.toolNames().includes(RESUME));
    assert.match(model.description(EXECUTE) ?? "", /@tools.*`lookup`/s);
    const [session] = fake.sessions.values();
    assert.deepEqual(session?.tools, [
      {
        name: "lookup",
        description: "Look up an order.",
        input_schema: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
          additionalProperties: false,
        },
        output_schema: {
          type: "object",
          properties: { id: { type: "number" }, status: { type: "string" } },
          required: ["id", "status"],
          additionalProperties: false,
        },
      },
    ]);
    const [output] = outputs(result);
    assert.deepEqual(JSON.parse(output?.result ?? ""), [
      { id: 1, status: "shipped" },
      { id: 2, status: "pending" },
    ]);
    assert.deepEqual(
      output?.tool_calls?.map((record) => [record.tool, record.args, record.outcome]),
      [
        ["lookup", { id: 1 }, "ok"],
        ["lookup", { id: 2 }, "ok"],
      ],
    );
  });

  test("a failing tool or bad input fails the program's call", async () => {
    const { fake, client } = setup();
    const broken = tool({
      inputSchema: z.object({ reason: z.string().optional() }),
      execute: async (): Promise<string> => {
        throw new Error("database down");
      },
    });
    fake.programs.set("p", [
      ["broken", {}],
      ["lookup", { id: "not a number" }],
      ["missing", {}],
    ]);
    const { result } = await run(
      { client, blueprint: "research", variables: { userId: "u" }, ptc: { lookup, broken } },
      [[execute("p")], "done"],
    );
    const [output] = outputs(result);
    assert.deepEqual(
      output?.tool_calls?.map((record) => record.outcome),
      ["failed", "failed", "failed"],
    );
    const answers = fake.requests.filter((request) => request.path.endsWith("/resume")).map((request) => request.body);
    assert.match(JSON.stringify(answers), /database down/);
    assert.match(JSON.stringify(answers), /Invalid input for tool 'lookup'/);
    assert.match(JSON.stringify(answers), /no tool named 'missing'/);
  });

  test("with ptc, discovery goes through the session and includes @tools", async () => {
    const { fake, client } = setup();
    const { model } = await run({ client, blueprint: "research", variables: { userId: "u" }, ptc: { lookup } }, [
      [call("submilli__typescript__packages__docs", { name: "@tools" })],
      "done",
    ]);
    assert.match(String(model.toolResults()[0]), /function lookup/);
    assert.equal(fake.calls("GET", /^\/v1\/sessions\/[^/]+\/packages\/docs$/).length, 1);
  });

  test("tools routed by experimental_toolCallers become @tools", async () => {
    const { fake, client } = setup();
    fake.programs.set("orders", [["lookup", { id: 1 }]]);
    const submilli = await submilliTools({ client, blueprint: "research", variables: { userId: "u" } });
    const model = new Scripted([execute("orders")], "done");
    const result = await generateText({
      model,
      tools: { ...submilli.tools, lookup },
      experimental_toolCallers: { lookup: [EXECUTE] },
      prompt: "go",
      stopWhen: isStepCount(5),
    });
    assert.ok(!model.toolNames().includes("lookup"));
    assert.match(model.description(EXECUTE) ?? "", /`lookup`/);
    const [output] = outputs(result);
    assert.deepEqual(JSON.parse(output?.result ?? ""), [{ id: 1, status: "shipped" }]);
    assert.equal([...fake.sessions.values()][0]?.tools[0]?.name, "lookup");
  });

  test("a session keeps its tools: other tools open another session", async () => {
    const { fake, client } = setup();
    const store = memorySessionStore();
    const options = { client, store, blueprint: "research", conversationId: "c", variables: { userId: "u" } };
    await run({ ...options, ptc: { lookup } }, [[execute("a")], "done"]);
    await run({ ...options, ptc: { lookup } }, [[execute("b")], "done"]);
    assert.equal(fake.sessions.size, 1);
    await run({ ...options, ptc: { lookup, refund } }, [[execute("c")], "done"]);
    assert.equal(fake.sessions.size, 2);
  });

  test("names must be identifiers, and tools must execute", async () => {
    const { client } = setup();
    await assert.rejects(submilliTools({ client, blueprint: "research", ptc: { "look-up": lookup } }), /identifier/);
    const noExecute = tool({ inputSchema: z.object({ id: z.number() }), outputSchema: z.object({ ok: z.boolean() }) });
    await assert.rejects(submilliTools({ client, blueprint: "research", ptc: { noExecute } }), /no execute/);
    await assert.rejects(
      submilliTools({ client, blueprint: "research", ptc: { lookup }, toolApproval: { refund: "user-approval" } }),
      /not in ptc/,
    );
  });
});

describe("approvals", () => {
  test("onApprovalRequired decides while the program waits", async () => {
    const { fake, client } = setup();
    fake.programs.set("refunds", [
      ["refund", { id: 1, amount: 10 }],
      ["refund", { id: 2, amount: 50 }],
    ]);
    const asked: unknown[] = [];
    const { result, model } = await run(
      {
        client,
        blueprint: "research",
        variables: { userId: "u" },
        ptc: { refund },
        toolApproval: {
          refund: (input) => ((input as { amount: number }).amount > 25 ? { type: "user-approval", reason: "over $25" } : "approved"),
        },
        onApprovalRequired: (request) => {
          asked.push(request);
          return { approved: false, reason: "too much" };
        },
      },
      [[execute("refunds")], "done"],
    );
    assert.ok(!model.toolNames().includes(RESUME));
    assert.equal(asked.length, 1);
    assert.equal((asked[0] as { reason: string }).reason, "over $25");
    const [output] = outputs(result);
    assert.equal(output?.denied, true);
    assert.deepEqual(
      output?.tool_calls?.map((record) => [record.outcome, record.decision]),
      [
        ["ok", undefined],
        ["denied", "denied"],
      ],
    );
    assert.match(JSON.stringify(fake.requests.at(-1)?.body), /too much/);
  });

  test("a 'denied' status refuses without asking", async () => {
    const { fake, client } = setup();
    fake.programs.set("p", [["refund", { id: 1, amount: 1 }]]);
    const { result } = await run(
      { client, blueprint: "research", variables: { userId: "u" }, ptc: { refund }, toolApproval: { refund: "denied" } },
      [[execute("p")], "done"],
    );
    assert.equal(outputs(result)[0]?.denied, true);
  });

  test("through the AI SDK's approval flow: pause, ask, approve, finish", async () => {
    const { fake, client } = setup();
    fake.programs.set("refunds", [
      ["lookup", { id: 1 }],
      ["refund", { id: 1, amount: 10 }],
    ]);
    const store = memorySessionStore();
    const gated = tool({ ...refund, needsApproval: true });
    const options = {
      client,
      store,
      blueprint: "research",
      conversationId: "chat",
      variables: { userId: "u" },
      ptc: { lookup, refund: gated },
    };
    const ran: unknown[] = [];
    const first = await run(options, [
      [execute("refunds")],
      (prompt) => {
        // The model passes the resume input it was given.
        const shown = JSON.stringify(prompt.prompt);
        assert.match(shown, /awaiting_approval/);
        const waiting = outputsFromPrompt(prompt.prompt);
        return [call(RESUME, waiting.awaiting_approval.resume_input, "resume-1")];
      },
    ]);
    assert.ok(first.model.toolNames().includes(RESUME));
    const paused = outputs(first.result)[0];
    assert.equal(paused?.awaiting_approval?.resume_input.calls[0]?.tool, "refund");
    assert.deepEqual(
      paused?.tool_calls?.map((record) => record.outcome),
      ["ok", "awaiting_approval"],
    );
    // The generation stopped at the approval request for the resume call.
    const approval = first.result.content.find((part) => part.type === "tool-approval-request");
    assert.ok(approval, "the AI SDK asks the person");
    assert.equal(fake.suspended.size, 1);

    // The person approves; the application sends the conversation back.
    const messages: ModelMessage[] = [
      ...first.messages,
      { role: "tool", content: [{ type: "tool-approval-response", approvalId: approval.approvalId, approved: true }] },
    ];
    const gatedSpy = tool({
      ...refund,
      needsApproval: true,
      execute: async (input) => {
        ran.push(input);
        return { refunded: input.id, amount: input.amount };
      },
    });
    const second = await run({ ...options, ptc: { lookup, refund: gatedSpy } }, ["done"], messages);
    assert.deepEqual(ran, [{ id: 1, amount: 10 }]);
    // The approved call runs before the model's next step, which is shown its result.
    const finished = second.model.toolResults().at(-1) as ExecuteOutput;
    assert.deepEqual(JSON.parse(finished?.result ?? ""), [
      { id: 1, status: "shipped" },
      { refunded: 1, amount: 10 },
    ]);
  });

  test("a refused approval refuses the call before the next program runs", async () => {
    const { fake, client } = setup();
    fake.programs.set("refunds", [["refund", { id: 1, amount: 10 }]]);
    const store = memorySessionStore();
    const options = {
      client,
      store,
      blueprint: "research",
      conversationId: "chat",
      variables: { userId: "u" },
      ptc: { refund },
      toolApproval: { refund: "user-approval" as const },
    };
    const first = await run(options, [
      [execute("refunds")],
      (prompt) => [call(RESUME, outputsFromPrompt(prompt.prompt).awaiting_approval.resume_input)],
    ]);
    const approval = first.result.content.find((part) => part.type === "tool-approval-request")!;
    const messages: ModelMessage[] = [
      ...first.messages,
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: approval.approvalId, approved: false, reason: "no" }],
      },
    ];
    const second = await run(options, [[execute("something else")], "done"], messages);
    const run_ = [...fake.suspended.values()][0]!;
    assert.equal(run_.answers[0]?.ok, false);
    assert.match(JSON.stringify(run_.answers[0]), /A person refused this call: no/);
    assert.equal(outputs(second.result).at(-1)?.result, "ok");
  });

  test("a resume whose calls the run no longer waits on answers nothing", async () => {
    const { fake, client } = setup();
    fake.programs.set("refunds", [["refund", { id: 1, amount: 10 }]]);
    const store = memorySessionStore();
    const options = {
      client,
      store,
      blueprint: "research",
      conversationId: "chat",
      variables: { userId: "u" },
      ptc: { refund },
      toolApproval: { refund: "user-approval" as const },
    };
    const first = await run(options, [
      [execute("refunds")],
      (prompt) => {
        const input = outputsFromPrompt(prompt.prompt).awaiting_approval.resume_input;
        return [call(RESUME, { ...input, calls: [{ ...input.calls[0]!, args: { id: 1, amount: 9999 } }] })];
      },
    ]);
    const approval = first.result.content.find((part) => part.type === "tool-approval-request")!;
    const second = await run(options, ["done"], [
      ...first.messages,
      { role: "tool", content: [{ type: "tool-approval-response", approvalId: approval.approvalId, approved: true }] },
    ]);
    const stale = second.model.toolResults().at(-1) as ExecuteOutput;
    assert.equal(stale?.error?.kind, "approval_stale");
    assert.equal([...fake.suspended.values()][0]?.answers.length, 0);
  });

  test("a resume the generation let through without asking is refused", async () => {
    const { fake, client } = setup();
    fake.programs.set("refunds", [["refund", { id: 1, amount: 10 }]]);
    const submilli = await submilliTools({
      client,
      blueprint: "research",
      variables: { userId: "u" },
      ptc: { refund },
      toolApproval: { refund: "user-approval" },
    });
    const model = new Scripted(
      [execute("refunds")],
      (prompt) => [call(RESUME, outputsFromPrompt(prompt.prompt).awaiting_approval.resume_input)],
      "done",
    );
    await generateText({
      model,
      tools: submilli.tools,
      prompt: "go",
      toolApproval: () => "not-applicable",
      stopWhen: isStepCount(5),
    });
    assert.match(JSON.stringify(model.toolResults()), /without a person's approval/);
    assert.equal([...fake.suspended.values()][0]?.answers.length, 0);
  });
});

// The latest execute or resume output the model was shown, in a prompt.
function outputsFromPrompt(prompt: unknown): ExecuteOutput & { awaiting_approval: NonNullable<ExecuteOutput["awaiting_approval"]> } {
  const messages = prompt as { role: string; content: { type: string; output?: { type: string; value: unknown } }[] }[];
  const results = messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .filter((part) => part.type === "tool-result" && part.output?.type === "json")
    .map((part) => part.output!.value as ExecuteOutput);
  return results.at(-1) as ExecuteOutput & { awaiting_approval: NonNullable<ExecuteOutput["awaiting_approval"]> };
}
