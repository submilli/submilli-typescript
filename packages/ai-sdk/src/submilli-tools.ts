// `submilliTools`: Submilli code mode for the Vercel AI SDK.

import {
  experimental_toolCaller,
  jsonSchema,
  tool,
  type Experimental_ToolCallerTool,
  type JSONValue,
  type ModelMessage,
  type Tool,
  type ToolExecutionOptions,
  type ToolSet,
} from "ai";
import {
  IdempotencyError,
  idempotencyKey,
  RunStateError,
  SessionRequiresSecretsError,
  Submilli,
  SubmilliError,
  toolResult,
  UnknownRunError,
  UnknownSessionError,
  type BlueprintPrompt,
  type PendingCall,
  type RunState,
  type ToolDeclaration,
  type ToolResult,
} from "@submilli/sdk";
import {
  approvalStatus,
  catalogDigest,
  checkTools,
  declaration,
  mayNeedApproval,
  readDecision,
  runCall,
  type ApprovalDecision,
  type ApprovalRequest,
  type ToolApproval,
} from "./app-tools.ts";
import * as m from "./messages.ts";
import { defaultStore, memorySessionStore, type SessionStore, type StoredSession } from "./store.ts";

export interface SubmilliToolsOptions {
  /** The registered Blueprint every program runs under. */
  blueprint: string;
  /**
   * The application's id for this conversation, such as its chat id. Requests
   * with the same id run their programs in one session, found in `store`.
   * Without one, the session belongs to this `SubmilliTools` alone.
   */
  conversationId?: string;
  /**
   * Values for the Blueprint's variables, from the application's own state,
   * such as the signed-in user. The model never sees or sets them.
   */
  variables?: Record<string, string>;
  /**
   * Values for the Blueprint's `harness` secrets. Sent when a session opens,
   * and again when the server asks for them after a restart. Never stored.
   */
  secrets?: Record<string, string>;
  /** The server to use. Defaults to a `Submilli` built from `baseURL` and `token`. */
  client?: Submilli;
  /** Base URL of submilli-server. Defaults to `$SUBMILLI_SERVER`, then `http://127.0.0.1:8128`. */
  baseURL?: string;
  /** API token. Defaults to `$SUBMILLI_SERVER_TOKEN`. */
  token?: string;
  /** Where each conversation's session is kept between requests. Defaults to this process's memory. */
  store?: SessionStore;
  /**
   * Programmatic tool calling: the application's own AI SDK tools, which
   * programs may call as the `@tools` Package. Each call runs here, with the
   * AI SDK's execution options, and its result goes back to the program. The
   * Blueprint must grant `tools.call`. The model is not given these tools
   * directly; add them to the tool set as well for that.
   */
  ptc?: ToolSet;
  /**
   * Which `ptc` calls need a person's approval, in the shape of the AI SDK's
   * per-tool `toolApproval`: a status (`'user-approval'`, `'approved'`,
   * `'denied'`, `'not-applicable'`) or a function of the call's input giving
   * one. A tool without an entry uses its own `needsApproval`.
   */
  toolApproval?: ToolApproval;
  /**
   * Decides approvals here, while the program waits, instead of through the
   * AI SDK's tool-approval flow. Without it, a call that needs approval pauses
   * the program, and the model asks for the approval with
   * `submilli__typescript__resume`, which the AI SDK puts to the person.
   */
  onApprovalRequired?: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;
}

/**
 * The tools the model is given. With approvals through the AI SDK's flow, the
 * set also holds `submilli__typescript__resume`.
 */
export type SubmilliToolSet = {
  /** Runs a program. Also an AI SDK tool caller, for `experimental_toolCallers`. */
  submilli__typescript__execute: Experimental_ToolCallerTool<Tool<{ code: string }, m.ExecuteOutput>>;
  submilli__typescript__last_run: Tool<Record<string, never>, JSONValue>;
  submilli__typescript__packages__search: Tool<{ query?: string }, JSONValue>;
  submilli__typescript__packages__docs: Tool<{ name: string }, string>;
  submilli__typescript__builtins__list: Tool<Record<string, never>, JSONValue>;
  submilli__typescript__builtins__docs: Tool<{ names: string[] }, JSONValue>;
};

