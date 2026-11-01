# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First release, for submilli-server 0.4.1, `@mastra/core` 1.79, and `@submilli/sdk` 0.1.

### Added

- `createSubmilliTools` for Mastra agents: the server's six tools, with the Blueprint's
  descriptions, and one session per memory thread, kept in the thread's metadata.
- Blueprint variables and secrets from each agent run's request context, resource, or thread.
- Retries with an `Idempotency-Key` per tool call. A session that ended is replaced, and the
  model is told. A thread whose variables changed is refused.
- `ptc` (programmatic tool calling): programs call the application's Mastra tools as `@tools`,
  with the execute tool's Mastra context.
- Approvals for `ptc` calls, set with `requireApproval` or `requireToolApproval`: the agent run
  suspends and resumes with Mastra's `resumeGenerate` or `resumeStream`, or the application
  decides with `onApprovalRequired`.
