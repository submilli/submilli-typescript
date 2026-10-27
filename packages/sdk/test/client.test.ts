import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AuthenticationError,
  BadRequestError,
  IdempotencyError,
  idempotencyKey,
  inlineRefs,
  NotFoundError,
  RunStateError,
  ServiceUnavailableError,
  SessionRequiresSecretsError,
  Submilli,
  UnknownBlueprintError,
  UnknownRunError,
  UnknownSessionError,
} from "../src/index.ts";
import { FakeServer, SERVER, TOKEN } from "./fake-server.ts";

function setup(options: { token?: string; maxRetries?: number } = {}): { fake: FakeServer; client: Submilli } {
  const fake = new FakeServer();
  const client = new Submilli({ baseURL: SERVER, token: options.token ?? TOKEN, fetch: fake.fetch, ...options });
  return { fake, client };
}

describe("sessions", () => {
  test("open, execute with a key, last run, delete", async () => {
    const { fake, client } = setup();
    const session = await client.sessions.create("research", { variables: { userId: "u_ada" } });
    assert.deepEqual(session.warnings, []);
    const state = await client.sessions.execute(session.id, "function main() {}", { idempotencyKey: "call-1" });
    assert.equal(state.status, "finished");
    assert.equal(state.status === "finished" && state.result, "ok");
    const [request] = fake.calls("POST", /\/execute$/);
    assert.equal(request?.headers.get("idempotency-key"), "call-1");
    assert.equal(request?.headers.get("user-agent")?.startsWith("submilli-typescript/"), true);
    const last = await client.sessions.lastRun(session.id);
    assert.equal(last?.result, "ok");
    assert.equal(await client.sessions.delete(session.id), true);
    assert.equal(await client.sessions.delete(session.id), false);
    assert.equal(await client.sessions.lastRun(session.id), undefined);
  });

  test("the same key replays the run instead of running it again", async () => {
    const { fake, client } = setup();
    const session = await client.sessions.create("research", { variables: { userId: "u_ada" } });
    await client.sessions.execute(session.id, "a", { idempotencyKey: "k" });
    await client.sessions.execute(session.id, "a", { idempotencyKey: "k" });
    assert.equal(fake.totalRuns(), 1);
    await assert.rejects(client.sessions.execute(session.id, "b", { idempotencyKey: "k" }), (error) => {
      assert.ok(error instanceof IdempotencyError);
      assert.equal(error.code, "idempotency_conflict");
      assert.equal(error.detail, "different code");
      return true;
    });
  });

  test("refusals are typed", async () => {
    const { fake, client } = setup();
    await assert.rejects(client.sessions.create("nope", { variables: { userId: "u" } }), UnknownBlueprintError);
    await assert.rejects(client.sessions.create("research"), (error) => {
      assert.ok(error instanceof BadRequestError);
      assert.match(error.message, /required variable 'userId'/);
      return true;
    });
    await assert.rejects(client.sessions.execute("gone", "x"), (error) => {
      assert.ok(error instanceof UnknownSessionError);
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.status, 404);
      return true;
    });
    const session = await client.sessions.create("research", { variables: { userId: "u" } });
    fake.requiredSecrets = ["API_KEY"];
    fake.lostSecrets.add(session.id);
    await assert.rejects(client.sessions.execute(session.id, "x"), (error) => {
      assert.ok(error instanceof SessionRequiresSecretsError);
      assert.deepEqual(error.required, ["API_KEY"]);
      return true;
    });
    await client.sessions.rebind(session.id, { API_KEY: "k" });
    assert.equal((await client.sessions.execute(session.id, "x")).status, "finished");
    await assert.rejects(client.runs.retrieve("nope"), UnknownRunError);
  });

  test("an unknown token is an AuthenticationError", async () => {
    const { client } = setup({ token: "wrong" });
    await assert.rejects(client.blueprints.prompt("research"), AuthenticationError);
  });

  test("a durable run with no result throws RunStateError", async () => {
    const { fake, client } = setup();
    const session = await client.sessions.create("research", { variables: { userId: "u" } });
    fake.refuseNext.push([200, { status: "stuck", execution_id: "r1", reason: "credentials_unavailable" }]);
    await assert.rejects(client.sessions.execute(session.id, "x"), (error) => {
      assert.ok(error instanceof RunStateError);
      assert.equal(error.status, "stuck");
      assert.equal(error.reason, "credentials_unavailable");
      assert.match(error.message, /recover/);
      return true;
    });
  });
});

