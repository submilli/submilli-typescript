// What the server sends back, and what a harness sends it, as typed values.

import { isRecord, RunStateError } from "./errors.ts";

/** A JSON Schema, as an object. */
export type JSONSchema = Record<string, unknown>;

/**
 * One of the application's tools, as a session declares it for programs to
 * call as `@tools`.
 *
 * The shape of an MCP `tools/list` entry. `name` must be a TypeScript
 * function name. Without `output_schema`, the tool returns `unknown` in
 * programs. The server does not resolve `$ref`; see `inlineRefs`.
 */
export interface ToolDeclaration {
  name: string;
  input_schema: JSONSchema;
  description?: string;
  output_schema?: JSONSchema;
}

/** A session `sessions.create` opened. */
export interface CreatedSession {
  id: string;
  /** What programs will not see of the declared tools, and why. */
  warnings: string[];
}

/** Why a run failed: a compile error, a runtime error, a limit, or a denial. */
export interface RunError {
  /**
   * `compile_error`, `runtime_error`, `permission_denied`, `timeout`,
   * `fuel_exhausted`, `memory_exhausted`, `blueprint_not_found`,
   * `invalid_request`, and others.
   */
  kind: string;
  message: string;
  /** On `permission_denied`: the Package refused. */
  caller?: string;
  /** On `permission_denied`: the capability refused. */
  capability?: string;
  /** On `permission_denied`: who refused, `policy`, `invariant`, `read_only` or `harness`. */
  source?: string;
  /** On compile errors: `severity`, `line`, `column`, `message`, and `notes`. */
  diagnostics?: Record<string, unknown>[];
  /** The error object as the server sent it. */
  raw: Record<string, unknown>;
}

/**
 * A finished run (`status: "finished"`).
 *
 * On a server with `durable_execution`, `GET /v1/runs/{id}` reports a
 * finished run as `completed`, with this result in its `response`.
 */
export interface ExecuteResult {
  status: "finished";
  executionId: string;
  sessionId: string;
  /**
   * What `main` returned: a string as is, other values as JSON text, `null`
   * on an undefined return or a failure.
   */
  result: string | null;
  console: string[];
  error: RunError | null;
  /** Whether a denial ended the run. */
  denied: boolean;
  /** Tools of an imported `@mcp/<server>` or `@tools` Package that were dropped or typed `unknown`. */
  discoveryWarnings: string[];
}

/** A call to one of the application's tools that a suspended run waits on. */
export interface PendingCall {
  /** The run's id and the call's sequence number, stable across retries. Opaque. */
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  /** The run that made the call. */
  executionId: string;
}

/** A run stopped at calls to the application's tools (`status: "suspended"`). */
export interface SuspendedRun {
  status: "suspended";
  executionId: string;
  sessionId: string;
  calls: PendingCall[];
}

/**
 * A run at work (`status: "running"`), or waiting for its turn in the session
 * (`status: "queued"`).
 *
 * `runs.retrieve` answers it, and on a server with `durable_execution` so
 * does an execute still queued or working after the server's wait.
 * `runs.complete` polls it.
 */
export interface RunningRun {
  status: "queued" | "running";
  executionId: string;
  sessionId: string;
}

/** A run's state, from an execute, a resume, or `GET /v1/runs/{id}`. */
export type RunState = ExecuteResult | SuspendedRun | RunningRun;

/** The harness's answer to one `PendingCall`. Build one with `toolResult`. */
export type ToolResult =
  | { callId: string; ok: true; value: unknown }
  | { callId: string; ok: false; kind: "failed" | "denied"; message: string };

/** Answers to a `PendingCall`. */
export const toolResult = {
  /** The tool returned `value`, which must be JSON. The program gets it, checked against the output schema. */
  success(callId: string, value: unknown): ToolResult {
    return { callId, ok: true, value };
  },
  /** The tool ran and failed: the program's call throws `Error(message)`. */
  failed(callId: string, message: string): ToolResult {
    return { callId, ok: false, kind: "failed", message };
  },
  /** The application, or a person, refused the call: it throws `PermissionDeniedError`. */
  denied(callId: string, message: string): ToolResult {
    return { callId, ok: false, kind: "denied", message };
  },
};

