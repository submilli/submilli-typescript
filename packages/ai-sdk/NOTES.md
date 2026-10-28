# Notes

These are the decisions SUB-2050 left open, and what in submilli-runtime got in the way. The
packages were built and tested against submilli-server built from submilli-runtime `77d6a85`
(after 0.4.3), with AI SDK 7.0.154 and zod 4. They follow `langchain-submilli` and the
Python `submilli` SDK where the AI SDK allows, so the two families behave alike; where they
differ, it says why below.

## Two packages

`@submilli/sdk` knows the HTTP API and nothing about the AI SDK, so other harnesses (Claude
Agent SDK, Mastra) can build on it. It has no dependencies: `fetch` and WebCrypto are all it
needs, so it runs on Node 22+, Deno, Bun, and edge runtimes. `@submilli/ai-sdk` depends on it
and has `ai@^7` as a peer dependency. Both live in one npm workspace, so a change that spans
both is one pull request, and are released on their own tags.

- **Source and build.** The sources are TypeScript that Node runs as is (erasable syntax only,
  `.ts` imports rewritten on build). `isolatedDeclarations` keeps the published declarations
  readable. Each package's `exports` has a `submilli-source` condition that points at
  `src/`; the tests and the example run with `--conditions=submilli-source`, so they need no
  build. Published consumers never set it.
- **ESM only.** The AI SDK 7 is ESM only, and Node 22+ can `require()` ESM.
- **`exactOptionalPropertyTypes`** is on for the SDK and off for `@submilli/ai-sdk`, whose AI
  SDK types are not written for it.

## The SDK

It is a port of the Python `submilli` SDK, with the same names in camelCase.

- **Methods.** `sessions` (`create`, `execute`, `run`, `rebind`, `lastRun`, `delete`,
  `searchPackages`, `packageDocs`), `runs` (`resume`, `retrieve`, `complete`), `blueprints`
  (`prompt`, `searchPackages`, `packageDocs`, `builtins`, `builtinDocs`), and `execute` for
  one-off runs. There is no sync client: JavaScript has no use for one.
- **Results, not exceptions,** for what a program did: a failed or denied program is an
  `ExecuteResult`. What the harness did wrong throws, as a typed `SubmilliError`. Errors are
  classes, so `instanceof` works across the hierarchy (`UnknownSessionError` is a
  `NotFoundError` is an `APIStatusError`).
- **`runs.complete`** drives a run with `onToolCall`. A throw from it propagates and leaves the
  run waiting on the server, which is what a harness needs to pause for a person. It polls
  `running` and `queued` runs with backoff, rereads the run on `run_not_suspended` and
  `unknown_call`, and resends an earlier answer when recovery exposes the same call id again
  instead of running the tool twice.
- **Idempotency keys** are the id itself when it is printable ASCII of at most 120 bytes,
  otherwise its sha256 hex. `idempotencyKey` is async because WebCrypto is.
- **Retries** only for requests that are safe to repeat, on connection errors and 502/503/504,
  honoring `Retry-After`. The default timeout is 330 s, because an execute may wait 300 s for
  an earlier attempt with the same key. Every method takes an `AbortSignal`.
- **`inlineRefs`** inlines local `$ref`s (`#/$defs`, `#/definitions`), because the server's
  mapper does not resolve them. A recursive reference, and `#`, become `{}`.

## The AI SDK integration

### The entry point

`submilliTools(options)` is async and returns `{ tools, conversationId, session(), close() }`.

- **Per request, not per process.** The AI SDK has no agent object that outlives a request
  with a per-conversation context, so the variables (the signed-in user) come with each call
  to `submilliTools`, as they do in a route handler. Building it is cheap: the Blueprint
  prompt is cached per client for five minutes, and the session opens only when the first
  program runs.
- **Async.** It reads the stored session to refuse a mismatched binding before any model call,
  and fetches the Blueprint's prompt so the tools carry the server's descriptions from the
  first step. The AI SDK reads a tool's description when the step starts, so they cannot be
  filled in later, as `langchain-submilli` does in `awrap_model_call`.
- **Tool names** are the server's own (`submilli__typescript__execute` and the rest): the
  server's responses refer to its tools by these names.

### Sessions

- **Keyed by an application-supplied conversation id.** AI SDK messages carry no thread id and
  no state channel, so the application names the conversation. A `SessionStore` (`get`, `set`,
  `delete`, sync or async) maps it to `{id, server, blueprint, variables, tools}`. The default
  is one in-memory LRU store per process (10 000 conversations), which is right for a single
  Node server; serverless and multi-instance deployments pass their own. Without a
  `conversationId`, the session belongs to that `SubmilliTools` alone.
