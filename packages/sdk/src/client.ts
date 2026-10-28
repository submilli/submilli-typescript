// `Submilli`: the HTTP API of one submilli-server.

import {
  APIConnectionError,
  APITimeoutError,
  IDEMPOTENCY_CODES,
  isRecord,
  RunNotSuspendedError,
  statusError,
  SubmilliError,
  UnknownCallError,
  UnknownSessionError,
} from "./errors.ts";
import {
  readExecuteResult,
  readLastRun,
  readPrompt,
  readRunState,
  toolResultJSON,
  type BlueprintPrompt,
  type CreatedSession,
  type ExecuteResult,
  type LastRun,
  type PackageDocs,
  type PendingCall,
  type RunState,
  type ToolDeclaration,
  type ToolResult,
} from "./types.ts";
import { VERSION } from "./version.ts";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8128";
// An execute may wait up to 300 seconds on the server for an earlier attempt
// with the same idempotency key; leave room for that.
const DEFAULT_TIMEOUT_MS = 330_000;
const DEFAULT_MAX_RETRIES = 2;
// The longest `Idempotency-Key` the server accepts, in bytes.
const MAX_IDEMPOTENCY_KEY_BYTES = 120;

/**
 * An `Idempotency-Key` for a harness's own call id, such as a model's tool
 * call id.
 *
 * The id as is when the server accepts it (printable ASCII, 1 to 120 bytes),
 * otherwise the sha256 hex digest of its UTF-8 bytes. The same id always
 * gives the same key.
 */
export async function idempotencyKey(callId: string): Promise<string> {
  if (callId.length > 0 && callId.length <= MAX_IDEMPOTENCY_KEY_BYTES && /^[ -~]+$/.test(callId)) return callId;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(callId));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Answers one call a run waits on. A throw propagates and leaves the run waiting on the server. */
export type ToolCallHandler = (call: PendingCall) => ToolResult | Promise<ToolResult>;

export interface SubmilliOptions {
  /** The server. Defaults to `$SUBMILLI_SERVER`, then `http://127.0.0.1:8128`. */
  baseURL?: string;
  /**
   * API token. Defaults to `$SUBMILLI_SERVER_TOKEN`. A server started with
   * `--allow-unauthenticated` needs none.
   */
  token?: string;
  /** Milliseconds per request. Default 330 000: an execute may wait 300 s on an earlier attempt. */
  timeout?: number;
  /**
   * Further attempts after a connection failure or a 502, 503 or 504, for
   * requests that are safe to repeat: reads, deletes, rebinds, resumes, and
   * executes with an idempotency key. Default 2.
   */
  maxRetries?: number;
  /** The `fetch` to send with. Defaults to the global one. */
  fetch?: typeof fetch;
}

/** Options every request takes. */
export interface RequestOptions {
  /** Aborts the request. A run the server already started carries on. */
  signal?: AbortSignal | undefined;
}

interface Request {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  query?: [string, string][];
  headers?: Record<string, string>;
  // Whether sending it twice is harmless, so a failed attempt may be retried.
  retryable?: boolean;
  signal?: AbortSignal | undefined;
}

interface Response {
  status: number;
  ok: boolean;
  text: string;
  body: unknown;
  retryAfter: string | null;
}

/**
 * The HTTP API of one submilli-server, for one API token.
 *
 * ```ts
 * const client = new Submilli();
 * const session = await client.sessions.create("research", { variables: { userId: "u_ada" } });
 * const result = await client.sessions.run(session.id, code, { idempotencyKey: "call-1" });
 * ```
 */
export class Submilli {
  readonly baseURL: string;
  readonly sessions: Sessions;
  readonly runs: Runs;
  readonly blueprints: Blueprints;
  private readonly token: string | undefined;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly fetcher: typeof fetch;

