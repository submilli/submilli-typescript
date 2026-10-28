# @submilli/sdk

The TypeScript SDK for [submilli-server](https://github.com/submilli/submilli-runtime). It runs
TypeScript programs under a Blueprint's policy, on behalf of a user, from any JavaScript
harness: an agent framework, a job queue, or a script.

```sh
npm install @submilli/sdk
```

It needs Node.js 22 or later (or any runtime with `fetch` and WebCrypto) and submilli-server
0.4.1 or later. It has no dependencies. For the Vercel AI SDK,
[`@submilli/ai-sdk`](https://github.com/submilli/submilli-typescript/tree/main/packages/ai-sdk)
builds on it.

## Get a server

The installer puts `submilli`, the CLI, and `submilli-server` on your `PATH`. Start the
server with a token:

```sh
curl -fsSL https://submilli.ai/install.sh | sh     # macOS and Linux; Windows: irm https://submilli.ai/install.ps1 | iex
export SUBMILLI_SERVER_TOKEN=$(openssl rand -hex 32)
submilli-server &                                  # listens on 127.0.0.1:8128
```

Then register a Blueprint, the policy programs run under. This one allows only computation and
declares the `userId` variable:

```yaml
# blueprint.yaml
kind: blueprint
name: hello
variables:
  userId:
    required: true
default: deny
```

```sh
submilli server blueprint apply blueprint.yaml
```

[Install](https://submilli.ai/docs/install/), [Run the server](https://submilli.ai/docs/server/run-the-server/),
and [Register a Blueprint](https://submilli.ai/docs/server/register-a-blueprint/) cover the
details, and the [Blueprint file reference](https://submilli.ai/docs/reference/blueprint-file/)
lists what a Blueprint can grant: HTTP, files, secrets, model calls, and your own tools.

## Quick start

```ts
import { Submilli } from "@submilli/sdk";

const PROGRAM = `
export function main(): string {
    return \`\${1 + 1}\`;
}
`;

const client = new Submilli();
const session = await client.sessions.create("hello", { variables: { userId: "u_ada" } });
const result = await client.sessions.run(session.id, PROGRAM, { idempotencyKey: "call-1" });
console.log(result.result); // "2"
```

The client reads the server's URL from `$SUBMILLI_SERVER` (default `http://127.0.0.1:8128`) and
its API token from `$SUBMILLI_SERVER_TOKEN`, or from `baseURL` and `token`.

`client.execute(blueprint, code, { variables })` runs one program in a session that ends when it
returns.

## Sessions

A session binds a Blueprint to one user's variables and harness secrets. Programs in it run one
after another and share its files.

```ts
const session = await client.sessions.create("research", {
  variables: { userId: "u_ada" },
  secrets: { GITHUB_TOKEN: token }, // the Blueprint's `harness` secrets
});
const state = await client.sessions.execute(session.id, code, { idempotencyKey: callId });
await client.sessions.rebind(session.id, { GITHUB_TOKEN: newToken });
const last = await client.sessions.lastRun(session.id); // the full console, or undefined
await client.sessions.delete(session.id);
```

**Results, not exceptions.** A program that fails or is denied is a result:

```ts
const result = await client.sessions.run(session.id, code);
if (result.denied) {
  console.log(result.error?.capability, result.error?.source); // e.g. "http.get", "policy"
} else if (result.error) {
  console.log(result.error.kind, result.error.message); // e.g. "compile_error"
} else {
  console.log(result.result, result.console);
}
```

**Durable runs.** On a server with `durable_execution`, an execute still queued or working after
the server's wait answers a `RunningRun`, which `sessions.run` and `runs.complete` poll. A run
that stops without a result, such as one that is `stuck` or `cancelled`, throws `RunStateError`.
Pass a `signal` to give the wait a deadline. `sessions.execute`, `runs.retrieve`, and
`runs.resume` return the current state; use `sessions.run` or `runs.complete` to wait for the
end.

**Idempotency.** Pass an `idempotencyKey` with every execute that may be retried. When the same
request reaches the server twice, the program runs once and the retry gets the recorded result.
`await idempotencyKey(callId)` turns any id, such as a model's tool call id, into a key the
server accepts: the id itself when it is short printable ASCII, otherwise its sha256.

## Your tools in programs

A session can declare the application's own tools. Programs import them as `@tools`, typed from
their schemas, and the server checks each call against the Blueprint's `tools.call` capability:

```ts
import { toolResult, type PendingCall, type ToolDeclaration } from "@submilli/sdk";

const QUERY_ORDERS: ToolDeclaration = {
  name: "query_orders",
  description: "Orders of one customer.",
  input_schema: { type: "object", properties: { customer: { type: "string" } }, required: ["customer"] },
  output_schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
};

async function answer(call: PendingCall) {
  const orders = await db.orders(call.args.customer as string);
  return toolResult.success(call.callId, { count: orders.length });
}

const session = await client.sessions.create("shop", { variables: { userId: "u_ada" }, tools: [QUERY_ORDERS] });
const result = await client.sessions.run(session.id, PROGRAM, { idempotencyKey: "call-1", onToolCall: answer });
```

```ts
import tools from "@tools";

function main(): string {
    return `${tools.query_orders({ customer: "c_42" }).count} orders`;
}
```

- **The loop.** Each call stops the run on the server. `sessions.run` hands the call to
  `onToolCall` and resumes the run with the answer, until the program finishes. The time a run
  waits doesn't count against its time limit.
- **Answers.** `toolResult.success(callId, value)` returns `value` to the program.
  `toolResult.failed(callId, message)` throws `Error` there. `toolResult.denied(callId,
  message)` throws `PermissionDeniedError`, reported with `source: "harness"`.
- **Pausing.** If `onToolCall` throws, the error propagates and the run keeps waiting on the
  server, up to the Blueprint's `tool_call_timeout`. That is how a harness pauses for a person's
  approval. Executing again with the same `idempotencyKey` answers the run's current state, and
  `sessions.run` carries on from the call it waits on.
- **Declarations.** `session.warnings` lists what programs won't see of the declared tools, such
  as a Blueprint that grants no `tools.call`, or a tool whose result is typed `unknown`. The
  server doesn't resolve `$ref`, so pass generated schemas through `inlineRefs`. A tool whose
  input is an empty object is called as `tools.name()`.
- **Lower level.** `runs.resume`, `runs.retrieve`, and `runs.complete` drive a run yourself.
- **Restarts.** With durable execution enabled, the server recovers suspended runs and
  committed tool answers after a restart, preserving call ids. Without durability, a suspended
  run is lost and resuming it throws `UnknownRunError`.
- **Tool retries.** During one `runs.complete`, a repeated call id reuses the answer already
  produced, including when recovery exposes an uncommitted call again. This cache does not
  survive a process restart. Tools with external side effects should deduplicate by
  `PendingCall.callId` themselves.

## Discovery

What a model needs to write programs for a Blueprint:

```ts
const prompt = await client.blueprints.prompt("research"); // tool descriptions for a model
await client.blueprints.searchPackages("research", "github");
const docs = await client.blueprints.packageDocs("research", "@submilli/jina"); // docs.found, docs.text
await client.blueprints.builtins("research");
await client.blueprints.builtinDocs("research", ["Map", "Temporal"]);
```

`sessions.searchPackages` and `sessions.packageDocs` answer the same for one session, including
its `@tools`.

## Errors

Every error is a `SubmilliError`:

| Error | When |
| --- | --- |
| `APIConnectionError`, `APITimeoutError` | The server couldn't be reached, or didn't answer in time |
| `AuthenticationError` | 401: the token is missing or wrong |
| `UnknownSessionError` | The session ended, usually after its idle timeout. Open a new one |
| `SessionRequiresSecretsError` | The server asks for the session's harness secrets again. `rebind` them; `.required` names them |
| `IdempotencyError` | The server refused the key and ran nothing. `.code` says why |
| `UnknownRunError` | The server no longer holds a suspended run |
| `RunStateError` | The run has no result to return: it is `stuck`, `cancelled`, `aborted` or `indeterminate`, its result expired, or the SDK doesn't know its status. `.status` and `.reason` say which |
| `RunNotSuspendedError`, `UnknownCallError` | A resume that no longer applies. `runs.complete` handles these |
| `UnknownBlueprintError` | No Blueprint of that name |
| `BadRequestError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `ServiceUnavailableError`, `InternalServerError` | Other refusals, by status |

Each `APIStatusError` carries `status`, `body`, the body's `code`, and the `executionId` it
concerns, when there is one.

## Retries and timeouts

A connection failure, or a 502, 503, or 504, is retried up to `maxRetries` times (default 2),
with backoff and the server's `Retry-After`, but only for requests that are safe to repeat:
reads, deletes, rebinds, resumes, and executes that carry an idempotency key. An execute without
a key and `sessions.create` are never retried. The default timeout is 330 seconds, because an
execute may wait up to 300 seconds for an earlier attempt with the same key. Every method takes
a `signal`.

```ts
const client = new Submilli({ timeout: 60_000, maxRetries: 0, fetch: myFetch });
```

## Development

This package lives in the [submilli-typescript](https://github.com/submilli/submilli-typescript)
workspace, next to `@submilli/ai-sdk`. See the repository's README for setup, checks, and
releases. In `packages/sdk`:

```sh
npm test                                              # unit tests, against a fake of the HTTP API
SUBMILLI_BIN=/path/to/bin npm run test:integration    # starts its own submilli-server
```

## License

Apache-2.0.