/** The Submilli tools for one conversation, and its session. */
export interface SubmilliTools {
  /**
   * Hand these to `generateText`, `streamText`, or an agent. The execute tool
   * is also an AI SDK tool caller: tools that `experimental_toolCallers`
   * routes to `submilli__typescript__execute` become `@tools` as `ptc` do.
   */
  readonly tools: SubmilliToolSet;
  /** The conversation's id: `conversationId`, or one made up for this instance. */
  readonly conversationId: string;
  /** The conversation's session, if one is open. */
  session(): Promise<StoredSession | undefined>;
  /**
   * End the conversation's session, and forget it. The next program opens a
   * new one. `false` when there was none, or the server had already ended it.
   * Call it when the conversation ends, not after every request.
   */
  close(): Promise<boolean>;
}

/** The run's binding differs from the variables the conversation's session was opened with. */
export class SubmilliSessionMismatchError extends SubmilliError {}

/**
 * The Submilli tools for one conversation: the model writes TypeScript
 * programs, and submilli-server runs them under the Blueprint's policy.
 *
 * ```ts
 * const submilli = await submilliTools({
 *   blueprint: "research",
 *   conversationId: chat.id,
 *   variables: { userId: user.id },
 * });
 * const result = streamText({ model, tools: submilli.tools, messages });
 * ```
 *
 * Build one per request: the variables come from the request's user, and the
 * session is found again by `conversationId`.
 */
export async function submilliTools(options: SubmilliToolsOptions): Promise<SubmilliTools> {
  const client = options.client ?? new Submilli(clientOptions(options));
  const ptc = options.ptc ?? {};
  checkTools(ptc, options.toolApproval);
  const store = options.conversationId === undefined ? memorySessionStore(1) : (options.store ?? defaultStore);
  const conversation = new Conversation(
    client,
    options.blueprint,
    options.conversationId ?? crypto.randomUUID(),
    store,
    options.variables ?? {},
    options.secrets ?? {},
  );
  // Refuse a binding that differs from the conversation's session before any model call.
  await conversation.stored();
  const prompt = await promptFor(client, options.blueprint);
  const agent = new Agent(client, options, conversation, ptc, m.descriptions(prompt));
  return {
    tools: agent.tools(),
    conversationId: conversation.id,
    session: () => conversation.stored(),
    close: () => conversation.close(),
  };
}

function clientOptions(options: SubmilliToolsOptions): { baseURL?: string; token?: string } {
  const built: { baseURL?: string; token?: string } = {};
  if (options.baseURL !== undefined) built.baseURL = options.baseURL;
  if (options.token !== undefined) built.token = options.token;
  return built;
}

// Blueprint prompts, per client, kept for a few minutes: the server owns the
// text, and an operator may change the Blueprint.
const PROMPT_TTL_MS = 5 * 60_000;
const prompts = new WeakMap<Submilli, Map<string, { at: number; prompt: Promise<BlueprintPrompt> }>>();

function promptFor(client: Submilli, blueprint: string): Promise<BlueprintPrompt> {
  let cached = prompts.get(client);
  if (!cached) prompts.set(client, (cached = new Map()));
  const hit = cached.get(blueprint);
  if (hit && Date.now() - hit.at < PROMPT_TTL_MS) return hit.prompt;
  const prompt = client.blueprints.prompt(blueprint);
  cached.set(blueprint, { at: Date.now(), prompt });
  prompt.catch(() => cached.delete(blueprint));
  return prompt;
}

// A call that needs a person's approval through the AI SDK's flow: it stops
// driving the run, which waits on the server.
class AwaitingApproval extends Error {
  readonly call: PendingCall;

  constructor(call: PendingCall) {
    super(`call ${call.callId} awaits approval`);
    this.call = call;
  }
}

// The application tools a program may call, as declared to the session.
interface Catalog {
  tools: ToolSet;
  declarations: ToolDeclaration[];
  digest: string | undefined;
}

interface RunContext {
  session: StoredSession;
  catalog: Catalog;
  options: ToolExecutionOptions<unknown>;
  notice: string | undefined;
  records: m.ToolCallRecord[];
  // Calls a person approved through `submilli__typescript__resume`.
  approved: ReadonlySet<string>;
}

