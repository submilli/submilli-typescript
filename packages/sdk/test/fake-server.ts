// A stateful stand-in for submilli-server's HTTP API, served as a `fetch`.
//
// It behaves as the HTTP API reference says, for the parts the packages use.
// Programs are not run: `outcome` decides what an execute returns,
// `refuseNext` makes the next execute answer one of the refusals, and code
// listed in `programs` suspends at each `@tools` call it names.

export const SERVER = "http://submilli.test";
export const TOKEN = "test-token";

export const PROMPT = {
  name: "research",
  prompt: "Run a submilli program — strict TypeScript subset compiled to WebAssembly.",
  tools: {
    search: "Search packages.",
    docs: "Package docs.",
    builtins: "Built-ins.",
    builtins_list: "List built-ins.",
    builtins_docs: "Built-in docs.",
    last_run: "The last run.",
  },
};

type Json = Record<string, unknown>;

interface Session {
  blueprint: string;
  variables: Record<string, string>;
  secrets: Record<string, string>;
  runs: number;
  last: Json | undefined;
  // key -> code and the recorded body, or the id of a run that may suspend
  ledger: Map<string, { code: string; recorded: Json | string }>;
  tools: Json[];
}

interface Run {
  id: string;
  sessionId: string;
  calls: [string, Json][];
  answers: Json[];
  finished: Json | undefined;
}

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: Json | undefined;
}

export class FakeServer {
  readonly sessions = new Map<string, Session>();
  readonly requests: Recorded[] = [];
  readonly suspended = new Map<string, Run>();
  requiredSecrets: string[] = [];
  readonly lostSecrets = new Set<string>();
  refuseNext: [number, Json][] = [];
  outcome: Json = { result: "ok", console: [], error: null };
  promptFetches = 0;
  // code -> the `@tools` calls it makes, in order
  programs = new Map<string, [string, Json][]>();
  openWarnings: string[] = [];
  // Answers 503 to this many requests before serving them.
  unavailable = 0;
  private counter = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : "";
    const body = text ? (JSON.parse(text) as Json) : undefined;
    const method = init?.method ?? "GET";
    this.requests.push({ method, path: url.pathname, query: url.searchParams, headers, body });
    if (this.unavailable > 0) {
      this.unavailable -= 1;
      return new Response(JSON.stringify({ error: "unavailable", message: "try again" }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    }
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return json(401, { error: "unauthorized", message: "missing or unrecognised API token" });
    }
    return this.handle(method, url, headers, body ?? {});
  };

  calls(method: string, pattern: RegExp): Recorded[] {
    return this.requests.filter((request) => request.method === method && pattern.test(request.path));
  }

  totalRuns(): number {
    return [...this.sessions.values()].reduce((sum, session) => sum + session.runs, 0);
  }

  private id(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
  }

  private handle(method: string, url: URL, headers: Headers, body: Json): Response {
    const path = url.pathname;
    let match: RegExpExecArray | null;
    if (method === "POST" && path === "/v1/sessions") return this.open(body);
    if (method === "POST" && path === "/v1/execute") return this.executeOnce(body);
    if ((match = /^\/v1\/sessions\/([^/]+)\/execute$/.exec(path))) {
      return this.execute(match[1]!, body, headers.get("idempotency-key"));
    }
    if ((match = /^\/v1\/sessions\/([^/]+)\/rebind$/.exec(path))) return this.rebind(match[1]!, body);
    if ((match = /^\/v1\/sessions\/([^/]+)\/packages\/(search|docs)$/.exec(path))) {
      return this.sessionDiscovery(match[1]!, match[2]!, url.searchParams);
    }
    if ((match = /^\/v1\/runs\/([^/]+)\/resume$/.exec(path))) return this.resume(match[1]!, body);
    if ((match = /^\/v1\/runs\/([^/]+)$/.exec(path))) {
      const run = this.suspended.get(match[1]!);
      if (!run) return json(404, { error: "unknown_run", execution_id: match[1], message: "no such run" });
      return json(200, this.state(run));
    }
    if ((match = /^\/v1\/sessions\/([^/]+)\/last-run$/.exec(path))) {
      const session = this.sessions.get(match[1]!);
      if (!session?.last) return new Response(null, { status: 404 });
      return json(200, session.last);
    }
    if (method === "DELETE" && (match = /^\/v1\/sessions\/([^/]+)$/.exec(path))) {
      return new Response(null, { status: this.sessions.delete(match[1]!) ? 204 : 404 });
    }
    if ((match = /^\/v1\/blueprints\/([^/]+)\/(.*)$/.exec(path))) {
      if (match[1] !== "research") {
        return json(404, { error: "not_found", message: `blueprint '${match[1]}' is not registered` });
      }
      return this.discovery(match[2]!, url.searchParams);
    }
    return new Response(`unexpected ${method} ${path}`, { status: 500 });
  }

