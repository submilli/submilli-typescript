import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ConflictError, Submilli, toolResult, UnknownSessionError, type PendingCall } from "../../src/index.ts";
import { ManagedServer, skip } from "./server.ts";

const BLUEPRINT = `kind: blueprint
name: shop
variables:
  userId:
    required: true
secrets:
  USER_TOKEN:
    harness:
      required: true
vfs:
  mode: per_session
default: deny
permissions:
  main:
  - {capability: fs.read, action: allow}
  - {capability: fs.write, action: allow}
  - {capability: fs.stat, action: allow}
  - capability: tools.call
    filter: tool == "query_orders"
    action: allow
`;

const ORDERS = {
  name: "query_orders",
  description: "Orders of one customer.",
  input_schema: { type: "object", properties: { customer: { type: "string" } }, required: ["customer"] },
  output_schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
};
const REFUND = { name: "refund", input_schema: { type: "object", properties: { order: { type: "string" } } } };

const COUNTER = `
import fs from "submilli:fs";

function main(): string {
    const before = fs.exists("n.txt") ? (fs.readText("n.txt") ?? "") : "";
    fs.writeText("n.txt", before + "x");
    return \`\${before.length + 1}\`;
}
`;

const ORDERS_PROGRAM = `
import tools from "@tools";

function main(): string {
    const orders = tools.query_orders({ customer: "c_42" });
    return \`\${orders.count} orders\`;
}
`;

const REFUND_PROGRAM = `
import tools from "@tools";

function main(): string {
    tools.refund({ order: "o_1" });
    return "refunded";
}
`;

const USER = { userId: "u_ada" };
const SECRETS = { USER_TOKEN: "tok" };

describe("against submilli-server", { skip }, () => {
  let server: ManagedServer;
  let client: Submilli;

  before(async () => {
    server = await ManagedServer.start();
    await server.apply("shop", BLUEPRINT);
    client = new Submilli({ baseURL: server.url, token: server.token });
  });

  after(async () => {
    await server?.stop();
  });

  test("a session keeps state, and a key runs once", async () => {
    const session = await client.sessions.create("shop", { variables: USER, secrets: SECRETS });
    const first = await client.sessions.run(session.id, COUNTER, { idempotencyKey: "call-1" });
    const replay = await client.sessions.run(session.id, COUNTER, { idempotencyKey: "call-1" });
    const second = await client.sessions.run(session.id, COUNTER, { idempotencyKey: "call-2" });
    assert.deepEqual([first.result, replay.result, second.result], ["1", "1", "2"]);
    assert.equal(replay.executionId, first.executionId);
    assert.equal((await client.sessions.lastRun(session.id))?.result, "2");
    assert.equal(await client.sessions.delete(session.id), true);
    await assert.rejects(client.sessions.execute(session.id, COUNTER), UnknownSessionError);
  });

  test("a program calls the application's tool", async () => {
    const session = await client.sessions.create("shop", { variables: USER, secrets: SECRETS, tools: [ORDERS, REFUND] });
    assert.deepEqual(session.warnings, [
      "@tools: 1 tool(s) return unknown: result schemas are unavailable or unrepresentable; " +
        "consult package docs for signatures",
    ]);
    const calls: PendingCall[] = [];
    const result = await client.sessions.run(session.id, ORDERS_PROGRAM, {
      onToolCall: (call) => {
        calls.push(call);
        return toolResult.success(call.callId, { count: 3 });
      },
    });
    assert.equal(result.error, null);
    assert.equal(result.result, "3 orders");
    assert.deepEqual(
      calls.map((call) => [call.tool, call.args]),
      [["query_orders", { customer: "c_42" }]],
    );
    const docs = await client.sessions.packageDocs(session.id, "@tools");
    assert.ok(docs.found);
    assert.match(docs.text, /query_orders\(args: \{ customer: string \}\): \{ count: number \}/);
  });

  test("the Blueprint refuses tools it does not grant", async () => {
    const session = await client.sessions.create("shop", { variables: USER, secrets: SECRETS, tools: [ORDERS, REFUND] });
    const result = await client.sessions.run(session.id, REFUND_PROGRAM, {
      onToolCall: () => assert.fail("the application never sees a refused call"),
    });
    assert.equal(result.denied, true);
    assert.equal(result.error?.source, "policy");
  });

  test("a denied answer is a harness denial", async () => {
    const session = await client.sessions.create("shop", { variables: USER, secrets: SECRETS, tools: [ORDERS] });
    const result = await client.sessions.run(session.id, ORDERS_PROGRAM, {
      onToolCall: (call) => toolResult.denied(call.callId, "not today"),
    });
    assert.equal(result.denied, true);
    assert.equal(result.error?.source, "harness");
    assert.match(result.error?.message ?? "", /not today/);
  });

  test("a suspended run resumes by key", async () => {
    const session = await client.sessions.create("shop", { variables: USER, secrets: SECRETS, tools: [ORDERS] });
    const state = await client.sessions.execute(session.id, ORDERS_PROGRAM, { idempotencyKey: "k" });
    assert.equal(state.status, "suspended");
    const again = await client.sessions.execute(session.id, ORDERS_PROGRAM, { idempotencyKey: "k" });
    assert.deepEqual(again, state);
    assert.deepEqual(await client.runs.retrieve(state.executionId), state);
    const done = await client.runs.complete(again, { onToolCall: (call) => toolResult.success(call.callId, { count: 7 }) });
    assert.equal(done.result, "7 orders");
  });

  test("discovery and one-off runs", async () => {
    const prompt = await client.blueprints.prompt("shop");
    assert.equal(prompt.name, "shop");
    assert.ok("last_run" in prompt.tools);
    assert.ok("namespaces" in (await client.blueprints.builtins("shop")));
    const once = await client.execute("shop", 'export function main(): string { return "hi"; }', {
      variables: USER,
      secrets: SECRETS,
    });
    assert.equal(once.result, "hi", JSON.stringify(once.error));
    const missing = await client.execute("nope", "export function main(): number { return 1; }");
    assert.equal(missing.error?.kind, "blueprint_not_found");
  });

  test("a session and its secrets survive a restart", async () => {
    const session = await client.sessions.create("shop", { variables: USER, secrets: SECRETS });
    await client.sessions.run(session.id, COUNTER);
    await server.restart();
    assert.equal((await client.sessions.run(session.id, COUNTER)).result, "2");
  });

  test("secrets sealed with another key are refused", async () => {
    const session = await client.sessions.create("shop", { variables: USER, secrets: SECRETS });
    await server.stop();
    server.rotateStoreKey();
    await server.start();
    await assert.rejects(client.sessions.run(session.id, COUNTER), (error) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /session secrets/);
      return true;
    });
  });
});