/** The tools of one conversation, and how each call is answered. */
class Agent {
  private readonly client: Submilli;
  private readonly options: SubmilliToolsOptions;
  private readonly conversation: Conversation;
  private readonly ptc: ToolSet;
  private readonly described: Record<string, string>;
  // Whether the model needs `submilli__typescript__resume` to ask for approvals.
  private readonly resumable: boolean;
  private readonly catalogs = new WeakMap<ToolSet, Promise<Catalog>>();
  // The application tools of the latest execute tool, for discovery and resume.
  private current: ToolSet;

  constructor(
    client: Submilli,
    options: SubmilliToolsOptions,
    conversation: Conversation,
    ptc: ToolSet,
    described: Record<string, string>,
  ) {
    this.client = client;
    this.options = options;
    this.conversation = conversation;
    this.ptc = ptc;
    this.described = described;
    this.resumable = options.onApprovalRequired === undefined && mayNeedApproval(ptc, options.toolApproval);
    this.current = ptc;
  }

  tools(): SubmilliToolSet {
    const tools: SubmilliToolSet = {
      [m.EXECUTE]: experimental_toolCaller(this.executeTool(this.ptc), {
        type: "local",
        bind: (routed) => this.executeTool({ ...routed, ...this.ptc }),
      }),
      [m.LAST_RUN]: tool({
        description: this.described[m.LAST_RUN]!,
        inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
        execute: async (_input, options) => this.lastRun(options),
      }),
      [m.PACKAGES_SEARCH]: tool({
        description: this.described[m.PACKAGES_SEARCH]!,
        inputSchema: jsonSchema<{ query?: string }>({
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Substring matched against module names, descriptions, and exported symbols. " +
                "Empty lists every available package.",
            },
          },
          additionalProperties: false,
        }),
        execute: async ({ query }, options) => this.searchPackages(query ?? "", options),
      }),
      [m.PACKAGES_DOCS]: tool({
        description: this.described[m.PACKAGES_DOCS]!,
        inputSchema: jsonSchema<{ name: string }>({
          type: "object",
          properties: { name: { type: "string", description: "Package name, e.g. `submilli:crypto`." } },
          required: ["name"],
          additionalProperties: false,
        }),
        execute: async ({ name }, options) => this.packageDocs(name, options),
      }),
      [m.BUILTINS_LIST]: tool({
        description: this.described[m.BUILTINS_LIST]!,
        inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
        execute: async (_input, options) =>
          (await this.client.blueprints.builtins(this.options.blueprint, { signal: options.abortSignal })) as JSONValue,
      }),
      [m.BUILTINS_DOCS]: tool({
        description: this.described[m.BUILTINS_DOCS]!,
        inputSchema: jsonSchema<{ names: string[] }>({
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description:
                'Built-in names to look up, e.g. `["Array", "Map", "Temporal"]`. Each returns its declarations; ' +
                "unknown names come back with an `error` entry.",
            },
          },
          required: ["names"],
          additionalProperties: false,
        }),
        execute: async ({ names }, options) =>
          (await this.client.blueprints.builtinDocs(this.options.blueprint, names, {
            signal: options.abortSignal,
          })) as JSONValue,
      }),
    };
    if (this.resumable) (tools as ToolSet)[m.RESUME] = this.resumeTool();
    return tools;
  }

  // Execute

  private executeTool(app: ToolSet): Tool<{ code: string }, m.ExecuteOutput> {
    const names = Object.keys(app);
    const approvals = this.options.onApprovalRequired !== undefined || mayNeedApproval(app, this.options.toolApproval);
    return tool({
      description: this.described[m.EXECUTE]! + m.applicationToolsPrompt(names, approvals),
      inputSchema: jsonSchema<{ code: string }>({
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "TypeScript-subset source with a `main()` entry point. Its return value is the tool result.",
          },
        },
        required: ["code"],
        additionalProperties: false,
      }),
      execute: async ({ code }, options) => {
        this.current = app;
        return this.execute(code, await this.catalog(app), options as ToolExecutionOptions<unknown>);
      },
      toModelOutput: ({ output }) => ({ type: "json", value: m.modelView(output) as JSONValue }),
    });
  }

  private async execute(code: string, catalog: Catalog, options: ToolExecutionOptions<unknown>): Promise<m.ExecuteOutput> {
    let session = await this.conversation.session(catalog, options.abortSignal);
    if (this.resumable) await this.abandonWaiting(session, catalog, options);
    const key = options.toolCallId ? await idempotencyKey(options.toolCallId) : undefined;
    let notice: string | undefined;
    let rebound = false;
    let state: RunState;
    for (;;) {
      try {
        state = await this.client.sessions.execute(session.id, code, {
          ...(key ? { idempotencyKey: key } : {}),
          signal: options.abortSignal,
        });
        break;
      } catch (error) {
        if (error instanceof UnknownSessionError && notice === undefined) {
          session = await this.conversation.replace(session, catalog, options.abortSignal);
          notice = m.SESSION_REPLACED_NOTE;
          continue;
        }
        if (error instanceof SessionRequiresSecretsError) {
          if (rebound) {
            throw new SubmilliError(
              `submilli-server still asks for harness secrets ${error.required.join(", ")} after a rebind; ` +
                "check the `secrets` given to submilliTools",
              { cause: error },
            );
          }
          await this.client.sessions.rebind(session.id, this.options.secrets ?? {}, { signal: options.abortSignal });
          rebound = true;
          continue;
        }
        if (error instanceof IdempotencyError) return m.idempotencyOutput(error, session.id);
        if (error instanceof RunStateError) return m.runStateOutput(error, session.id, { notice, toolCalls: [] });
        throw error;
      }
    }
    return this.drive(state, { session, catalog, options, notice, records: [], approved: new Set() });
  }

  /** Answer the run's calls to the application's tools until it finishes, or waits on an approval. */
  private async drive(state: RunState, context: RunContext): Promise<m.ExecuteOutput> {
    const { session, notice, records } = context;
    const extra = { notice, toolCalls: records };
    try {
      const result = await this.client.runs.complete(state, {
        onToolCall: (call) => this.answer(call, context),
        signal: context.options.abortSignal,
      });
      return m.executeOutput(result, extra);
    } catch (error) {
      if (error instanceof AwaitingApproval) {
        return m.awaitingOutput(error.call.executionId, session.id, [error.call], extra);
      }
      if (error instanceof UnknownRunError) return m.lostRunOutput(state.executionId, session.id, extra);
      if (error instanceof RunStateError) return m.runStateOutput(error, session.id, extra);
      throw error;
    }
  }

  private async answer(call: PendingCall, context: RunContext): Promise<ToolResult> {
    const record: m.ToolCallRecord = { call_id: call.callId, tool: call.tool, args: call.args, outcome: "ok" };
    context.records.push(record);
    const finish = (result: ToolResult): ToolResult => {
      record.outcome = result.ok ? "ok" : result.kind;
      return result;
    };
    const app = context.catalog.tools[call.tool];
    if (!app) return finish(toolResult.failed(call.callId, `the application has no tool named '${call.tool}'`));
    if (context.approved.has(call.callId)) {
      record.decision = "approved";
      return finish(await runCall(call, app, context.options));
    }
    const status = await approvalStatus(call.tool, app, this.options.toolApproval, call.args, context.options, call.callId);
    if (status.type === "denied") {
      return finish(toolResult.denied(call.callId, status.reason ?? `The application refused this call to ${call.tool}.`));
    }
    if (status.type !== "user-approval") return finish(await runCall(call, app, context.options));
    const ask = this.options.onApprovalRequired;
    if (ask) {
      const request: ApprovalRequest = {
        toolName: call.tool,
        input: call.args,
        toolCallId: call.callId,
        executionId: call.executionId,
      };
      if (status.reason !== undefined) request.reason = status.reason;
      const decision = readDecision(await ask(request));
      record.decision = decision.approved ? "approved" : "denied";
      if (!decision.approved) {
        return finish(toolResult.denied(call.callId, decision.reason ?? `A person refused this call to ${call.tool}.`));
      }
      return finish(await runCall(call, app, context.options));
    }
    if (this.resumable && call.tool in this.ptc) {
      record.outcome = "awaiting_approval";
      throw new AwaitingApproval(call);
    }
    return finish(
      toolResult.denied(
        call.callId,
        `${call.tool} needs a person's approval, and this agent has no way to ask for it: pass the tool in ptc, ` +
          "or give submilliTools onApprovalRequired.",
      ),
    );
  }

  // Approvals through the AI SDK's tool-approval flow

  private resumeTool(): Tool<m.ResumeInput, m.ExecuteOutput> {
    return tool({
      description: m.RESUME_DESCRIPTION,
      inputSchema: jsonSchema<m.ResumeInput>({
        type: "object",
        properties: {
          execution_id: { type: "string" },
          calls: {
            type: "array",
            items: {
              type: "object",
              properties: { call_id: { type: "string" }, tool: { type: "string" }, args: { type: "object" } },
              required: ["call_id", "tool", "args"],
            },
          },
        },
        required: ["execution_id", "calls"],
        additionalProperties: false,
      }),
      // The person is shown this call's input: the waiting calls, which the
      // execute below checks against the run before it answers them.
      needsApproval: true,
      execute: async (input, options) => this.resume(input, options as ToolExecutionOptions<unknown>),
      toModelOutput: ({ output }) => ({ type: "json", value: m.modelView(output) as JSONValue }),
    });
  }

  private async resume(input: m.ResumeInput, options: ToolExecutionOptions<unknown>): Promise<m.ExecuteOutput> {
    if (!approvedInMessages(options.messages, options.toolCallId)) {
      // The generation's own `toolApproval` let this run without asking.
      throw new SubmilliError(
        `${m.RESUME} ran without a person's approval in the conversation. If generateText is given a ` +
          `toolApproval function, it must answer 'user-approval' for ${m.RESUME}.`,
      );
    }
    // The run belongs to the session that is open now, whatever tools this
    // request knows: in another process, only `ptc` are known.
    const session = await this.conversation.stored();
    if (!session) throw new SubmilliError(`run ${input.execution_id} waits in a session this conversation no longer has`);
    const catalog = await this.catalog(this.current);
    let state: RunState;
    try {
      state = await this.client.runs.retrieve(input.execution_id, { signal: options.abortSignal });
    } catch (error) {
      if (error instanceof UnknownRunError) return m.lostRunOutput(input.execution_id, session.id, { toolCalls: [] });
      if (error instanceof RunStateError) return m.runStateOutput(error, session.id, { toolCalls: [] });
      throw error;
    }
    if (state.sessionId !== session.id) {
      throw new SubmilliError(`run ${input.execution_id} does not belong to this conversation's session`);
    }
    const waiting = state.status === "suspended" ? state.calls : [];
    if (!sameCalls(input.calls, waiting)) return m.staleResumeOutput(input, session.id, waiting);
    const approved = new Set(waiting.map((call) => call.callId));
    return this.drive(state, { session, catalog, options, notice: undefined, records: [], approved });
  }

  /**
   * Refuse the calls of runs this conversation left waiting on an approval.
   *
   * A run left waiting would hold its call until the Blueprint's
   * `tool_call_timeout`, when the call throws `TimeoutError` and the program
   * carries on where nobody sees it. So before a new program runs, each run
   * the conversation shows waiting is answered: refused, with the person's
   * reason when they refused it.
   */
  private async abandonWaiting(
    session: StoredSession,
    catalog: Catalog,
    options: ToolExecutionOptions<unknown>,
  ): Promise<void> {
    for (const { executionId, reason } of waitingRuns(options.messages)) {
      let state: RunState;
      try {
        state = await this.client.runs.retrieve(executionId, { signal: options.abortSignal });
      } catch {
        continue;
      }
      if (state.status !== "suspended" || state.sessionId !== session.id) continue;
      const refusal =
        reason ?? "Not approved: the conversation moved on before a person approved this call, so it did not run.";
      const refused = new Set(state.calls.map((call) => call.callId));
      const context: RunContext = { session, catalog, options, notice: undefined, records: [], approved: new Set() };
      try {
        await this.client.runs.complete(state, {
          signal: options.abortSignal,
          onToolCall: async (call) => {
            if (refused.has(call.callId)) return toolResult.denied(call.callId, refusal);
            try {
              return await this.answer(call, context);
            } catch (error) {
              if (!(error instanceof AwaitingApproval)) throw error;
              return toolResult.denied(call.callId, "Not asked: a person refused an earlier call in this program.");
            }
          },
        });
      } catch (error) {
        if (options.abortSignal?.aborted) throw error;
      }
    }
  }

  // Discovery

  private async lastRun(options: ToolExecutionOptions<unknown>): Promise<JSONValue> {
    const session = await this.conversation.stored();
    if (!session) return "No program has run in this conversation yet.";
    const run = await this.client.sessions.lastRun(session.id, { signal: options.abortSignal });
    if (!run) {
      return (
        "No run is recorded for this conversation's session. " +
        "The server keeps runs in memory, so a restart clears them."
      );
    }
    return run.raw as JSONValue;
  }

  private async searchPackages(query: string, options: ToolExecutionOptions<unknown>): Promise<JSONValue> {
    const signal = { signal: options.abortSignal };
    if (Object.keys(this.current).length === 0) {
      return (await this.client.blueprints.searchPackages(this.options.blueprint, query, signal)) as JSONValue;
    }
    // With application tools, search through the session, so `@tools` is included.
    return (await this.inSession(options, (id) => this.client.sessions.searchPackages(id, query, signal))) as JSONValue;
  }

  private async packageDocs(name: string, options: ToolExecutionOptions<unknown>): Promise<string> {
    const signal = { signal: options.abortSignal };
    if (Object.keys(this.current).length === 0) {
      return (await this.client.blueprints.packageDocs(this.options.blueprint, name, signal)).text;
    }
    return (await this.inSession(options, (id) => this.client.sessions.packageDocs(id, name, signal))).text;
  }

  private async inSession<T>(options: ToolExecutionOptions<unknown>, fetch: (sessionId: string) => Promise<T>): Promise<T> {
    const catalog = await this.catalog(this.current);
    const session = await this.conversation.session(catalog, options.abortSignal);
    try {
      return await fetch(session.id);
    } catch (error) {
      if (!(error instanceof UnknownSessionError)) throw error;
      return fetch((await this.conversation.replace(session, catalog, options.abortSignal)).id);
    }
  }

  private catalog(app: ToolSet): Promise<Catalog> {
    let catalog = this.catalogs.get(app);
    if (!catalog) {
      catalog = (async () => {
        const declarations = await Promise.all(Object.entries(app).map(([name, item]) => declaration(name, item)));
        return { tools: app, declarations, digest: await catalogDigest(declarations) };
      })();
      this.catalogs.set(app, catalog);
    }
    return catalog;
  }
}

