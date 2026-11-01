# Notes

These are the decisions SUB-2052 left open, and what in submilli-runtime got in the way. The
package was built and tested against submilli-server 0.5.0, with `@mastra/core` 1.79.0,
`@mastra/memory` 1.39.0, and zod 4. It follows `@submilli/ai-sdk` (see its NOTES.md) wherever
Mastra allows, so the TypeScript packages behave alike; where they differ, it says why below.
The Mastra API names were checked against the docs that `@mastra/core` 1.79 ships in
`dist/docs/`, and against small experiments with a scripted model.

## The entry point

`createSubmilliTools(options)` is synchronous and returns `{ tools(), session(), close() }`.

- **Per process, not per request.** Unlike the AI SDK, Mastra hands every tool call its trusted
  context: the memory thread and resource, the request context, the Mastra instance, the agent's
  memory, and the agent run's id. So one toolset serves every user, and the binding is read per
  call. `variables` and `secrets` are fixed records or functions of
  `{ requestContext, resourceId, threadId }`, which is where Mastra puts the signed-in user
  (`MASTRA_RESOURCE_ID_KEY` pins the resource on Mastra's server).
- **`tools()` is async,** and is the agent's `tools` dynamic argument. It fetches the Blueprint's
  prompt (cached per client for five minutes) so the tools carry the server's descriptions. The
  model reads a description when the run starts, so it cannot be filled in later.
- **Tool names** are the server's own (`submilli__typescript__execute` and the rest), as in
  `@submilli/ai-sdk`.
- **Mastra's own code mode.** `@mastra/core` 1.38 added `createCodeMode()`: the model's program
  runs in a Workspace sandbox (a host `node` process, E2B, or a V8 isolate) and calls Mastra
  tools as `external_*` functions. This package is the governed alternative: programs run on
  submilli-server under a Blueprint (capabilities, per-user volumes, audit), and calls to the
  application's tools go through the Blueprint and approvals. The option keeps the name `ptc`,
  as in `langchain-submilli` and `@submilli/ai-sdk`, rather than Mastra's `tools`.

## Sessions

- **One per memory thread, kept in the thread's metadata.** The default store writes
  `thread.metadata.submilli` through the memory the tool call is given, so the session survives
  restarts and is shared by every instance on the same storage, with no store to configure. It
  holds `{id, server, blueprint, variables, tools}` and the runs waiting on approvals. Storage
  adapters merge metadata on update, so forgetting a session writes `null`, not a missing key.
  The thread must exist; Mastra saves it when a memory-backed run starts.
- **`store`** replaces it, keyed by thread id, as `@submilli/ai-sdk`'s `SessionStore` is keyed by
  conversation id. A run without a memory thread gets a session of its own, in process memory;
  nothing finds it again, so it ends at the server's idle timeout.
- **Mismatched variables** throw `SubmilliSessionMismatchError` from the tool, which Mastra
  reports to the model as a tool error. Mastra has no hook before the model is called that sees
  both the thread and the tools (the `tools` dynamic argument sees the request context only), so
  it cannot be refused earlier, as `@submilli/ai-sdk` does.
- Replacement on `unknown session`, rebinding secrets, the catalog digest, and in-process locks
  are as in `@submilli/ai-sdk`. Threads are built per tool call here, so the replacement map is
  kept per store, with a short TTL.
- **`close({ threadId, memory })`** deletes the session and forgets it. Nothing closes a session
  per run.

## Application tools (`ptc`)

- **Mastra tools** (`createTool`) only, for now. Their schemas go through Mastra's
  `toStandardSchema`, so zod, Standard Schema, and JSON Schema all work; `$schema` is dropped and
  refs are inlined. AI SDK tools, which Mastra agents also accept, are not handled yet.
- **Running a call.** Input is validated against the tool's schema; a mismatch is a `failed`
  answer the program can catch, as is a tool that throws or whose output fails `outputSchema`
  (Mastra returns a `ValidationError` object for that; it does not throw). The tool runs with
  the execute tool's own context: `requestContext`, `mastra`, `memory`, the thread, the resource,
  `abortSignal`, `observe`, with the server's call id as the agent's `toolCallId`. Output goes
  through a JSON round trip.
- **A `ptc` tool cannot suspend.** A program's call cannot wait on Mastra's suspend: the call
  would need the agent run to suspend in the middle of another tool's execution, with the tool's
  own resume schema. Such a call fails, and the README says to give those tools to the agent.

## Approvals

This is where Mastra fits better than the AI SDK.

The AI SDK can only ask for approval of a model tool call, so `@submilli/ai-sdk` needs a
synthetic resume tool and a model round trip per approval. Mastra lets a tool suspend itself
(`context.agent.suspend(payload)`) and resumes the same tool call with `resumeData`, with the
run's state in storage. So the execute tool suspends while the program waits on the server:

- **The setting** is Mastra's: the tool's `requireApproval` (a function decides alone), or
  `requireToolApproval` for every `ptc` tool (`true` or a function of `{toolName, args,
  requestContext}`; a function that throws asks a person, as in Mastra). Mastra's
  `beforeApproval` hook is not run for programs' calls.
- **Suspend payload**: `{execution_id, calls: [{tool, args}], tool_calls}`, with `tool_calls`
  the program's earlier calls, so a UI can show what already happened. No server call ids, for
  the reason `@submilli/ai-sdk` gives. **Resume data**: `{approved, reason?}`, validated by the
  execute tool's `resumeSchema`.
- **On resume** the execute tool is called again with the same input. It does not run the code
  again: it checks that the run still waits on the same calls (otherwise `approval_stale`, and
  nothing is answered), answers them (run them, or refuse with the person's reason), and drives
  the run on. A later gated call suspends again, from the resumed call; the `tool_calls` carried
  in the payload keep the record whole across suspensions.
- **No extra model step**, and the person decides on a call with its arguments, not on code.
  Making the execute tool `requireApproval` would have the person approve a program before it
  runs, without knowing which calls it makes; many programs make none.
- **Across processes.** Mastra keeps suspended runs in storage (`listSuspendedRuns`), and the
  thread's session is in storage too, so the resume can land anywhere. Tested with a second
  toolset, agent, and Mastra instance on the same storage.
- **A thread that moves on.** If the next thing on the thread is a new message rather than a
  resume, the waiting call would hang until `tool_call_timeout`, then throw `TimeoutError` in a
  program nobody watches. So the thread's stored session records each waiting run with the
  Mastra run id that suspended on it, and the next program or `last_run` from another agent run
  refuses it and drives it to its end. A resume of that old agent run then gets
  `approval_stale`. Parallel execute calls of one agent run share its run id, so they never
  refuse each other's waits.
- **`onApprovalRequired`** decides in the application while the program waits, as in
  `@submilli/ai-sdk`. Without it and without a suspend (no agent or workflow context), a gated
  call is refused with a message that says why.

## Shared code

`messages.ts` (tool names, server descriptions, result shapes, and the text the model is told)
is a copy of `@submilli/ai-sdk`'s, without its resume tool. A third harness package should move
it into `@submilli/sdk` (or an internal package) rather than copy it again. The tests reuse the
SDK's `FakeServer` and integration `ManagedServer`, and `@submilli/ai-sdk`'s scripted model:
Mastra runs AI SDK v4-spec models, so `MockLanguageModelV4` drives the real agent loop,
suspension, and memory.

## Tests

- **Unit tests** run real Mastra agents (with `InMemoryStore` and `Memory`) against
  `FakeServer`: descriptions, idempotency keys, denials, discovery, sessions in thread metadata
  and in an explicit store, a run without memory, mismatched variables, parallel calls,
  replaced sessions, lost secrets, idempotency refusals, `ptc` declarations and context, failing
  tools and bad input and output, a `ptc` tool that suspends, `onApprovalRequired`,
  `requireToolApproval`, suspend and resume (approve, refuse with a reason, a second gated
  call, another process, a stale resume), a thread that moves on (next program, and `last_run`),
  and a gated call with no way to ask.
- **Integration tests** start `submilli-server` as `@submilli/ai-sdk`'s do, and cover per-user
  notes and session reuse across agent runs, a failing program and the last run, `ptc` with typed
  results, a tool the Blueprint does not grant, `onApprovalRequired`, an approval through suspend
  and resume in another instance, a refused approval, and a thread that moves on.
- **The example** (`examples/research`) is checked against a server started by
  `scripts/test-server.sh` with the `research` Blueprint.

## What in submilli-runtime got in the way

Nothing new that needed a runtime change. The gaps `langchain-submilli` filed apply unchanged
(SUB-1686 call ids in run records, SUB-1687 replay marking, SUB-1688 prose errors, SUB-1689
`execution_id` on refusals, SUB-1690 `last-run` 404s, SUB-1692 server URL variables, SUB-1693
file endpoints), as do the notes in `@submilli/ai-sdk`'s NOTES.md on approval waits held in
memory (SUB-2037) and empty input schemas (SUB-1025).

## Still to do

- Publish (the `@submilli` npm scope must exist first, and `@submilli/sdk` goes first).
- In submilli-runtime: the Connect Mastra tutorial from MCP to this package (keeping the
  coding-agent prompt), the harness table, and `examples/harnesses/mastra/`.
- AI SDK tools in `ptc`, if users ask: Mastra agents accept them.
- The peer range is `^1.79.0`, the version tested. Older 1.x releases may work.
