# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-29

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
