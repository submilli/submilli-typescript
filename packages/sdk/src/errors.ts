// The errors the SDK throws.
//
// Every error is a `SubmilliError`. A response the server refused is an
// `APIStatusError` with the status, the body, and the body's stable `code`.
// Refusals a caller can act on have their own subclass, which also derives
// from the status class (`UnknownSessionError` is a `NotFoundError`).
//
// A program that fails, or that the Blueprint denies, is not an error: it is
// a finished run whose `error` is set. A run with no result to return, such
// as a durable run that is `stuck`, is a `RunStateError`.

/** Base class of every error this package throws. */
export class SubmilliError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The server could not be reached, or the connection failed mid-request. */
export class APIConnectionError extends SubmilliError {}

/** The request timed out. */
export class APITimeoutError extends APIConnectionError {}

/** The server answered with an error status. */
export class APIStatusError extends SubmilliError {
  /** The HTTP status. */
  readonly status: number;
  /** The parsed JSON body, or the text when it is not JSON. */
  readonly body: unknown;
  /** The body's `error` field, when there is one, such as `unknown_run`. */
  readonly code: string | undefined;
  /** The run the refusal concerns, when the body names one. */
  readonly executionId: string | undefined;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `submilli-server answered ${status}: ${describe(body)}`);
    this.status = status;
    this.body = body;
    this.code = field(body, "error");
    this.executionId = field(body, "execution_id");
  }
}

/** 400: the request was malformed, or names variables, secrets or tools the server refuses. */
export class BadRequestError extends APIStatusError {}

/** 401: the API token is missing or not recognised. */
export class AuthenticationError extends APIStatusError {}

/** 403: the token's role may not use this endpoint. */
export class ForbiddenError extends APIStatusError {}

/** 404. */
export class NotFoundError extends APIStatusError {}

/** 409. */
export class ConflictError extends APIStatusError {}

/** 503. */
export class ServiceUnavailableError extends APIStatusError {}

/** 5xx other than 503. */
export class InternalServerError extends APIStatusError {}

/** `404 unknown session`: the session ended, usually after its idle timeout. */
export class UnknownSessionError extends NotFoundError {}

/** `404`: the server holds no Blueprint of that name. */
export class UnknownBlueprintError extends NotFoundError {}

/** `404 unknown_run`: the server no longer holds the run, as after a restart. */
export class UnknownRunError extends NotFoundError {}

/** `409 session_requires_secrets`: the server lost the session's harness secrets; `rebind` them. */
export class SessionRequiresSecretsError extends ConflictError {
  /** The harness secrets the server asks for. */
  get required(): string[] {
    const required = isRecord(this.body) ? this.body.required : undefined;
    return Array.isArray(required) ? required.map(String) : [];
  }
}

/** `409 run_not_suspended`: the run waits on no call; it finished, timed out, or was cancelled. */
export class RunNotSuspendedError extends ConflictError {}

/** `400 unknown_call`: the run waits on another call. */
export class UnknownCallError extends BadRequestError {}

/**
 * The server refused an `Idempotency-Key`, and ran nothing.
 *
 * `code` says why: `idempotency_conflict` (the key was used with other code),
 * `idempotency_incomplete` (an earlier attempt never recorded an outcome, so
 * its effects are unknown), `idempotency_in_progress` (an earlier attempt is
 * still running), `idempotency_unavailable` (the record could not be read or
 * written), `idempotency_response_expired` (the earlier result is no longer
 * retained), or `idempotency_key_invalid`.
 */
export class IdempotencyError extends APIStatusError {
  get detail(): string {
    return field(this.body, "detail") ?? "";
  }
}

// What each status without a result means, as servers with
// `durable_execution` report them in a run's lifecycle view.
const RUN_STATES: Record<string, string> = {
  stuck: "it stopped, and waits to be recovered with POST /v1/runs/{run}/recover",
  cancelled: "it was cancelled before it finished",
  aborted: "it ended before the program started",
  indeterminate: "it was interrupted, and its outcome is unknown",
  expired: "it finished, but the server no longer keeps its result",
  completed: "it finished, but the server keeps no result for it",
};

/**
 * The server reports a run in a state with no result to return.
 *
 * Servers with `durable_execution` report these: `stuck` (stopped, and held
 * for `POST /v1/runs/{id}/recover`), `cancelled` (its session closed),
 * `aborted` (it never started), `indeterminate` (interrupted, outcome
 * unknown), `expired` (its result is no longer kept), and `completed` without
 * a kept result. A status this SDK does not know throws it too.
 */
export class RunStateError extends SubmilliError {
  readonly executionId: string;
  readonly sessionId: string;
  /** The run's `status`, such as `stuck`. */
  readonly status: string;
  /** Why, when the server says, such as `credentials_unavailable`. */
  readonly reason: string | undefined;
  /** The run as the server sent it, with lifecycle metadata such as `revision`. */
  readonly body: Record<string, unknown>;

  constructor(body: Record<string, unknown>) {
    const executionId = String(body.execution_id ?? "");
    const status = String(body.status ?? "");
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const meaning = (RUN_STATES[status] ?? "this version of the SDK does not know that status").replace(
      "{run}",
      executionId,
    );
    super(
      `run ${executionId} is ${status}${reason ? ` (${reason})` : ""} and has no result to return: ${meaning}`,
    );
    this.body = { ...body };
    this.executionId = executionId;
    this.sessionId = String(body.session_id ?? "");
    this.status = status;
    this.reason = reason;
  }
}

export const IDEMPOTENCY_CODES: ReadonlySet<string> = new Set([
  "idempotency_conflict",
  "idempotency_incomplete",
  "idempotency_in_progress",
  "idempotency_unavailable",
  "idempotency_key_invalid",
  "idempotency_response_expired",
]);

type StatusErrorClass = new (status: number, body: unknown) => APIStatusError;

const BY_CODE: Record<string, StatusErrorClass> = {
  "404 unknown session": UnknownSessionError,
  "404 unknown blueprint": UnknownBlueprintError,
  "404 unknown_run": UnknownRunError,
  "409 session_requires_secrets": SessionRequiresSecretsError,
  "409 run_not_suspended": RunNotSuspendedError,
  "400 unknown_call": UnknownCallError,
};

const BY_STATUS: Record<number, StatusErrorClass> = {
  400: BadRequestError,
  401: AuthenticationError,
  403: ForbiddenError,
  404: NotFoundError,
  409: ConflictError,
  503: ServiceUnavailableError,
};

/** The error for a refused response, from its status and parsed body. */
export function statusError(status: number, body: unknown): APIStatusError {
  const code = field(body, "error");
  if (code !== undefined && IDEMPOTENCY_CODES.has(code)) return new IdempotencyError(status, body);
  const known = code === undefined ? undefined : BY_CODE[`${status} ${code}`];
  if (known) return new known(status, body);
  if (status === 404 && code === "not_found" && (field(body, "message") ?? "").includes("blueprint")) {
    return new UnknownBlueprintError(status, body);
  }
  // `GET /v1/runs/{id}` answers a run it holds no record of in plain text.
  if (status === 404 && body === "unknown run") return new UnknownRunError(status, body);
  const byStatus = BY_STATUS[status] ?? (status >= 500 ? InternalServerError : APIStatusError);
  return new byStatus(status, body);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(body: unknown, name: string): string | undefined {
  const value = isRecord(body) ? body[name] : undefined;
  return typeof value === "string" ? value : undefined;
}

function describe(body: unknown): string {
  if (isRecord(body)) return String(body.message ?? body.detail ?? body.error ?? JSON.stringify(body));
  return String(body) || "(empty body)";
}
