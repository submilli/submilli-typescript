# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-29

First release, for submilli-server 0.4.1, AI SDK 7, and `@submilli/sdk` 0.1.

### Added

- `submilliTools` for the Vercel AI SDK: the server's six tools, with the Blueprint's
  descriptions, and one session per conversation, found by `conversationId` in a
  `SessionStore`.
- Retries with an `Idempotency-Key` per tool call. A session that ended is replaced,
  and the model is told. A conversation whose variables changed is refused.
- `ptc` (programmatic tool calling): programs call the application's AI SDK tools as
  `@tools`, with the AI SDK's execution options. The execute tool is also a tool
  caller for `experimental_toolCallers`.
- Approvals for `ptc` calls, set with `needsApproval` or `toolApproval`: through the
  AI SDK's tool-approval flow, with `submilli__typescript__resume`, or in the
  application with `onApprovalRequired`.
