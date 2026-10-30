# @submilli/mastra

[Submilli](https://github.com/submilli/submilli-runtime) is a dedicated secure runtime for
code-mode agents, with built-in isolation, governance, and permissions.

`@submilli/mastra` is the integration for [Mastra](https://mastra.ai) agents. Your agent writes
TypeScript programs, and submilli-server runs them under a Blueprint's policy, as the user who
owns the memory thread. Programs can also call your existing Mastra tools, and a call that needs
a person's approval suspends the agent run the way Mastra's own approvals do.

## Install

Node.js 22 or later, `@mastra/core` 1.79 or later, and submilli-server 0.4.1 or later are
required.

```sh
npm install @submilli/mastra @mastra/core
```

To get a server and register a Blueprint, see
[Get a server](https://github.com/submilli/submilli-typescript/tree/main/packages/sdk#get-a-server).
[Connect Mastra](https://submilli.ai/docs/tutorials/connect-mastra/) walks through a complete
setup.

## Quick start

```ts
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { createSubmilliTools } from "@submilli/mastra";

// Once per process. The user comes from each agent run's memory resource.
const submilli = createSubmilliTools({
  blueprint: "research",
  variables: ({ resourceId }) => ({ userId: resourceId! }),
});

export const researcher = new Agent({
  id: "researcher",
  name: "Researcher",
  instructions: "...",
  model: "anthropic/claude-sonnet-5",
  memory: new Memory(),
  tools: () => submilli.tools(),
});

// Register the agent with a Mastra instance that has storage, then, per request:
const { text } = await researcher.generate(question, {
  memory: { thread: chat.id, resource: user.id },
});

// When the thread is deleted or archived, not after every run:
await submilli.close({ threadId: chat.id, memory: await researcher.getMemory() });
```

`submilli.tools()` works as the agent's `tools` (it resolves them per run), or spread into a
tool set of your own: `tools: async () => ({ ...(await submilli.tools()), search })`. The server
URL and token come from `$SUBMILLI_SERVER` and `$SUBMILLI_SERVER_TOKEN`, or from `baseURL` and
`token`.

## Reference

```ts
createSubmilliTools({
  blueprint,
  variables,
  secrets,
  client,
  baseURL,
  token,
  store,
  ptc,
  requireToolApproval,
  onApprovalRequired,
}): SubmilliTools
```

| Option | Contract |
| --- | --- |
| `blueprint` | Name of a Blueprint already [registered on the server](https://submilli.ai/docs/server/register-a-blueprint/); used for every program |
| `variables` | The Blueprint's variables, as strings: fixed, or a function of the agent run's `{ requestContext, resourceId, threadId }`. The model never sees or sets them |
| `secrets` | The Blueprint's `harness` secrets, given the same way. Sent when a session opens, never stored |
| `client` | An existing `Submilli` from `@submilli/sdk`; replaces `baseURL` and `token` |
| `baseURL`, `token` | The server; default `$SUBMILLI_SERVER` (then `http://127.0.0.1:8128`) and `$SUBMILLI_SERVER_TOKEN` |
| `store` | Where each thread's session is kept. Default: the thread's metadata in the agent's memory |
| `ptc` | Your Mastra tools that programs may call through the `@tools` Package |
| `requireToolApproval` | Which `ptc` calls need a person's approval, as Mastra's `requireToolApproval`: `true`, or a function of `{ toolName, args, requestContext }` |
| `onApprovalRequired` | Decides approvals in your code while the program waits, instead of suspending the agent run |

The model gets the server's six tools, with the Blueprint's descriptions:

| Tool | Does |
| --- | --- |
| `submilli__typescript__execute` | Runs a program |
| `submilli__typescript__last_run` | Returns the thread's last run and full console |
| `submilli__typescript__packages__search` | Searches Packages available to the program |
| `submilli__typescript__packages__docs` | Returns a Package's documentation and declarations |
| `submilli__typescript__builtins__list` | Lists built-ins available without an import |
| `submilli__typescript__builtins__docs` | Returns declarations for selected built-ins |

`SubmilliTools` also has `session({ threadId, memory })`, which returns the thread's stored
session, and `close({ threadId, memory })`, which ends it.

## Sessions, retries, and results

- **One session per memory thread.** The first program on a thread opens a Submilli session,
  and the thread's later agent runs find it again. It is kept in the thread's metadata, under
  `submilli`, so it survives restarts and is shared by every instance on the same storage.
  Pass `store` to keep it elsewhere. An agent run without a memory thread gets a session of its
  own.
- **Variables are fixed when the session opens.** An agent run on the same thread with different
  variables gets a `SubmilliSessionMismatchError` as the tool's error, and nothing runs. Bind
  variables to something the thread belongs to, such as its resource.
- **Secrets** are sent when a session opens and are never stored. End the session before using
  rotated secrets.
- **Idempotency.** Each execute sends an `Idempotency-Key` derived from Mastra's `toolCallId`. A
  repeated call replays the recorded result. Conflicts and incomplete, in-progress, or
  unavailable replays come back to the model as errors, without running the program again.
- **Ended sessions.** When the server no longer knows a session, a new one is opened, and the
  model is told that files outside persistent volumes are gone. If a restarted server asks for
  the session's secrets, they are rebound once.
- **Results.** The execute tool returns `result`, `console`, `error`, and `denied`. A denial
  adds a `note` that tells the model the denial is final. `tool_calls` lists each call to your
  tools with its arguments and outcome. The output also carries `execution_id`, `session_id`,
  and each call's `call_id`, which link the step to the server's audit trail; the model is not
  shown them (`toModelOutput`), but they are in `toolResults` and in memory.
- **Errors that are yours throw; errors that are the model's are results.** A wrong token, an
  unknown Blueprint, invalid variables, and an unreachable server throw, and Mastra reports them
  to the model as tool errors. Program failures, denials, and idempotency refusals are results.

Submilli enforces the Blueprint only for code that runs through Submilli. Other tools you give
the agent keep their own permission boundaries.

## Your tools in programs

Pass your Mastra tools as `ptc` (programmatic tool calling), and programs can call them through
the `@tools` Package. A program can combine calls, loop over results, and branch, in one run:

```ts
const lookupOrder = createTool({
  id: "lookupOrder",
  description: "Look up an order.",
  inputSchema: z.object({ id: z.number() }),
  outputSchema: z.object({ id: z.number(), status: z.string() }),
  execute: async ({ id }) => orders.get(id),
});

const submilli = createSubmilliTools({ blueprint: "shop", variables, ptc: { lookupOrder } });
```

```ts
import tools from "@tools";

function main(): string {
    return tools.lookupOrder({ id: 1 }).status;
}
```

- In the Blueprint, grant [`tools.call`](https://submilli.ai/docs/reference/http-api#application-tools)
  with a filter for each tool name. A call the Blueprint refuses fails with `permission_denied`,
  and your tool never sees it.
- Each call runs here, with the execute tool's Mastra context: the same `requestContext`,
  `mastra`, `abortSignal`, thread and resource, and the server's call id as the agent's
  `toolCallId`. Input is validated against the tool's schema first. A tool that throws, or whose
  output fails its `outputSchema`, makes the program's call throw an `Error`, which the program
  may catch.
- Programs see the input schema as the argument type and `outputSchema` as the return type.
  Without an `outputSchema`, the result is `unknown`.
- A tool that calls `suspend()` cannot be used from a program: the call fails. Give such tools
  to the agent directly.
- `ptc` tools are not given to the model. If you also give them to the agent, its direct calls
  bypass the Blueprint.
- A session keeps the tool catalog it opened with. A thread whose `ptc` changed opens a new
  session on its next program.

## Approvals

A program's call to one of your tools can wait for a person's approval. Mark it the way Mastra
does for the model's own calls: `requireApproval` on the tool (`true`, or a function of its
input), or `requireToolApproval` for every `ptc` tool. A tool's `requireApproval` function
decides alone, as in Mastra.

By default the execute tool **suspends the agent run** while the program waits. `generate()`
returns `finishReason: "suspended"`, and the stream emits `tool-call-suspended`, with a
`suspendPayload` that shows the person exactly what they decide on:

```ts
const output = await agent.generate("Refund order 2", { memory });
if (output.finishReason === "suspended") {
  const { toolCallId, suspendPayload } = output.suspendPayload;
  // suspendPayload: { execution_id, calls: [{ tool: "refund", args: { id: 2, amount: 40 } }], tool_calls }
  const approved = await askThePerson(suspendPayload.calls);
  const result = await agent.resumeGenerate(
    approved ? { approved: true } : { approved: false, reason: "Over the limit" },
    { runId: output.runId, toolCallId, memory },
  );
}
```

- On approval, the call runs and the program carries on; the model sees the program's result,
  with no extra model step. A later call that also needs approval suspends the run again.
- On refusal, the program's call throws `PermissionDeniedError` with the person's reason, and
  the program decides what to do.
- The resume can happen in another process or after a restart: Mastra keeps the suspended run in
  storage (find it with `agent.listSuspendedRuns({ threadId, resourceId })`), and the program
  waits on the server in the thread's session.
- If the thread moves on instead (a new message, not a resume), the next program or `last_run`
  on the thread refuses the waiting call first, so it does not hang until the Blueprint's
  `tool_call_timeout`.
- Resume data is `{ approved, reason? }`. Mastra's `approveToolCall()` is for `requireApproval`
  on the model's own tool calls; for programs, use `resumeGenerate` or `resumeStream`.

`onApprovalRequired` decides in your code instead, while the program waits on the server, without
suspending the agent run:

```ts
const submilli = createSubmilliTools({
  blueprint: "shop",
  variables,
  ptc: { lookupOrder, refund },
  onApprovalRequired: async ({ toolName, input }) => (await policy.allows(toolName, input) ? "approved" : "denied"),
});
```

Without either (a tool call that runs outside an agent or a workflow), a call that needs
approval is refused.

Approval waits are held in the server's memory for up to the Blueprint's `tool_call_timeout`
(10 minutes by default). For approvals that take longer, raise it. Without durable execution, a
server restart loses a waiting run, and the resume reports `run_lost`.

## Example

[`examples/research`](examples/research) is the research agent from submilli-runtime's harness
tutorials, with a check that runs it against a local server with a scripted model.

## License

[Apache License 2.0](LICENSE).
