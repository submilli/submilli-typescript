# @submilli/ai-sdk

[Submilli](https://github.com/submilli/submilli-runtime) is a dedicated secure runtime for
code-mode agents, with built-in isolation, governance, and permissions.

`@submilli/ai-sdk` is the integration for the [Vercel AI SDK](https://ai-sdk.dev). Your agent
writes TypeScript programs, and submilli-server runs them under a Blueprint's policy, as the
user your application names. Programs can also call your existing AI SDK tools.

## Install

Node.js 22 or later, AI SDK 7, and submilli-server 0.4.1 or later are required.

```sh
npm install @submilli/ai-sdk ai
```

To get a server and register a Blueprint, see
[Get a server](https://github.com/submilli/submilli-typescript/tree/main/packages/sdk#get-a-server).
[Connect Vercel AI SDK](https://submilli.ai/docs/tutorials/connect-vercel-ai-sdk/) walks through
a complete setup.

## Quick start

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { submilliTools } from "@submilli/ai-sdk";
import { generateText, isStepCount } from "ai";

// Once per request: the user comes from your own sign-in.
const submilli = await submilliTools({
  blueprint: "research",
  conversationId: chat.id,
  variables: { userId: user.id },
});

const { text } = await generateText({
  model: anthropic("claude-sonnet-5"),
  tools: submilli.tools,
  messages,
  stopWhen: isStepCount(20),
});

// When the conversation is over, not after every request:
await submilli.close();
```

`submilli.tools` works with `generateText`, `streamText`, and agents built on them. The server
URL and token come from `$SUBMILLI_SERVER` and `$SUBMILLI_SERVER_TOKEN`, or from `baseURL` and
`token`.

## Reference

```ts
submilliTools({
  blueprint,
  conversationId,
  variables,
  secrets,
  client,
  baseURL,
  token,
  store,
  ptc,
  toolApproval,
  onApprovalRequired,
}): Promise<SubmilliTools>
```

| Option | Contract |
| --- | --- |
| `blueprint` | Name of a Blueprint already [registered on the server](https://submilli.ai/docs/server/register-a-blueprint/); used for every program |
| `conversationId` | Your id for the conversation, such as a chat id. Requests with the same id share one session. Without it, the session belongs to this `SubmilliTools` alone |
| `variables` | The Blueprint's variables, as strings, from your application's state. The model never sees or sets them |
| `secrets` | The Blueprint's `harness` secrets. Sent when a session opens, never stored |
| `client` | An existing `Submilli` from `@submilli/sdk`; replaces `baseURL` and `token` |
| `baseURL`, `token` | The server; default `$SUBMILLI_SERVER` (then `http://127.0.0.1:8128`) and `$SUBMILLI_SERVER_TOKEN` |
| `store` | Where each conversation's session id is kept between requests. Default: this process's memory |
| `ptc` | Your AI SDK tools that programs may call through the `@tools` Package |
| `toolApproval` | Per `ptc` tool, whether a program's call needs approval, in the AI SDK's `toolApproval` shape |
| `onApprovalRequired` | Decides approvals in your code while the program waits, instead of through the AI SDK's approval flow |

The model gets the server's six tools, with the Blueprint's descriptions:

| Tool | Does |
| --- | --- |
| `submilli__typescript__execute` | Runs a program |
| `submilli__typescript__last_run` | Returns the conversation's last run and full console |
| `submilli__typescript__packages__search` | Searches Packages available to the program |
| `submilli__typescript__packages__docs` | Returns a Package's documentation and declarations |
| `submilli__typescript__builtins__list` | Lists built-ins available without an import |
| `submilli__typescript__builtins__docs` | Returns declarations for selected built-ins |

With approvals through the AI SDK's flow, there is a seventh, `submilli__typescript__resume`.

`SubmilliTools` also has `conversationId`, `session()`, which returns the conversation's stored
session, and `close()`, which ends it.

## Sessions, retries, and results

- **One session per conversation.** The first program opens a Submilli session, and the
  conversation's later requests find it in `store` by `conversationId`. The default store is
  in memory, so it is shared by requests to the same process. For several processes or
  serverless functions, implement `SessionStore` (`get`, `set`, `delete`) over your database or
  cache. A lost entry costs only a new session.
- **Variables are fixed when the session opens.** A request for the same conversation with
  different variables throws `SubmilliSessionMismatchError` from `submilliTools`, before the
  model is called.
- **Secrets** are sent when a session opens and are never stored. End the session before using
  rotated secrets.
- **Idempotency.** Each execute sends an `Idempotency-Key` derived from the AI SDK's
  `toolCallId`. A repeated call replays the recorded result. Conflicts and incomplete,
  in-progress, or unavailable replays come back to the model as errors, without running the
  program again.
- **Ended sessions.** When the server no longer knows a session, a new one is opened, and the
  model is told that files outside persistent volumes are gone. If a restarted server asks for
  the session's secrets, they are rebound once.
- **Durable runs.** On a server with durable execution, a queued run is waited for. A run that
  stops without a result, such as one that is stuck or cancelled, comes back to the model as an
  error with the run's `status` and `reason`.
- **Results.** The execute tool returns `result`, `console`, `error`, and `denied`. A denial
  adds a `note` that tells the model the denial is final. The output also carries
  `execution_id`, `session_id`, and `tool_calls` (each call to your tools, with its outcome),
  which link the step to the server's audit trail. The model is not shown those three.
- **Errors that are yours throw; errors that are the model's are results.** A wrong token, an
  unknown Blueprint, invalid variables, and an unreachable server throw. Program failures,
  denials, and idempotency refusals are tool results.

Submilli enforces the Blueprint only for code that runs through Submilli. Other tools you give
the model keep their own permission boundaries.

## Your tools in programs

Pass your AI SDK tools as `ptc` (programmatic tool calling), and programs can call them through
the `@tools` Package. A program can combine calls, loop over results, and branch, in one run:

```ts
const lookupOrder = tool({
  description: "Look up an order.",
  inputSchema: z.object({ id: z.number() }),
  outputSchema: z.object({ id: z.number(), status: z.string() }),
  execute: async ({ id }) => orders.get(id),
});

const submilli = await submilliTools({ blueprint: "shop", conversationId, variables, ptc: { lookupOrder } });
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
- Each call runs here, with the AI SDK's execution options (`messages`, `abortSignal`,
  `context`) and the server's call id as `toolCallId`. Input is validated against the tool's
  schema first. A tool that throws makes the program's call throw an `Error`, which the program
  may catch.
- Programs see the input schema as the argument type and `outputSchema` as the return type.
  Without an `outputSchema`, the result is `unknown`. A tool with an empty input object is called
  as `tools.name()`.
- `ptc` tools are not given to the model. If you also give them to the model, its direct calls
  bypass the Blueprint.
- A session keeps the tool catalog it opened with. A conversation whose `ptc` changed opens a
  new session on its next program.

**Tool callers.** The execute tool is also an AI SDK
[tool caller](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling). Tools that
`experimental_toolCallers` routes to it become `@tools` too, alongside `ptc`:

```ts
await generateText({
  model,
  tools: { ...submilli.tools, lookupOrder },
  experimental_toolCallers: { lookupOrder: ["submilli__typescript__execute"] },
  messages,
});
```

## Approvals

A call to one of your tools can wait for a person's approval. Mark it the way the AI SDK does,
with `needsApproval` on the tool, or with `toolApproval`, which takes precedence:

```ts
const submilli = await submilliTools({
  blueprint: "shop",
  conversationId,
  variables,
  ptc: { lookupOrder, refund },
  toolApproval: {
    refund: (input) => ((input as { amount: number }).amount > 20 ? "user-approval" : "approved"),
  },
});
```

A status of `"denied"` refuses the call without asking. A refused call throws
`PermissionDeniedError` in the program, which may catch it.

**Through the AI SDK's approval flow** (the default). The program pauses on the server, and the
execute tool returns `awaiting_approval`. The model then calls `submilli__typescript__resume`,
which needs approval, so the AI SDK ends the step with a `tool-approval-request` whose input
lists the waiting calls. Your UI shows it as it shows any other approval. Send the person's
`tool-approval-response` with the next request, and the program carries on with the call
approved or refused. On approval, the resume tool returns the program's result; on refusal, the
model is told to read `submilli__typescript__last_run`, which shows how the program ended.

The run waits on the server up to the Blueprint's `tool_call_timeout` (10 minutes by default).
The AI SDK takes a `tool-approval-response` only at the end of the messages, and rejects a
request that leaves the resume call without a result (`MissingToolResultsError`). So when the
person moves on without deciding, put a refusal in the resume call's place before their next
message:

```ts
{
  role: "tool",
  content: [{
    type: "tool-result",
    toolCallId: request.toolCall.toolCallId,
    toolName: "submilli__typescript__resume",
    output: { type: "execution-denied", reason: "The person moved on without deciding." },
  }],
}
```

The waiting calls are then refused, with that reason, before the next program runs. The same
happens if the model runs another program instead of resuming.

**In your code.** Pass `onApprovalRequired`, and approvals are decided while the program waits,
with no model round trip:

```ts
onApprovalRequired: async ({ toolName, input }) =>
  (await askReviewer(toolName, input)) ? "approved" : { approved: false, reason: "over the limit" },
```

A tool routed through `experimental_toolCallers` that needs approval is refused unless
`onApprovalRequired` is given.

## Submilli documentation

- [Install the CLI and server](https://submilli.ai/docs/install/)
- [Create and register a Blueprint](https://submilli.ai/docs/blueprints/start-a-blueprint/)
- [Configure permissions](https://submilli.ai/docs/reference/permissions/)
- [Run the server](https://submilli.ai/docs/server/run-the-server/)
- [Inspect the audit trail](https://submilli.ai/docs/reference/audit-trail/)
- [HTTP API reference](https://submilli.ai/docs/reference/http-api)

## Development

This package lives in the [submilli-typescript](https://github.com/submilli/submilli-typescript)
workspace. See the repository README for setup, checks, and releases.

```sh
npm test                                              # unit tests; the HTTP API is faked
SUBMILLI_BIN=/path/to/bin npm run test:integration    # starts its own submilli-server
```

The tests use a scripted model and need no model provider key.
[examples/research](examples/research) is the research agent from the Submilli tutorials.
Implementation notes are in [NOTES.md](NOTES.md).

## License

Apache-2.0.
