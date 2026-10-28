// Submilli code mode for Mastra: the model writes TypeScript programs, and
// submilli-server runs them under a Blueprint's policy.

export {
  createSubmilliTools,
  SubmilliSessionMismatchError,
  type Binding,
  type BindingContext,
  type SubmilliTools,
  type SubmilliToolSet,
  type SubmilliToolsOptions,
  type ThreadRef,
} from "./submilli-tools.ts";
export type { ApplicationTool, ApplicationTools, ApprovalDecision, ApprovalRequest } from "./app-tools.ts";
export {
  BUILTINS_DOCS,
  BUILTINS_LIST,
  EXECUTE,
  LAST_RUN,
  PACKAGES_DOCS,
  PACKAGES_SEARCH,
  type ApprovalAnswer,
  type ApprovalPayload,
  type ExecuteOutput,
  type ToolCallRecord,
} from "./messages.ts";
export {
  memorySessionStore,
  threadSessionStore,
  type SessionStore,
  type StoredSession,
  type WaitingRun,
} from "./store.ts";