/** One conversation's session: found in the store, opened when first needed, replaced when it ends. */
class Conversation {
  readonly id: string;
  private readonly client: Submilli;
  private readonly blueprint: string;
  private readonly store: SessionStore;
  private readonly variables: Record<string, string>;
  private readonly secrets: Record<string, string>;
  // Sessions opened to replace an ended one, by the ended one's id, so that
  // parallel calls that all find it gone open one replacement between them.
  private readonly replacements = new Map<string, Promise<StoredSession>>();

  constructor(
    client: Submilli,
    blueprint: string,
    id: string,
    store: SessionStore,
    variables: Record<string, string>,
    secrets: Record<string, string>,
  ) {
    this.client = client;
    this.blueprint = blueprint;
    this.id = id;
    this.store = store;
    this.variables = variables;
    this.secrets = secrets;
    for (const [name, value] of Object.entries({ ...variables, ...secrets })) {
      if (typeof value !== "string") {
        throw new TypeError(`Submilli variables and secrets must be strings; got ${name}: ${typeof value}`);
      }
    }
  }

  /** The conversation's session on this server for this Blueprint, if it has one. */
  async stored(): Promise<StoredSession | undefined> {
    const session = await this.store.get(this.id);
    if (!session || session.server !== this.client.baseURL || session.blueprint !== this.blueprint) return undefined;
    this.check(session);
    return session;
  }

