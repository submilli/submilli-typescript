// The TypeScript SDK for submilli-server's HTTP API.
//
// ```ts
// import { Submilli } from "@submilli/sdk";
//
// const client = new Submilli();
// const session = await client.sessions.create("research", { variables: { userId: "u_ada" } });
// const result = await client.sessions.run(session.id, code, { idempotencyKey: "call-1" });
// ```

export {
  Blueprints,
  DEFAULT_BASE_URL,
  idempotencyKey,
  Runs,
  Sessions,
  Submilli,
  type RequestOptions,
  type SubmilliOptions,
  type ToolCallHandler,
} from "./client.ts";
export {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  IdempotencyError,
  InternalServerError,
  NotFoundError,
  RunNotSuspendedError,
  RunStateError,
  ServiceUnavailableError,
  SessionRequiresSecretsError,
  SubmilliError,
  UnknownBlueprintError,
  UnknownCallError,
  UnknownRunError,
  UnknownSessionError,
} from "./errors.ts";
export { inlineRefs } from "./schema.ts";
export {
  toolResult,
  type BlueprintPrompt,
  type CreatedSession,
  type ExecuteResult,
  type JSONSchema,
  type LastRun,
  type PackageDocs,
  type PendingCall,
  type RunError,
  type RunningRun,
  type RunState,
  type SuspendedRun,
  type ToolDeclaration,
  type ToolResult,
} from "./types.ts";
export { VERSION } from "./version.ts";
