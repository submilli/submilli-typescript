# submilli-typescript

[Submilli](https://github.com/submilli/submilli-runtime) is a dedicated secure runtime for
code-mode agents, with built-in isolation, governance, and permissions.

This repository holds the TypeScript packages for it:

| Package | For |
| --- | --- |
| [`@submilli/ai-sdk`](packages/ai-sdk#readme) | The [Vercel AI SDK](https://ai-sdk.dev): lets your agent execute TypeScript code in Submilli's runtime, and call your existing AI SDK tools from it |
| [`@submilli/sdk`](packages/sdk#readme) | Any JavaScript harness: the HTTP API of submilli-server, typed |

[Docs](https://submilli.ai/docs/) ·
[Connect Vercel AI SDK](https://submilli.ai/docs/tutorials/connect-vercel-ai-sdk/) ·
[Submilli runtime](https://github.com/submilli/submilli-runtime) ·
[Discord](https://discord.gg/VphpukeGGj) ·
[Website](https://submilli.ai)

## Let your coding agents do the work

Copy this prompt into your coding agent to connect your AI SDK project to Submilli:

<details>
<summary>Show prompt</summary>

```text
Connect this project's Vercel AI SDK agent to Submilli. Follow
https://submilli.ai/docs/tutorials/connect-vercel-ai-sdk/.
Keep the existing model. Show me how existing application tools will be
available to the agent, and which calls will go through Submilli.
Show me the Blueprint and code changes. Test with mocked model responses.
```

</details>

## Install

Node.js 22 or later is required.

```sh
npm install @submilli/ai-sdk ai
```

```ts
import { submilliTools } from "@submilli/ai-sdk";
import { streamText } from "ai";

const submilli = await submilliTools({ blueprint: "research", conversationId: chat.id, variables: { userId: user.id } });
const result = streamText({ model, tools: submilli.tools, messages });
```

Follow [Connect Vercel AI SDK](https://submilli.ai/docs/tutorials/connect-vercel-ai-sdk/) for
the complete setup, including the server, Blueprint, model provider, and session cleanup.

## Status

Submilli is young and moving quickly. Breaking changes are recorded in the
[`@submilli/ai-sdk` changelog](packages/ai-sdk/CHANGELOG.md) and
[`@submilli/sdk` changelog](packages/sdk/CHANGELOG.md). To talk with us, email
[hello@submilli.ai](mailto:hello@submilli.ai) or join [Discord](https://discord.gg/VphpukeGGj).

## Development

This repository is an npm workspace. In the workspace, `@submilli/ai-sdk` uses
`packages/sdk` directly; when published, it depends on `@submilli/sdk` from npm.

```sh
npm install
npm run typecheck
npm test            # unit tests, against a fake of the HTTP API
npm run check       # build, then publint
```

Node runs the TypeScript sources directly. Tests run them through the `submilli-source`
export condition, so they need no build.

Integration tests start submilli-server from `$SUBMILLI_BIN` or `PATH`. A release build can
live in the ignored `.submilli-bin/` directory:

```sh
SUBMILLI_BIN=$PWD/.submilli-bin npm run test:integration --workspaces
```

The research example also needs the `submilli` CLI; `packages/ai-sdk/scripts/test-server.sh`
starts a suitable server, and `npm run example:check` in `packages/ai-sdk` checks the example
against it.

## CI and releases

CI type-checks, runs the unit tests on Node 22 and 24, runs the integration tests against the
released submilli-server, and installs each packed package on its own.

Release a package by pushing a tag that matches its `package.json` version: `sdk-v0.1.0` or
`ai-sdk-v0.1.0`. The release workflow publishes it to npm with provenance, through trusted
publishing. Release `@submilli/sdk` before an `@submilli/ai-sdk` version that depends on it.

## License

[Apache License 2.0](LICENSE).