  constructor(options: SubmilliOptions = {}) {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new RangeError("maxRetries must be 0 or more");
    this.baseURL = (options.baseURL ?? env("SUBMILLI_SERVER") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.token = options.token ?? env("SUBMILLI_SERVER_TOKEN");
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = maxRetries;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sessions = new Sessions(this);
    this.runs = new Runs(this);
    this.blueprints = new Blueprints(this);
  }

  /**
   * `POST /v1/execute`: run one program in a session that ends when it returns.
   *
   * An unknown Blueprint or invalid variables come back as the result's
   * `error`, not as an exception. One-off runs have no application tools.
   */
  async execute(
    blueprint: string,
    code: string,
    options: { variables?: Record<string, string>; secrets?: Record<string, string> } & RequestOptions = {},
  ): Promise<ExecuteResult> {
    const body: Record<string, unknown> = { blueprint, code, variables: options.variables ?? {} };
    if (options.secrets && Object.keys(options.secrets).length > 0) body.secrets = options.secrets;
    return readExecuteResult(object(await this.send({ method: "POST", path: "/v1/execute", body, signal: options.signal })));
  }

  /** @internal */
  async send(request: Request): Promise<Response> {
    const url = new URL(this.baseURL + request.path);
    for (const [name, value] of request.query ?? []) url.searchParams.append(name, value);
    const headers: Record<string, string> = {
      "User-Agent": `submilli-typescript/${VERSION}`,
      Accept: "application/json",
      ...request.headers,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (request.body !== undefined) headers["Content-Type"] = "application/json";
    const attempts = 1 + (request.retryable ? this.maxRetries : 0);
    for (let attempt = 0; ; attempt++) {
      const last = attempt === attempts - 1;
      let response: Response | undefined;
      try {
        response = await this.attempt(url, request, headers);
      } catch (error) {
        if (last || request.signal?.aborted || !(error instanceof APIConnectionError)) throw error;
      }
      if (response && (last || !shouldRetry(response))) return response;
      await sleep(retryDelay(attempt, response), request.signal);
    }
  }

  private async attempt(url: URL, request: Request, headers: Record<string, string>): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeout);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: globalThis.Response;
    let text: string;
    try {
      response = await this.fetcher(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? null : JSON.stringify(request.body),
        signal,
      });
      text = await response.text();
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      if (timeout.aborted) throw new APITimeoutError(`request to ${url} timed out`, { cause: error });
      throw new APIConnectionError(`could not reach ${url}: ${String(error)}`, { cause: error });
    }
    return {
      status: response.status,
      ok: response.ok,
      text,
      body: parse(text),
      retryAfter: response.headers.get("retry-after"),
    };
  }
}

/** Sessions: a Blueprint bound to variables and secrets, where programs run one after another. */
export class Sessions {
  private readonly client: Submilli;

  constructor(client: Submilli) {
    this.client = client;
  }

  /**
   * `POST /v1/sessions`: open a session.
   *
   * `tools` are the application's tools that programs may call as `@tools`,
   * fixed for the session's life. The Blueprint must grant `tools.call`.
   */
  async create(
    blueprint: string,
    options: {
      variables?: Record<string, string>;
      secrets?: Record<string, string>;
      tools?: readonly ToolDeclaration[];
    } & RequestOptions = {},
  ): Promise<CreatedSession> {
    const body: Record<string, unknown> = { blueprint, variables: options.variables ?? {} };
    if (options.secrets && Object.keys(options.secrets).length > 0) body.secrets = options.secrets;
    if (options.tools && options.tools.length > 0) body.tools = options.tools;
    // Not retried: a lost answer would leave a session nobody holds.
    const created = object(await this.client.send({ method: "POST", path: "/v1/sessions", body, signal: options.signal }));
    return {
      id: String(created.session_id),
      warnings: Array.isArray(created.warnings) ? created.warnings.map(String) : [],
    };
  }

  /**
   * `POST /v1/sessions/{id}/execute`: start a program and answer its first state.
   *
   * In a session with application tools a run may answer a `SuspendedRun`;
   * `run` answers its calls for you. With an `idempotencyKey`, a repeated
   * request answers the same run instead of running the program again. On a
   * server with `durable_execution`, a run still queued or working after the
   * server's wait answers a `RunningRun`, and a run with no result to return
   * throws `RunStateError`.
   */
  async execute(
    sessionId: string,
    code: string,
    options: { idempotencyKey?: string } & RequestOptions = {},
  ): Promise<RunState> {
    const key = options.idempotencyKey;
    const response = await this.client.send({
      method: "POST",
      path: `/v1/sessions/${seg(sessionId)}/execute`,
      body: { code },
      headers: key ? { "Idempotency-Key": key } : {},
      // Without a key, a retry could run the program twice.
      retryable: Boolean(key),
      signal: options.signal,
    });
    return readRunState(object(response));
  }

  /**
   * Run a program to the end, answering its calls to the application's tools
   * with `onToolCall`.
   *
   * A throw from `onToolCall` propagates and leaves the run waiting on the
   * server. Executing again with the same `idempotencyKey` picks it up at the
   * call it waits on. Throws `RunStateError` when the run has no result to
   * return, such as a durable run that is `stuck`.
   */
  async run(
    sessionId: string,
    code: string,
    options: { idempotencyKey?: string; onToolCall?: ToolCallHandler } & RequestOptions = {},
  ): Promise<ExecuteResult> {
    const state = await this.execute(sessionId, code, options);
    return this.client.runs.complete(state, options);
  }

  /** `POST /v1/sessions/{id}/rebind`: replace the session's harness secrets, as after a server restart. */
  async rebind(sessionId: string, secrets: Record<string, string>, options: RequestOptions = {}): Promise<void> {
    noContent(
      await this.client.send({
        method: "POST",
        path: `/v1/sessions/${seg(sessionId)}/rebind`,
        body: { secrets },
        retryable: true,
        signal: options.signal,
      }),
    );
  }