  private open(body: Json): Response {
    if (body.blueprint !== "research") {
      return json(404, { error: "unknown blueprint", message: `unknown blueprint: ${String(body.blueprint)}` });
    }
    const variables = (body.variables ?? {}) as Record<string, string>;
    if (!("userId" in variables)) {
      return json(400, { error: "invalid variables: required variable 'userId' was not supplied" });
    }
    const secrets = (body.secrets ?? {}) as Record<string, string>;
    for (const name of this.requiredSecrets) {
      if (!secrets[name]) {
        return json(400, { error: `invalid secrets: required harness secret '${name}' is missing or empty` });
      }
    }
    const id = this.id();
    const tools = (body.tools ?? []) as Json[];
    this.sessions.set(id, {
      blueprint: String(body.blueprint),
      variables,
      secrets,
      runs: 0,
      last: undefined,
      ledger: new Map(),
      tools,
    });
    return json(200, tools.length > 0 ? { session_id: id, warnings: [...this.openWarnings] } : { session_id: id });
  }

  private execute(sessionId: string, body: Json, key: string | null): Response {
    const session = this.sessions.get(sessionId);
    if (!session) return json(404, { error: "unknown session", session_id: sessionId });
    if (this.lostSecrets.has(sessionId)) {
      return json(409, { error: "session_requires_secrets", required: this.requiredSecrets, session_id: sessionId });
    }
    const refusal = this.refuseNext.shift();
    if (refusal) return json(refusal[0], { ...refusal[1], session_id: sessionId });
    const code = String(body.code);
    const recorded = key === null ? undefined : session.ledger.get(key);
    if (recorded) {
      if (recorded.code !== code) {
        return json(409, { error: "idempotency_conflict", detail: "different code", session_id: sessionId });
      }
      if (typeof recorded.recorded === "string") {
        const run = this.suspended.get(recorded.recorded);
        if (!run) return json(409, { error: "idempotency_incomplete", session_id: sessionId });
        return json(200, this.state(run));
      }
      return json(200, recorded.recorded);
    }
    session.runs += 1;
    const calls = this.programs.get(code);
    if (session.tools.length > 0 && calls) {
      const run: Run = { id: this.id(), sessionId, calls: [...calls], answers: [], finished: undefined };
      this.suspended.set(run.id, run);
      if (key !== null) session.ledger.set(key, { code, recorded: run.id });
      return json(200, this.state(run));
    }
    const result: Json = { execution_id: this.id(), session_id: sessionId, ...this.outcome };
    if (key !== null) session.ledger.set(key, { code, recorded: result });
    session.last = { result: result.result, console: result.console, error: result.error };
    return json(200, result);
  }

  private executeOnce(body: Json): Response {
    const result = { status: "finished", execution_id: this.id(), session_id: this.id() };
    if (body.blueprint !== "research") {
      const error = { kind: "blueprint_not_found", message: `unknown blueprint: ${String(body.blueprint)}` };
      return json(200, { ...result, result: null, console: [], error });
    }
    return json(200, { ...result, ...this.outcome });
  }

