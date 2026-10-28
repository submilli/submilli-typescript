import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Submilli, SubmilliError, toolResult, UnknownRunError, type PendingCall } from "../src/index.ts";
import { FakeServer, SERVER, TOKEN } from "./fake-server.ts";

const TOOLS = [{ name: "lookup", input_schema: { type: "object" } }];

async function setup(): Promise<{ fake: FakeServer; client: Submilli; session: string }> {
  const fake = new FakeServer();
  const client = new Submilli({ baseURL: SERVER, token: TOKEN, fetch: fake.fetch });
  const { id } = await client.sessions.create("research", { variables: { userId: "u" }, tools: TOOLS });
  return { fake, client, session: id };
}

describe("application tools", () => {
  test("run answers each call and finishes", async () => {
    const { fake, client, session } = await setup();
    fake.programs.set("two", [
      ["lookup", { id: 1 }],
      ["lookup", { id: 2 }],
    ]);
    const seen: PendingCall[] = [];
    const result = await client.sessions.run(session, "two", {
      idempotencyKey: "k",
      onToolCall: (call) => {
        seen.push(call);
        return toolResult.success(call.callId, { id: call.args.id, name: `order ${String(call.args.id)}` });
      },
    });
    assert.deepEqual(
      seen.map((call) => call.args),
      [{ id: 1 }, { id: 2 }],
    );
    assert.equal(result.error, null);
    assert.deepEqual(JSON.parse(result.result ?? ""), [
      { id: 1, name: "order 1" },
      { id: 2, name: "order 2" },
    ]);
  });

  test("a denial reaches the program as PermissionDeniedError", async () => {
    const { fake, client, session } = await setup();
    fake.programs.set("one", [["lookup", {}]]);
    const result = await client.sessions.run(session, "one", {
      onToolCall: (call) => toolResult.denied(call.callId, "the user said no"),
    });
    assert.equal(result.denied, true);
    assert.equal(result.error?.source, "harness");
  });

  test("a throw leaves the run waiting, and the same key picks it up", async () => {
    const { fake, client, session } = await setup();
    fake.programs.set("two", [
      ["lookup", { id: 1 }],
      ["lookup", { id: 2 }],
    ]);
    let calls = 0;
    await assert.rejects(
      client.sessions.run(session, "two", {
        idempotencyKey: "k",
        onToolCall: (call) => {
          calls += 1;
          if (call.args.id === 2) throw new Error("ask a person first");
          return toolResult.success(call.callId, "one");
        },
      }),
      /ask a person first/,
    );
    const result = await client.sessions.run(session, "two", {
      idempotencyKey: "k",
      onToolCall: (call) => {
        calls += 1;
        return toolResult.success(call.callId, call.args.id === 2 ? "two" : "again");
      },
    });
    assert.equal(calls, 3);
    assert.deepEqual(JSON.parse(result.result ?? ""), ["one", "two"]);
    assert.equal(fake.totalRuns(), 1);
  });

  test("a run that calls a tool without a handler is an error", async () => {
    const { fake, client, session } = await setup();
    fake.programs.set("one", [["lookup", {}]]);
    await assert.rejects(client.sessions.run(session, "one"), (error) => {
      assert.ok(error instanceof SubmilliError);
      assert.match(error.message, /no onToolCall/);
      return true;
    });
  });

  test("a handler must answer the call it was given", async () => {
    const { fake, client, session } = await setup();
    fake.programs.set("one", [["lookup", {}]]);
    await assert.rejects(
      client.sessions.run(session, "one", { onToolCall: () => toolResult.success("other", 1) }),
      /must return a ToolResult/,
    );
  });

  test("a run the server lost is UnknownRunError", async () => {
    const { fake, client, session } = await setup();
    fake.programs.set("one", [["lookup", {}]]);
    await assert.rejects(
      client.sessions.run(session, "one", {
        onToolCall: (call) => {
          fake.suspended.clear();
          return toolResult.success(call.callId, 1);
        },
      }),
      UnknownRunError,
    );
  });

  test("a running run is polled until it finishes", async () => {
    const { fake, client, session } = await setup();
    fake.programs.set("one", [["lookup", {}]]);
    const state = await client.sessions.execute(session, "one");
    assert.equal(state.status, "suspended");
    const result = await client.runs.complete(
      { status: "running", executionId: state.executionId, sessionId: session },
      { pollInterval: 1, onToolCall: (call) => toolResult.success(call.callId, 7) },
    );
    assert.equal(result.result, "[7]");
  });

  test("resume needs at least one result", async () => {
    const { client } = await setup();
    await assert.rejects(client.runs.resume("r", []), RangeError);
  });
});