  /** The session for `catalog`, opened if the conversation has none with those tools. */
  async session(catalog: Catalog, signal: AbortSignal | undefined): Promise<StoredSession> {
    return lock(this.store, this.id, async () => {
      const session = await this.stored();
      // A session keeps the tools it was opened with for life.
      if (session && session.tools === catalog.digest) return session;
      return this.open(catalog, signal);
    });
  }

  /** A new session in place of `ended`, which the server no longer knows. */
  replace(ended: StoredSession, catalog: Catalog, signal: AbortSignal | undefined): Promise<StoredSession> {
    let replacement = this.replacements.get(ended.id);
    if (!replacement) {
      replacement = lock(this.store, this.id, async () => {
        const session = await this.stored();
        if (session && session.id !== ended.id && session.tools === catalog.digest) return session;
        return this.open(catalog, signal);
      });
      this.replacements.set(ended.id, replacement);
      replacement.catch(() => this.replacements.delete(ended.id));
    }
    return replacement;
  }

  async close(): Promise<boolean> {
    const session = await this.stored();
    if (!session) return false;
    const deleted = await this.client.sessions.delete(session.id);
    await this.store.delete(this.id);
    return deleted;
  }

  private async open(catalog: Catalog, signal: AbortSignal | undefined): Promise<StoredSession> {
    const created = await this.client.sessions.create(this.blueprint, {
      variables: this.variables,
      secrets: this.secrets,
      tools: catalog.declarations,
      signal,
    });
    for (const warning of created.warnings) console.warn(`submilli-server: ${warning}`);
    const session: StoredSession = {
      id: created.id,
      server: this.client.baseURL,
      blueprint: this.blueprint,
      variables: { ...this.variables },
    };
    if (catalog.digest !== undefined) session.tools = catalog.digest;
    await this.store.set(this.id, session);
    return session;
  }