  private state(run: Run): Json {
    if (run.finished) return run.finished;
    const position = run.answers.length;
    const next = run.calls[position];
    if (next) {
      const call = { call_id: `${run.id}:${position + 1}`, tool: next[0], args: next[1] };
      return { status: "suspended", execution_id: run.id, session_id: run.sessionId, calls: [call] };
    }
    let error: Json | null = null;
    for (const answer of run.answers) {
      if (answer.ok || error) continue;
      const { kind, message } = answer.error as { kind: string; message: string };
      error =
        kind === "denied"
          ? {
              kind: "permission_denied",
              message: `PermissionDeniedError: @tools: ${message}`,
              caller: "main",
              capability: "tools.call",
              source: "harness",
            }
          : { kind: "runtime_error", message: `Error: ${message}` };
    }
    run.finished = {
      status: "finished",
      execution_id: run.id,
      session_id: run.sessionId,
      result: error ? null : JSON.stringify(run.answers.map((answer) => answer.value ?? null)),
      console: [],
      error,
    };
    const session = this.sessions.get(run.sessionId);
    if (session) session.last = { result: run.finished.result, console: [], error };
    return run.finished;
  }

  private resume(runId: string, body: Json): Response {
    const run = this.suspended.get(runId);
    if (!run) return json(404, { error: "unknown_run", execution_id: runId, message: "no such run" });
    for (const result of body.results as Json[]) {
      const sequence = Number(String(result.call_id).split(":").at(-1));
      if (sequence <= run.answers.length) continue; // answered already: changes nothing
      if (run.finished) return json(409, { error: "run_not_suspended", execution_id: runId, message: "finished" });
      if (sequence !== run.answers.length + 1) {
        return json(400, { error: "unknown_call", execution_id: runId, message: "another call" });
      }
      run.answers.push(result);
    }
    return json(200, this.state(run));
  }

  private rebind(sessionId: string, body: Json): Response {
    const session = this.sessions.get(sessionId);
    if (!session) return json(404, { error: "unknown session", session_id: sessionId });
    const secrets = (body.secrets ?? {}) as Record<string, string>;
    for (const name of this.requiredSecrets) {
      if (!secrets[name]) {
        return json(400, { error: `invalid secrets: required harness secret '${name}' is missing or empty` });
      }
    }
    session.secrets = secrets;
    this.lostSecrets.delete(sessionId);
    return new Response(null, { status: 204 });
  }

  private sessionDiscovery(sessionId: string, rest: string, params: URLSearchParams): Response {
    const session = this.sessions.get(sessionId);
    if (!session) return json(404, { error: "unknown session", session_id: sessionId });
    if (rest === "search") {
      const results: Json[] = [{ name: "@submilli/jina", description: params.get("q"), source: "registry" }];
      if (session.tools.length > 0) {
        results.push({ name: "@tools", description: "The application's tools.", source: "tools" });
      }
      return json(200, { results });
    }
    if (params.get("name") === "@tools") {
      if (session.tools.length === 0) return json(404, { error: "unknown_package", message: "unknown package: @tools" });
      const lines = session.tools.map((tool) => `function ${String(tool.name)}(args): unknown;`);
      return new Response(`# @tools\n${lines.join("\n")}`, { status: 200 });
    }
    return this.discovery("packages/docs", params);
  }

  private discovery(rest: string, params: URLSearchParams): Response {
    if (rest === "prompt") {
      this.promptFetches += 1;
      return json(200, PROMPT);
    }
    if (rest === "packages/search") {
      return json(200, { results: [{ name: "@submilli/jina", description: params.get("q"), source: "registry" }] });
    }
    if (rest === "packages/docs") {
      const name = params.get("name");
      if (name === "@submilli/jina") return new Response("# jina\nfunction searchJson(): string;", { status: 200 });
      return json(404, { error: "unknown_package", message: `unknown package: ${name}` });
    }
    if (rest === "builtins") return json(200, { namespaces: ["JSON"], types: ["Map"] });
    if (rest === "builtins/docs") {
      return json(200, { results: params.getAll("name").map((name) => ({ name, declarations: "..." })) });
    }
    return new Response(null, { status: 404 });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
