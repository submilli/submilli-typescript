# Changelog

## Unreleased

Release coordination: publish the updated core SDK before its integrations and raise their SDK dependency minimums to that release. These PRs do not publish packages.

- SUB-2074: Fetch package documentation in one ordered batch. The SDK adds `packageDocsBatch(id, names)` on blueprints and sessions; `packageDocs(id, name)` retains its existing GET endpoint and behavior. Agent documentation tools now take `names: string[]`. Batch calls require a server with SUB-2074 support.


All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-11-01

Published from GitHub Actions through npm trusted publishing. No code changes.

## [0.1.0] - 2026-11-01

First release, for submilli-server 0.4.1 and later.

### Added

- `Submilli`, a client for submilli-server's HTTP API with no dependencies beyond
  `fetch` and WebCrypto: sessions, runs, Blueprint discovery, and one-off runs.
- `sessions.run` and `runs.complete`: drive a run to its end, answering its calls to
  the application's tools with `onToolCall`. A throw leaves the run waiting.
  Running and queued runs are polled.
- `idempotencyKey`, which turns any id into a key the server accepts.
- Typed errors under `SubmilliError`, including `UnknownSessionError`,
  `SessionRequiresSecretsError`, `IdempotencyError`, `UnknownRunError`, and
  `RunStateError`.
- Retries with backoff for requests that are safe to repeat, honoring `Retry-After`.
- `inlineRefs`, for schemas with local `$ref`s.