describe("retries", () => {
  test("reads are retried after a 503", async () => {
    const { fake, client } = setup();
    fake.unavailable = 2;
    const prompt = await client.blueprints.prompt("research");
    assert.equal(prompt.name, "research");
    assert.equal(fake.requests.length, 3);
  });

  test("an execute without a key is not retried", async () => {
    const { fake, client } = setup();
    const session = await client.sessions.create("research", { variables: { userId: "u" } });
    fake.unavailable = 1;
    await assert.rejects(client.sessions.execute(session.id, "x"), ServiceUnavailableError);
    fake.unavailable = 1;
    const state = await client.sessions.execute(session.id, "x", { idempotencyKey: "k" });
    assert.equal(state.status, "finished");
  });

  test("an aborted request is not retried", async () => {
    const { fake, client } = setup();
    fake.unavailable = 5;
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await assert.rejects(client.blueprints.prompt("research", { signal: controller.signal }), /stop/);
  });
});

describe("discovery", () => {
  test("blueprint and session discovery", async () => {
    const { client } = setup();
    assert.equal((await client.blueprints.prompt("research")).tools.last_run, "The last run.");
    const found = await client.blueprints.searchPackages("research", "jina");
    assert.ok(Array.isArray(found.results));
    assert.deepEqual(await client.blueprints.packageDocs("research", "@submilli/jina"), {
      found: true,
      text: "# jina\nfunction searchJson(): string;",
    });
    const unknown = await client.blueprints.packageDocs("research", "@nope");
    assert.equal(unknown.found, false);
    assert.match(unknown.text, /unknown package/);
    await assert.rejects(client.blueprints.packageDocs("other", "@nope"), UnknownBlueprintError);
    assert.deepEqual((await client.blueprints.builtins("research")).types, ["Map"]);
    const docs = await client.blueprints.builtinDocs("research", ["Map", "Temporal"]);
    assert.equal((docs.results as unknown[]).length, 2);
    const session = await client.sessions.create("research", {
      variables: { userId: "u" },
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
    });
    const tools = await client.sessions.packageDocs(session.id, "@tools");
    assert.match(tools.text, /function lookup/);
  });

  test("a one-off execute reports an unknown Blueprint as the result's error", async () => {
    const { client } = setup();
    const result = await client.execute("nope", "x", { variables: { userId: "u" } });
    assert.equal(result.error?.kind, "blueprint_not_found");
  });
});

describe("helpers", () => {
  test("idempotencyKey keeps short ASCII ids and hashes the rest", async () => {
    assert.equal(await idempotencyKey("toolu_01ABC"), "toolu_01ABC");
    const long = await idempotencyKey("x".repeat(121));
    assert.match(long, /^[0-9a-f]{64}$/);
    assert.equal(await idempotencyKey("x".repeat(121)), long);
    assert.match(await idempotencyKey("ünïcode"), /^[0-9a-f]{64}$/);
    assert.match(await idempotencyKey(""), /^[0-9a-f]{64}$/);
  });

  test("inlineRefs inlines local references and stops at recursion", () => {
    const schema = {
      type: "object",
      properties: { a: { $ref: "#/$defs/A" }, self: { $ref: "#" }, old: { $ref: "#/definitions/B" } },
      $defs: { A: { type: "object", properties: { next: { $ref: "#/$defs/A" } } } },
      definitions: { B: { type: "string" } },
    };
    assert.deepEqual(inlineRefs(schema), {
      type: "object",
      properties: {
        a: { type: "object", properties: { next: {} } },
        self: {},
        old: { type: "string" },
      },
    });
  });

  test("environment variables configure the client", () => {
    process.env.SUBMILLI_SERVER = "http://example.test:9/";
    try {
      assert.equal(new Submilli().baseURL, "http://example.test:9");
    } finally {
      delete process.env.SUBMILLI_SERVER;
    }
    assert.throws(() => new Submilli({ maxRetries: -1 }), RangeError);
  });
});