- **Variables are stored, secrets are not.** A mismatch is an exact comparison of variables,
  and throws `SubmilliSessionMismatchError` naming the variables, not their values.
- **A session keeps its tool catalog.** The store holds a sha256 of the declared tools, and a
  conversation whose catalog changed opens a new session. The old one is left to its idle
  timeout.
- **Replacement.** On `unknown session`, a new session is opened once per call, under a
  per-conversation lock, so parallel calls that all find it gone open one replacement between
  them. The model is told files outside persistent volumes are gone. On
  `session_requires_secrets`, the secrets are rebound once.
- **Closing** is explicit: `close()` deletes the session and forgets it. Nothing closes a
  session per request, because the next request of the conversation needs it.

### Results

- **The output carries ids; the model doesn't see them.** The execute tool returns `result`,
  `console`, `error`, `denied`, the notes, and `execution_id`, `session_id`, and `tool_calls`.
  `toModelOutput` strips the two ids and each call's `call_id`, while `steps[].toolResults`
  keep the audit links for the application. LangChain has an artifact for this; the AI SDK
  has `toModelOutput`.
- **The model sees the program's calls to `ptc` tools** (tool, args, outcome, decision). In a
  live run without them, a program refused partway through left the model unable to say which
  refunds had gone through. The list shows nothing the program could not log itself, and the
  Blueprint and approvals still decide each call before it runs.
- Idempotency refusals, lost runs, and durable runs that stop without a result are results for
  the model, with text that says what is known about the effects, as in `langchain-submilli`.

### Application tools (`ptc`)

- **The option is `ptc`**, as in `langchain-submilli` and `@ai-sdk/code-mode`, and takes AI SDK
  `tool()`s. Their `inputSchema` and `outputSchema` go through `asSchema`, so zod, Standard
  Schema, and `jsonSchema()` all work. The `$schema` key is dropped and refs are inlined.
- **Running a call.** The input is validated with the tool's schema; a mismatch is a `failed`
  answer the program can catch, as is a tool that throws. The tool runs with the execute
  call's own `ToolExecutionOptions` (`messages`, `abortSignal`, `context`), with the server's
  call id as `toolCallId`. A streaming tool's last value is its result, as for the model. The
  output goes through a JSON round trip, so a `Date` or a class instance reaches the program
  as the model would see it.
- **Tool callers.** AI SDK 7's `experimental_toolCallers` lets a generation route tools to a
  caller, which hides them from the model. The execute tool is a local tool caller whose
  `bind` adds the routed tools to `ptc`. So an application can keep its tool set and route
  some tools into code mode per call. Routed tools do not carry `toolApproval` entries, which
  must name `ptc` tools.
- **The execute tool's description** lists the tool names and how refusals surface, on top of
  the Blueprint's prompt, which already explains `@tools` in general.
- **Discovery** goes through the session when there are application tools, so `@tools` docs
  are included, and then opens it. Without them it uses the Blueprint endpoints and opens
  nothing.

### Approvals

This is the part with the most design.

The AI SDK asks for approval per model tool call: a tool with `needsApproval` (or a
generation-level `toolApproval` status of `user-approval`) ends the step with a
`tool-approval-request`; the application sends back a `tool-approval-response` with the next
request, and the approved call runs at the start of the next `generateText`. A program's call
to an application tool is not a model tool call, so it cannot go through that flow directly.
`@ai-sdk/code-mode` has the same problem and offers two modes, an approval callback and an
interrupt; this package offers the same two.

- **The shape of the setting** is the AI SDK's: a tool's own `needsApproval`, or a
  `toolApproval` record with a status or a function of the input. `toolApproval` wins,
  because it is the newer, per-generation API (tool-level `needsApproval` is deprecated in
  AI SDK 7 but still works). `denied` refuses without asking; `approved` and
  `not-applicable` run the tool.
- **`onApprovalRequired`** decides in the application while the program waits on the server.
  No model round trip; the right choice for a reviewer queue, a policy service, or a UI that
  can block on a push notification.
- **Through the AI SDK's flow** (no callback): the gated call stops the drive loop. The run
  waits on the server, and the execute tool returns `awaiting_approval` with a `resume_input`
  (`execution_id` and the waiting calls, each `tool` and `args`) and a note. The calls carry no
  server call ids: a live gpt-6-luna run copied one back with a mangled UUID, which would have
  made the person's approval `approval_stale`. Calls match by position, tool, and arguments,
  which is what the person approves. The model calls
  `submilli__typescript__resume` with it. That tool has `needsApproval: true`, so the AI SDK
  puts it to the person, and its input shows them exactly which calls with which arguments.
  On approval, the resume tool checks the run still waits on those same calls (otherwise
  `approval_stale`, and nothing is answered), runs them, and drives the run to its end. On
  refusal, nothing runs at that point: the AI SDK reports the denial to the model.