  private check(session: StoredSession): void {
    const names = new Set([...Object.keys(session.variables), ...Object.keys(this.variables)]);
    const differing = [...names].filter((name) => session.variables[name] !== this.variables[name]).sort();
    if (differing.length === 0) return;
    throw new SubmilliSessionMismatchError(
      "This conversation's Submilli session was opened with different variables than this request gives " +
        `(differing: ${differing.join(", ")}). A session is never shared between bindings: use another ` +
        "conversationId for this binding, or end the conversation's session first with close().",
    );
  }
}

// In-process locks per store and conversation, so that parallel tool calls
// open one session between them.
const locks = new WeakMap<SessionStore, Map<string, Promise<unknown>>>();

function lock<T>(store: SessionStore, key: string, work: () => Promise<T>): Promise<T> {
  let held = locks.get(store);
  if (!held) locks.set(store, (held = new Map()));
  const previous = held.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  held.set(key, settled);
  void settled.then(() => {
    if (held.get(key) === settled) held.delete(key);
  });
  return next;
}

function sameCalls(asked: m.ResumeInput["calls"], waiting: readonly PendingCall[]): boolean {
  if (asked.length !== waiting.length || asked.length === 0) return false;
  return asked.every((call, index) => {
    const pending = waiting[index]!;
    return (
      call.call_id === pending.callId &&
      call.tool === pending.tool &&
      JSON.stringify(sortKeys(call.args)) === JSON.stringify(sortKeys(pending.args))
    );
  });
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

/** Whether a person approved the tool call `toolCallId`, as the conversation records it. */
function approvedInMessages(messages: readonly ModelMessage[], toolCallId: string): boolean {
  const requests = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-request" && part.toolCallId === toolCallId) requests.add(part.approvalId);
    }
  }
  return messages.some(
    (message) =>
      message.role === "tool" &&
      message.content.some(
        (part) => part.type === "tool-approval-response" && part.approved && requests.has(part.approvalId),
      ),
  );
}