  /** `GET /v1/sessions/{id}/last-run`. `undefined` when no run is recorded or the session is unknown. */
  async lastRun(sessionId: string, options: RequestOptions = {}): Promise<LastRun | undefined> {
    const response = await this.client.send({
      method: "GET",
      path: `/v1/sessions/${seg(sessionId)}/last-run`,
      retryable: true,
      signal: options.signal,
    });
    // The server answers 404 with an empty body both for an unknown session
    // and for a session with no recorded run.
    if (response.status === 404) return undefined;
    return readLastRun(object(response));
  }

  /** `DELETE /v1/sessions/{id}`: end the session. `false` when it had already ended. */
  async delete(sessionId: string, options: RequestOptions = {}): Promise<boolean> {
    const response = await this.client.send({
      method: "DELETE",
      path: `/v1/sessions/${seg(sessionId)}`,
      retryable: true,
      signal: options.signal,
    });
    if (response.status === 404) return false;
    noContent(response);
    return true;
  }

  /** The Blueprint's Package search, plus the session's own `@tools`. */
  async searchPackages(sessionId: string, query = "", options: RequestOptions = {}): Promise<Record<string, unknown>> {
    return object(
      await this.client.send({
        method: "GET",
        path: `/v1/sessions/${seg(sessionId)}/packages/search`,
        query: [["q", query]],
        retryable: true,
        signal: options.signal,
      }),
    );
  }

  /** A Package's docs, where `@tools` is the session's own. */
  async packageDocs(sessionId: string, name: string, options: RequestOptions = {}): Promise<PackageDocs> {
    return packageDocs(
      await this.client.send({
        method: "GET",
        path: `/v1/sessions/${seg(sessionId)}/packages/docs`,
        query: [["name", name]],
        retryable: true,
        signal: options.signal,
      }),
    );
  }
}

/** Runs that wait on the application's tools. */
export class Runs {
  private readonly client: Submilli;

  constructor(client: Submilli) {
    this.client = client;
  }

  /**
   * `POST /v1/runs/{id}/resume`: answer the run's pending calls, then wait for
   * its next state.
   *
   * Answering a call twice changes nothing. Throws `UnknownRunError`,
   * `RunNotSuspendedError` and `UnknownCallError`, and `RunStateError` for a
   * run with no result to return.
   */
  async resume(runId: string, results: readonly ToolResult[], options: RequestOptions = {}): Promise<RunState> {
    if (results.length === 0) throw new RangeError("resume needs at least one result");
    const response = await this.client.send({
      method: "POST",
      path: `/v1/runs/${seg(runId)}/resume`,
      body: { results: results.map(toolResultJSON) },
      // Answering a call twice changes nothing, so a resume may be retried.
      retryable: true,
      signal: options.signal,
    });
    return readRunState(object(response));
  }

  /**
   * `GET /v1/runs/{id}`: the run's state now.
   *
   * Throws `UnknownRunError`, and `RunStateError` for a run with no result to
   * return, such as a durable run that is `stuck`.
   */
  async retrieve(runId: string, options: RequestOptions = {}): Promise<RunState> {
    const response = await this.client.send({
      method: "GET",
      path: `/v1/runs/${seg(runId)}`,
      retryable: true,
      signal: options.signal,
    });
    return readRunState(object(response));
  }

