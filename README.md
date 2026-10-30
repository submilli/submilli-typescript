# submilli-typescript

[Submilli](https://github.com/submilli/submilli-runtime) is a dedicated secure runtime for
code-mode agents, with built-in isolation, governance, and permissions.

This repository holds the TypeScript packages for it:

| Package | For |
| --- | --- |
| [`@submilli/ai-sdk`](packages/ai-sdk#readme) | The [Vercel AI SDK](https://ai-sdk.dev): lets your agent execute TypeScript code in Submilli's runtime, and call your existing AI SDK tools from it |
| [`@submilli/mastra`](packages/mastra#readme) | [Mastra](https://mastra.ai) agents: the same, with a session per memory thread and approvals through Mastra's suspend and resume |
| [`@submilli/sdk`](packages/sdk#readme) | Any JavaScript harness: the HTTP API of submilli-server, typed |

[Docs](https://submilli.ai/docs/) ·
[Connect Vercel AI SDK](https://submilli.ai/docs/tutorials/connect-vercel-ai-sdk/) ·
[Connect Mastra](https://submilli.ai/docs/tutorials/connect-mastra/) ·
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

For Mastra:

```sh
npm install @submilli/mastra @mastra/core
```

```ts
import { createSubmilliTools } from "@submilli/mastra";

const submilli = createSubmilliTools({ blueprint: "research", variables: ({ resourceId }) => ({ userId: resourceId! }) });
const agent = new Agent({ id: "researcher", name: "Researcher", instructions, model, memory, tools: () => submilli.tools() });
```

## Status

Submilli is young and moving quickly. Breaking changes are recorded in the
[`@submilli/ai-sdk`](packages/ai-sdk/CHANGELOG.md), [`@submilli/mastra`](packages/mastra/CHANGELOG.md),
and [`@submilli/sdk`](packages/sdk/CHANGELOG.md) changelogs. To talk with us, email
[hello@submilli.ai](mailto:hello@submilli.ai) or join [Discord](https://discord.gg/VphpukeGGj).

## Development

This repository is an npm workspace. In the workspace, `@submilli/ai-sdk` and
`@submilli/mastra` use `packages/sdk` directly; when published, they depend on `@submilli/sdk`
from npm.

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

The research examples also need the `submilli` CLI; each package's `scripts/test-server.sh`
starts a suitable server, and `npm run example:check` in `packages/ai-sdk` or `packages/mastra`
checks that package's example against it.

## CI and releases

GitHub Actions is not enabled for this repository, so run CI locally before you push:

```sh
scripts/ci.sh
```

It does what `.github/workflows/ci.yml` would: a clean install, type checks, unit tests, the
build and publint, the integration tests against the pinned submilli-server release
(downloaded into `.submilli-bin/` on Linux x86_64, or taken from `$SUBMILLI_BIN`), and an
install of each packed package on its own. Run it on Node 22 and on Node 24.

To release a package, bump its `package.json` version and changelog, run `scripts/ci.sh`, then
publish from a clean checkout of `main`:

```sh
npm run build
npm publish --workspace packages/sdk --access public      # or packages/ai-sdk, packages/mastra
git tag sdk-v0.1.0 && git push origin sdk-v0.1.0             # or ai-sdk-v0.1.0, mastra-v0.1.0
```

Release `@submilli/sdk` before an `@submilli/ai-sdk` or `@submilli/mastra` version that depends
on it. Once Actions
is enabled, pushing the tag runs `.github/workflows/release.yml` instead, which publishes with
npm provenance through trusted publishing.

## License

[Apache License 2.0](LICENSE).