/**
 * The runs the conversation shows waiting on an approval, with the person's
 * reason when they refused it.
 */
function waitingRuns(messages: readonly ModelMessage[]): { executionId: string; reason: string | undefined }[] {
  const waiting = new Map<string, string | undefined>();
  // The resume calls the model made, by tool call id, and the run each names.
  const resumes = new Map<string, string>();
  const approvals = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && typeof message.content !== "string") {
      for (const part of message.content) {
        if (part.type === "tool-call" && part.toolName === m.RESUME) {
          const input = part.input as Partial<m.ResumeInput> | undefined;
          if (typeof input?.execution_id === "string") resumes.set(part.toolCallId, input.execution_id);
        }
        if (part.type === "tool-approval-request") approvals.set(part.approvalId, part.toolCallId);
      }
    }
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && (part.toolName === m.EXECUTE || part.toolName === m.RESUME)) {
        const value = part.output.type === "json" ? (part.output.value as Record<string, unknown> | null) : null;
        const awaiting = value?.awaiting_approval as { resume_input?: { execution_id?: unknown } } | undefined;
        const executionId = awaiting?.resume_input?.execution_id;
        if (typeof executionId === "string") waiting.set(executionId, undefined);
      }
      if (part.type === "tool-approval-response" && !part.approved) {
        const executionId = resumes.get(approvals.get(part.approvalId) ?? "");
        if (executionId !== undefined && waiting.has(executionId)) {
          waiting.set(executionId, part.reason ? `A person refused this call: ${part.reason}` : "A person refused this call.");
        }
      }
    }
  }
  return [...waiting].map(([executionId, reason]) => ({ executionId, reason }));
}