/** `GET /v1/sessions/{id}/last-run`: the session's most recent run, with its full console. */
export interface LastRun {
  result: string | null;
  console: string[];
  error: RunError | null;
  raw: Record<string, unknown>;
}

/**
 * A Package's documentation, or the server's answer for a name it doesn't know.
 *
 * `text` is Markdown for an installed or virtual Package, and JSON text
 * otherwise. For an unknown name, `found` is false and `text` carries the
 * server's suggestion, which is worth showing to a model as is.
 */
export interface PackageDocs {
  found: boolean;
  text: string;
}

/** `GET /v1/blueprints/{name}/prompt`: what the server writes for a model about this Blueprint. */
export interface BlueprintPrompt {
  name: string;
  /** The execute tool's description: the language, the Packages, and the rules. */
  prompt: string;
  /**
   * The other tools' descriptions: `search`, `docs`, `builtins`,
   * `builtins_list`, `builtins_docs`, `last_run`.
   */
  tools: Record<string, string>;
}

// Readers

export function readRunError(body: Record<string, unknown>): RunError {
  const error: RunError = { kind: String(body.kind ?? ""), message: String(body.message ?? ""), raw: { ...body } };
  if (typeof body.caller === "string") error.caller = body.caller;
  if (typeof body.capability === "string") error.capability = body.capability;
  if (typeof body.source === "string") error.source = body.source;
  if (Array.isArray(body.diagnostics)) error.diagnostics = body.diagnostics.filter(isRecord);
  return error;
}

export function readExecuteResult(body: Record<string, unknown>): ExecuteResult {
  const error = isRecord(body.error) ? readRunError(body.error) : null;
  return {
    status: "finished",
    executionId: String(body.execution_id ?? ""),
    sessionId: String(body.session_id ?? ""),
    result: typeof body.result === "string" ? body.result : null,
    console: strings(body.console),
    error,
    denied: error?.kind === "permission_denied",
    discoveryWarnings: strings(body.discovery_warnings),
  };
}

/**
 * A run's state from an execute, resume or run body. A body without `status`
 * is finished.
 *
 * Throws `RunStateError` for a run with no result to return, such as a
 * durable run that is `stuck`, and for a status this SDK does not know.
 */
export function readRunState(body: Record<string, unknown>): RunState {
  const status = body.status ?? "finished";
  const executionId = String(body.execution_id ?? "");
  const sessionId = String(body.session_id ?? "");
  if (status === "suspended") {
    const calls = (Array.isArray(body.calls) ? body.calls : []).filter(isRecord).map(
      (call): PendingCall => ({
        callId: String(call.call_id),
        tool: String(call.tool),
        args: isRecord(call.args) ? call.args : {},
        executionId,
      }),
    );
    return { status, executionId, sessionId, calls };
  }
  if (status === "running" || status === "queued") return { status, executionId, sessionId };
  if (status === "finished") return readExecuteResult(body);
  const response = body.response;
  if (status === "completed" && isRecord(response) && (response.status ?? "finished") === "finished") {
    return readExecuteResult({ execution_id: executionId, session_id: sessionId, ...response });
  }
  throw new RunStateError(body);
}

export function readLastRun(body: Record<string, unknown>): LastRun {
  return {
    result: typeof body.result === "string" ? body.result : null,
    console: strings(body.console),
    error: isRecord(body.error) ? readRunError(body.error) : null,
    raw: { ...body },
  };
}

export function readPrompt(body: Record<string, unknown>): BlueprintPrompt {
  const tools = isRecord(body.tools) ? body.tools : {};
  return {
    name: String(body.name ?? ""),
    prompt: String(body.prompt),
    tools: Object.fromEntries(Object.entries(tools).map(([key, value]) => [key, String(value)])),
  };
}

/** The answer as `POST /v1/runs/{id}/resume` takes it in `results`. */
export function toolResultJSON(result: ToolResult): Record<string, unknown> {
  if (result.ok) return { call_id: result.callId, ok: true, value: result.value };
  return { call_id: result.callId, ok: false, error: { kind: result.kind, message: result.message } };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