- **Why a model round trip.** It costs one extra model step per approval. The alternative was
  to make the execute tool itself need approval when the program might call a gated tool, but
  that is decided before the program runs, so the person would approve code, not a call with
  its arguments; and many programs call no gated tool at all.
- **Reconciliation.** A run left waiting (the person refused, or the conversation moved on)
  would hold its call until `tool_call_timeout`, then throw `TimeoutError` in the program,
  which carries on unobserved. So before the next execute, each run the conversation's
  messages show waiting is answered `denied`, with the person's reason when they gave one,
  and driven to its end. Other calls the program makes on the way are answered normally.
  `last_run` first sends the refusals a person gave (not the unanswered calls: the model may
  still be about to resume them), so after a refusal it shows how that program ended. Without
  this, a live model that checked `last_run` after a refusal was shown an older run, and then
  re-ran the whole task, asking again for a refund that had already gone through. The resume
  tool's description tells the model to check `last_run` after a refusal.
- **A person who moves on.** The AI SDK converts a `tool-approval-response` only when it ends
  the messages; with a user message after it, the resume call has no result and the request
  fails with `MissingToolResultsError`. So the application puts a `tool-result` with
  `execution-denied` in the resume call's place, and reconciliation reads its reason as the
  person's refusal.
  Measured on the real server: a waiting run does not block other programs in the session,
  so this is about a deterministic outcome, not liveness.
- **Bypass protection.** If a generation-level `toolApproval` function approves the resume
  tool without asking, the resume tool finds no approval in the messages and throws: an
  application-level mistake, not a model one.
- **Across processes.** The resume can land in another process (another request, another
  instance). It uses the conversation's stored session, not the catalog of that request, and
  verifies the run belongs to it. Only `ptc` tools can be resumed there; routed tools exist
  only in the generation that routed them, so a routed tool that needs approval is refused
  unless `onApprovalRequired` is given.
- **Durable runs.** Without durable execution, a server restart loses a waiting run; resume
  then returns `run_lost`. With it, the wait survives restarts.

## Tests

- **Unit tests** run against `FakeServer`, a `fetch` that implements the HTTP API in memory,
  ported from the Python fake. The AI SDK tests drive `generateText` with a scripted
  `MockLanguageModelV4` from `ai/test`, so they exercise the real tool loop, approval parts,
  and `toModelOutput`.
- **Integration tests** start their own `submilli-server` from `$SUBMILLI_BIN` or `PATH`, with
  a fresh home, a random token, and a free port, and register their Blueprints over the admin
  API, so the CLI is not needed. The AI SDK tests cover per-user notes and session reuse, a
  failing program, a compile error and the last run, `ptc` with typed results, a tool the Blueprint does not grant (`permission_denied` with
  `source: policy`; the application never sees the call), tool callers, `onApprovalRequired`,
  an approval through the AI SDK flow across two requests with a new `SubmilliTools` each, and
  a refused approval reconciled before the next program.
- **The example** (`examples/research`) is checked against a server started by
  `scripts/test-server.sh` with the `research` Blueprint.

## What in submilli-runtime got in the way

Nothing new that needed a runtime change. The gaps `langchain-submilli` filed apply here
unchanged:

- SUB-1686: HTTP execute can't carry the tool call id into the run record; the
  `Idempotency-Key` is the only link, and it is hashed when the id is long.
- SUB-1687: a replayed response is not marked, so the model can't be told nothing ran this
  time.
- SUB-1688: some errors are prose (`unknown session`, `invalid variables: ...`), so the client
  matches strings.
- SUB-1689: `execution_id` on refusals is undocumented.
- SUB-1690: `GET last-run` answers the same `404` for an unknown session and for one with no
  run.
- SUB-1692: `SUBMILLI_SERVER_URL` and `SUBMILLI_SERVER` name the same thing.
- SUB-1693: the HTTP API has no file endpoints, so there are no file tools.

Seen while building this, and already tracked or by design:

- **Approval waits are held in memory** for up to `tool_call_timeout` (10 minutes by default)
  and count against `max_suspended_runs`. For human approvals that take longer, raise the
  Blueprint's timeout; SUB-2037 would release the instance while a durable run waits.
- **A tool whose input schema has no properties** is a zero-argument function in programs
  (`tools.name()`), and `tools.name({})` does not compile. That is intended for genuinely
  empty inputs; SUB-1025 tracks the related case of root schemas without direct properties.
- **`GET /v1/runs` filters by `session`**, not `session_id`, which every other body calls it.