  /**
   * Drive a run from `state` until it finishes.
   *
   * Each pending call goes to `onToolCall`, and its `ToolResult` goes back
   * with `resume`. A run that is `running` or `queued` is polled. A throw from
   * `onToolCall` propagates and leaves the run waiting. Throws
   * `UnknownRunError` when the server lost the run, as after a restart, and
   * `RunStateError` when the run has no result to return, such as a durable
   * run that is `stuck` or `cancelled`.
   */
  async complete(
    state: RunState,
    options: {
      onToolCall?: ToolCallHandler;
      /** Milliseconds before the first poll of a running run. Default 100. */
      pollInterval?: number;
      /** The longest wait between polls, in milliseconds. Default 2000. */
      maxPollInterval?: number;
    } & RequestOptions = {},
  ): Promise<ExecuteResult> {
    const { onToolCall, signal } = options;
    const maxPollInterval = options.maxPollInterval ?? 2000;
    let delay = options.pollInterval ?? 100;
    // Recovery can expose an unanswered call again if a resume was delivered
    // but not committed. Resend its answer without repeating the host effect.
    const answered = new Map<string, { call: PendingCall; result: ToolResult }>();
    while (state.status !== "finished") {
      if (state.status !== "suspended") {
        await sleep(delay, signal);
        delay = Math.min(delay * 2, maxPollInterval);
        state = await this.retrieve(state.executionId, { signal });
        continue;
      }
      if (!onToolCall) {
        throw new SubmilliError(
          `run ${state.executionId} called the application's tool '${state.calls[0]?.tool}', ` +
            "and no onToolCall was given to answer it",
        );
      }
      const results: ToolResult[] = [];
      for (const call of state.calls) {
        const previous = answered.get(call.callId);
        if (previous) {
          if (previous.call.tool !== call.tool || JSON.stringify(previous.call.args) !== JSON.stringify(call.args)) {
            throw new SubmilliError(`run changed the tool or arguments of call '${call.callId}'`);
          }
          results.push(previous.result);
          continue;
        }
        const result = await onToolCall(call);
        if (!isRecord(result) || result.callId !== call.callId) {
          throw new SubmilliError(`onToolCall must return a ToolResult for call '${call.callId}'`);
        }
        answered.set(call.callId, { call, result });
        results.push(result);
      }
      try {
        state = await this.resume(state.executionId, results, { signal });
      } catch (error) {
        // A call timed out, or another attempt answered it: look again.
        if (!(error instanceof RunNotSuspendedError || error instanceof UnknownCallError)) throw error;
        state = await this.retrieve(state.executionId, { signal });
      }
    }
    return state;
  }
}

/** What a model needs to write programs for one Blueprint. */
export class Blueprints {
  private readonly client: Submilli;

  constructor(client: Submilli) {
    this.client = client;
  }

  /** `GET /v1/blueprints/{name}/prompt`: the tool descriptions the server writes for this Blueprint. */
  async prompt(blueprint: string, options: RequestOptions = {}): Promise<BlueprintPrompt> {
    return readPrompt(object(await this.get(`${seg(blueprint)}/prompt`, [], options)));
  }

  /** `GET /v1/blueprints/{name}/packages/search`. An empty query lists every Package. */
  async searchPackages(blueprint: string, query = "", options: RequestOptions = {}): Promise<Record<string, unknown>> {
    return object(await this.get(`${seg(blueprint)}/packages/search`, [["q", query]], options));
  }

  /** `GET /v1/blueprints/{name}/packages/docs`. */
  async packageDocs(blueprint: string, name: string, options: RequestOptions = {}): Promise<PackageDocs> {
    return packageDocs(await this.get(`${seg(blueprint)}/packages/docs`, [["name", name]], options));
  }

  /** `GET /v1/blueprints/{name}/builtins`: the built-ins in scope without an import. */
  async builtins(blueprint: string, options: RequestOptions = {}): Promise<Record<string, unknown>> {
    return object(await this.get(`${seg(blueprint)}/builtins`, [], options));
  }

  /** `GET /v1/blueprints/{name}/builtins/docs`: declarations of built-ins. */
  async builtinDocs(
    blueprint: string,
    names: readonly string[],
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const query = names.map((name): [string, string] => ["name", name]);
    return object(await this.get(`${seg(blueprint)}/builtins/docs`, query, options));
  }

  private get(path: string, query: [string, string][], options: RequestOptions): Promise<Response> {
    return this.client.send({ method: "GET", path: `/v1/blueprints/${path}`, query, retryable: true, signal: options.signal });
  }
}

function shouldRetry(response: Response): boolean {
  if (![502, 503, 504].includes(response.status)) return false;
  // An idempotency refusal is the server's answer, not a transient failure.
  const code = isRecord(response.body) ? response.body.error : undefined;
  return typeof code !== "string" || !IDEMPOTENCY_CODES.has(code);
}

function retryDelay(attempt: number, response: Response | undefined): number {
  const after = Number(response?.retryAfter ?? Number.NaN);
  if (Number.isFinite(after) && after >= 0) return Math.min(after, 30) * 1000;
  return Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() / 2);
}

function object(response: Response): Record<string, unknown> {
  if (!response.ok) throw statusError(response.status, response.body);
  if (!isRecord(response.body)) {
    throw new SubmilliError(`expected a JSON object from submilli-server, got: ${response.text.slice(0, 200)}`);
  }
  return response.body;
}

function noContent(response: Response): void {
  if (!response.ok) throw statusError(response.status, response.body);
}

function packageDocs(response: Response): PackageDocs {
  if (response.status === 200) return { found: true, text: response.text };
  if (response.status === 404) {
    const error = statusError(response.status, response.body);
    // An unknown session, or an unknown Blueprint: the caller's mistake.
    if (error instanceof UnknownSessionError || error.code === "not_found") throw error;
    return { found: false, text: response.text };
  }
  throw statusError(response.status, response.body);
}

function parse(text: string): unknown {
  if (text === "") return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

function env(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  return value === "" ? undefined : value;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
