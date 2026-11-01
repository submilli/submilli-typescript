// `createSubmilliTools`: Submilli code mode for Mastra agents.

import type { MastraMemory } from "@mastra/core/memory";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool, type RequireToolApproval, type Tool, type ToolExecutionContext } from "@mastra/core/tools";
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
  type JSONSchema,
  type PendingCall,
  type RunState,
  type ToolDeclaration,
  type ToolResult,
} from "@submilli/sdk";
import {
  catalogDigest,
  checkTools,
  declaration,
  mayNeedApproval,
  needsApproval,
  readDecision,
  runCall,
  type ApplicationTools,
  type ApprovalDecision,
  type ApprovalRequest,
} from "./app-tools.ts";
import * as m from "./messages.ts";
import {
  defaultStore,
  memorySessionStore,
  threadSessionStore,
  type SessionStore,
  type StoredSession,
} from "./store.ts";

/** What a run's Blueprint variables and secrets may be read from: the agent run's trusted context. */
export interface BindingContext {
  /** The request context the application passed to `generate` or `stream`. */
  requestContext: RequestContext | undefined;
  /** The memory resource of the agent run, usually the signed-in user. */
  resourceId: string | undefined;
  /** The memory thread of the agent run. */
  threadId: string | undefined;
}

/** Fixed values, or a function of the agent run's trusted context giving them. */
export type Binding =
  | Record<string, string>
  | ((context: BindingContext) => Record<string, string> | Promise<Record<string, string>>);

export interface SubmilliToolsOptions {
  /** The registered Blueprint every program runs under. */
  blueprint: string;
  /**
   * Values for the Blueprint's variables, from the application's own state:
   * fixed, or read from each agent run's request context or memory resource.
   * The model never sees or sets them.
   */
  variables?: Binding;
  /**
   * Values for the Blueprint's `harness` secrets, given the same way. Sent when
   * a session opens, and again when the server asks for them after a restart.
   * Never stored.
   */
  secrets?: Binding;
  /** The server to use. Defaults to a `Submilli` built from `baseURL` and `token`. */
  client?: Submilli;
  /** Base URL of submilli-server. Defaults to `$SUBMILLI_SERVER`, then `http://127.0.0.1:8128`. */
  baseURL?: string;
  /** API token. Defaults to `$SUBMILLI_SERVER_TOKEN`. */
  token?: string;
  /**
   * Where each thread's session is kept between agent runs. Defaults to the
   * thread's metadata in the agent's memory, and to this process's memory for
   * an agent without memory.
   */
  store?: SessionStore;
  /**
   * Programmatic tool calling: the application's own Mastra tools, which
   * programs may call as the `@tools` Package. Each call runs here, with the
   * execute tool's Mastra context, and its result goes back to the program.
   * The Blueprint must grant `tools.call`. The model is not given these tools
   * directly; give them to the agent as well for that.
   */
  ptc?: ApplicationTools;
  /**
   * Which `ptc` calls need a person's approval, as Mastra's
   * `requireToolApproval`: `true` for every call, or a function of the call.
   * A tool's own `requireApproval` applies as it does for the model's calls.
   */
  requireToolApproval?: RequireToolApproval;
  /**
   * Decides approvals here, while the program waits, instead of through
   * Mastra's suspend and resume. Without it, a call that needs approval
   * suspends the agent run, and the application resumes it with
   * `agent.resumeGenerate({ approved }, { runId, toolCallId })`.
   */
  onApprovalRequired?: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;
}

/** The tools the model is given, by the server's own names. */
export type SubmilliToolSet = {
  /** Runs a program. Suspends the agent run while a program's call waits on a person. */
  submilli__typescript__execute: Tool<{ code: string }, m.ExecuteOutput | undefined, m.ApprovalPayload, m.ApprovalAnswer>;
  submilli__typescript__last_run: Tool<Record<string, never>, unknown>;
  submilli__typescript__packages__search: Tool<{ query?: string }, unknown>;
  submilli__typescript__packages__docs: Tool<{ name: string }, string>;
  submilli__typescript__builtins__list: Tool<Record<string, never>, unknown>;
  submilli__typescript__builtins__docs: Tool<{ names: string[] }, unknown>;
};

/** A thread, for reading or ending its session outside an agent run. */
export interface ThreadRef {
  threadId: string;
  /** The agent's memory, when the session is kept in the thread's metadata (the default). */
  memory?: MastraMemory;
}

/** Submilli code mode for Mastra agents: the tools, and each thread's session. */
export interface SubmilliTools {
  /**
   * The tools to give an agent, with the Blueprint's descriptions. Pass the
   * method itself as the agent's `tools`, or spread its result into them.
   */
  tools(): Promise<SubmilliToolSet>;
  /** The thread's session, if one is open. */
  session(thread: ThreadRef): Promise<StoredSession | undefined>;
  /**
   * End the thread's session, and forget it. The next program opens a new one.
   * `false` when there was none, or the server had already ended it. Call it
   * when the thread is deleted or archived, not after every agent run.
   */
  close(thread: ThreadRef): Promise<boolean>;
}

/** The run's binding differs from the variables the thread's session was opened with. */
export class SubmilliSessionMismatchError extends SubmilliError {}

/**
 * Submilli code mode for Mastra agents: the model writes TypeScript programs,
 * and submilli-server runs them under the Blueprint's policy.
 *
 * ```ts
 * const submilli = createSubmilliTools({
 *   blueprint: "research",
 *   variables: ({ resourceId }) => ({ userId: resourceId! }),
 * });
 * const agent = new Agent({ id: "researcher", model, memory, tools: () => submilli.tools() });
 * await agent.generate(question, { memory: { thread: chat.id, resource: user.id } });
 * ```
 *
 * Create one per process: each agent run's thread finds its own session.
 */
export function createSubmilliTools(options: SubmilliToolsOptions): SubmilliTools {
  const client = options.client ?? new Submilli(clientOptions(options));
  const ptc = options.ptc ?? {};
  checkTools(ptc);
  const agent = new Agent(client, options, ptc);
  return {
    tools: () => agent.tools(),
    session: async (thread) => {
      const session = await storeFor(options, thread.memory, thread.threadId).get(thread.threadId);
      return session && sameTarget(session, client, options.blueprint) ? session : undefined;
    },
    close: async (thread) => {
      const store = storeFor(options, thread.memory, thread.threadId);
      return lock(store, thread.threadId, async () => {
        const session = await store.get(thread.threadId);
        if (!session || !sameTarget(session, client, options.blueprint)) return false;
        const deleted = await client.sessions.delete(session.id);
        await store.delete(thread.threadId);
        return deleted;
      });
    },
  };
}

function clientOptions(options: SubmilliToolsOptions): { baseURL?: string; token?: string } {
  const built: { baseURL?: string; token?: string } = {};
  if (options.baseURL !== undefined) built.baseURL = options.baseURL;
  if (options.token !== undefined) built.token = options.token;
  return built;
}

function storeFor(options: SubmilliToolsOptions, memory: MastraMemory | undefined, threadId: string | undefined): SessionStore {
  if (options.store) return options.store;
  return memory && threadId !== undefined ? threadSessionStore(memory) : defaultStore;
}

function sameTarget(session: StoredSession, client: Submilli, blueprint: string): boolean {
  return session.server === client.baseURL && session.blueprint === blueprint;
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

// A call that needs a person's approval through Mastra's suspend: it stops
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
  declarations: ToolDeclaration[];
  digest: string | undefined;
}

interface RunContext {
  session: StoredSession;
  context: MastraContext;
  notice: string | undefined;
  records: m.ToolCallRecord[];
  // Calls a person decided on through Mastra's resume: approved, or refused with a reason.
  decided: ReadonlyMap<string, { approved: boolean; reason: string }>;
}

// Mastra's own context fields that its public types leave out.
type MastraContext = ToolExecutionContext & {
  memory?: MastraMemory;
  runId?: string;
};

const EMPTY_OBJECT: JSONSchema = { type: "object", properties: {}, additionalProperties: false };

/** The tools, and how each call is answered. */
class Agent {
  private readonly client: Submilli;
  private readonly options: SubmilliToolsOptions;
  private readonly ptc: ApplicationTools;
  private readonly approvals: boolean;
  private catalogPromise: Promise<Catalog> | undefined;

  constructor(client: Submilli, options: SubmilliToolsOptions, ptc: ApplicationTools) {
    this.client = client;
    this.options = options;
    this.ptc = ptc;
    this.approvals = options.onApprovalRequired !== undefined || mayNeedApproval(ptc, options.requireToolApproval);
  }

  async tools(): Promise<SubmilliToolSet> {
    const described = m.descriptions(await promptFor(this.client, this.options.blueprint));
    const blueprint = this.options.blueprint;
    return {
      [m.EXECUTE]: createTool({
        id: m.EXECUTE,
        description: described[m.EXECUTE]! + m.applicationToolsPrompt(Object.keys(this.ptc), this.approvals),
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "TypeScript-subset source with a `main()` entry point. Its return value is the tool result.",
            },
          },
          required: ["code"],
          additionalProperties: false,
        } as JSONSchema,
        suspendSchema: {
          type: "object",
          properties: {
            execution_id: { type: "string" },
            calls: {
              type: "array",
              items: {
                type: "object",
                properties: { tool: { type: "string" }, args: { type: "object" } },
                required: ["tool", "args"],
              },
            },
            tool_calls: { type: "array", items: { type: "object" } },
          },
          required: ["execution_id", "calls"],
        } as JSONSchema,
        resumeSchema: {
          type: "object",
          properties: { approved: { type: "boolean" }, reason: { type: "string" } },
          required: ["approved"],
        } as JSONSchema,
        execute: async (input, context) =>
          this.execute((input as { code: string }).code, context as unknown as MastraContext),
        toModelOutput: (output) => ({ type: "json", value: m.modelView(output as m.ExecuteOutput) }),
      }) as unknown as SubmilliToolSet[typeof m.EXECUTE],
      [m.LAST_RUN]: createTool({
        id: m.LAST_RUN,
        description: described[m.LAST_RUN]!,
        inputSchema: EMPTY_OBJECT,
        execute: async (_input, context) => this.lastRun(context as unknown as MastraContext),
      }) as unknown as SubmilliToolSet[typeof m.LAST_RUN],
      [m.PACKAGES_SEARCH]: createTool({
        id: m.PACKAGES_SEARCH,
        description: described[m.PACKAGES_SEARCH]!,
        inputSchema: {
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
        } as JSONSchema,
        execute: async (input, context) =>
          this.searchPackages((input as { query?: string }).query ?? "", context as unknown as MastraContext),
      }) as unknown as SubmilliToolSet[typeof m.PACKAGES_SEARCH],
      [m.PACKAGES_DOCS]: createTool({
        id: m.PACKAGES_DOCS,
        description: described[m.PACKAGES_DOCS]!,
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", description: "Package name, e.g. `submilli:crypto`." } },
          required: ["name"],
          additionalProperties: false,
        } as JSONSchema,
        execute: async (input, context) =>
          this.packageDocs((input as { name: string }).name, context as unknown as MastraContext),
      }) as unknown as SubmilliToolSet[typeof m.PACKAGES_DOCS],
      [m.BUILTINS_LIST]: createTool({
        id: m.BUILTINS_LIST,
        description: described[m.BUILTINS_LIST]!,
        inputSchema: EMPTY_OBJECT,
        execute: async (_input, context) => this.client.blueprints.builtins(blueprint, { signal: context.abortSignal }),
      }) as unknown as SubmilliToolSet[typeof m.BUILTINS_LIST],
      [m.BUILTINS_DOCS]: createTool({
        id: m.BUILTINS_DOCS,
        description: described[m.BUILTINS_DOCS]!,
        inputSchema: {
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
        } as JSONSchema,
        execute: async (input, context) =>
          this.client.blueprints.builtinDocs(blueprint, (input as { names: string[] }).names, {
            signal: context.abortSignal,
          }),
      }) as unknown as SubmilliToolSet[typeof m.BUILTINS_DOCS],
    };
  }

  // Execute

  private async execute(code: string, context: MastraContext): Promise<m.ExecuteOutput | undefined> {
    const thread = await this.thread(context);
    const catalog = await this.catalog();
    const payload = context.agent?.suspendPayload ?? context.workflow?.suspendPayload;
    const answer = context.agent?.resumeData ?? context.workflow?.resumeData;
    if (isApprovalAnswer(answer) && isApprovalPayload(payload)) return this.resume(thread, payload, answer, context);

    let session = await thread.session(catalog, context.abortSignal);
    await this.abandonWaiting(thread, session, context);
    const toolCallId = context.agent?.toolCallId;
    const key = toolCallId ? await idempotencyKey(toolCallId) : undefined;
    let notice: string | undefined;
    let rebound = false;
    let state: RunState;
    for (;;) {
      try {
        state = await this.client.sessions.execute(session.id, code, {
          ...(key ? { idempotencyKey: key } : {}),
          signal: context.abortSignal,
        });
        break;
      } catch (error) {
        if (error instanceof UnknownSessionError && notice === undefined) {
          session = await thread.replace(session, catalog, context.abortSignal);
          notice = m.SESSION_REPLACED_NOTE;
          continue;
        }
        if (error instanceof SessionRequiresSecretsError) {
          if (rebound) {
            throw new SubmilliError(
              `submilli-server still asks for harness secrets ${error.required.join(", ")} after a rebind; ` +
                "check the `secrets` given to createSubmilliTools",
              { cause: error },
            );
          }
          await this.client.sessions.rebind(session.id, thread.secrets, { signal: context.abortSignal });
          rebound = true;
          continue;
        }
        if (error instanceof IdempotencyError) return m.idempotencyOutput(error, session.id);
        if (error instanceof RunStateError) return m.runStateOutput(error, session.id, { notice, toolCalls: [] });
        throw error;
      }
    }
    return this.drive(state, thread, { session, context, notice, records: [], decided: new Map() });
  }

  /**
   * Answer the run's calls to the application's tools until it finishes, or
   * suspend the agent run while a call waits on a person's approval.
   */
  private async drive(state: RunState, thread: Thread, run: RunContext): Promise<m.ExecuteOutput | undefined> {
    const { session, notice, records } = run;
    const extra = { notice, toolCalls: records };
    try {
      const result = await this.client.runs.complete(state, {
        onToolCall: (call) => this.answer(call, run),
        signal: run.context.abortSignal,
      });
      return m.executeOutput(result, extra);
    } catch (error) {
      if (error instanceof AwaitingApproval) return this.suspend(error.call, thread, run);
      if (error instanceof UnknownRunError) return m.lostRunOutput(state.executionId, session.id, extra);
      if (error instanceof RunStateError) return m.runStateOutput(error, session.id, extra);
      throw error;
    }
  }

  private async answer(call: PendingCall, run: RunContext): Promise<ToolResult> {
    const record: m.ToolCallRecord = { call_id: call.callId, tool: call.tool, args: call.args, outcome: "ok" };
    run.records.push(record);
    const finish = (result: ToolResult): ToolResult => {
      record.outcome = result.ok ? "ok" : result.kind;
      return result;
    };
    const app = this.ptc[call.tool];
    if (!app) return finish(toolResult.failed(call.callId, `the application has no tool named '${call.tool}'`));
    const decided = run.decided.get(call.callId);
    if (decided) {
      record.decision = decided.approved ? "approved" : "denied";
      if (!decided.approved) return finish(toolResult.denied(call.callId, decided.reason));
      return finish(await runCall(call, app, run.context));
    }
    if (!(await needsApproval(call.tool, app, this.options.requireToolApproval, call.args, run.context))) {
      return finish(await runCall(call, app, run.context));
    }
    const ask = this.options.onApprovalRequired;
    if (ask) {
      const request: ApprovalRequest = {
        toolName: call.tool,
        input: call.args,
        toolCallId: call.callId,
        executionId: call.executionId,
      };
      const decision = readDecision(await ask(request));
      record.decision = decision.approved ? "approved" : "denied";
      if (!decision.approved) {
        return finish(toolResult.denied(call.callId, decision.reason ?? `A person refused this call to ${call.tool}.`));
      }
      return finish(await runCall(call, app, run.context));
    }
    if (suspender(run.context)) {
      record.outcome = "awaiting_approval";
      throw new AwaitingApproval(call);
    }
    return finish(
      toolResult.denied(
        call.callId,
        `${call.tool} needs a person's approval, and this tool call cannot suspend to ask for it: run it in an ` +
          "agent or workflow, or give createSubmilliTools onApprovalRequired.",
      ),
    );
  }

  // Approvals through Mastra's suspend and resume

  private async suspend(call: PendingCall, thread: Thread, run: RunContext): Promise<undefined> {
    const suspend = suspender(run.context)!;
    const payload: m.ApprovalPayload = {
      execution_id: call.executionId,
      calls: [{ tool: call.tool, args: call.args }],
    };
    const earlier = run.records.filter((record) => record.outcome !== "awaiting_approval");
    if (earlier.length > 0) payload.tool_calls = earlier;
    const agentRunId = run.context.runId;
    if (agentRunId !== undefined) await thread.track(call.executionId, agentRunId);
    await suspend(payload);
    return undefined;
  }

  private async resume(
    thread: Thread,
    payload: m.ApprovalPayload,
    answer: m.ApprovalAnswer,
    context: MastraContext,
  ): Promise<m.ExecuteOutput | undefined> {
    // The run belongs to the thread's session, whichever process suspended it.
    const session = await thread.stored();
    if (!session) throw new SubmilliError(`run ${payload.execution_id} waits in a session this thread no longer has`);
    await thread.untrack(payload.execution_id);
    let state: RunState;
    try {
      state = await this.client.runs.retrieve(payload.execution_id, { signal: context.abortSignal });
    } catch (error) {
      if (error instanceof UnknownRunError) return m.lostRunOutput(payload.execution_id, session.id, { toolCalls: [] });
      if (error instanceof RunStateError) return m.runStateOutput(error, session.id, { toolCalls: [] });
      throw error;
    }
    if (state.sessionId !== session.id) {
      throw new SubmilliError(`run ${payload.execution_id} does not belong to this thread's session`);
    }
    const waiting = state.status === "suspended" ? state.calls : [];
    if (!sameCalls(payload.calls, waiting)) return m.staleResumeOutput(payload, session.id, waiting);
    const approved = answer.approved === true;
    const reason = approved
      ? ""
      : answer.reason
        ? `A person refused this call: ${answer.reason}`
        : "A person refused this call.";
    const decided = new Map(waiting.map((call) => [call.callId, { approved, reason }]));
    const records = [...(payload.tool_calls ?? [])];
    return this.drive(state, thread, { session, context, notice: undefined, records, decided });
  }

  /**
   * Refuse the calls of runs that earlier agent runs on this thread left
   * waiting on an approval.
   *
   * A run left waiting would hold its call until the Blueprint's
   * `tool_call_timeout`, when the call throws `TimeoutError` and the program
   * carries on where nobody sees it. So once the thread has moved on to
   * another agent run, each such run is answered: refused, and driven to its
   * end. Runs the current agent run suspended on are left to its resume.
   */
  private async abandonWaiting(thread: Thread, session: StoredSession, context: MastraContext): Promise<void> {
    const current = context.runId;
    if (current === undefined) return;
    const abandoned = (session.waiting ?? []).filter((run) => run.agentRunId !== current);
    for (const { executionId } of abandoned) {
      await thread.untrack(executionId);
      let state: RunState;
      try {
        state = await this.client.runs.retrieve(executionId, { signal: context.abortSignal });
      } catch {
        continue;
      }
      if (state.status !== "suspended" || state.sessionId !== session.id) continue;
      const refusal = "Not approved: the conversation moved on before a person decided on this call, so it did not run.";
      const refused = new Set(state.calls.map((call) => call.callId));
      const run: RunContext = { session, context, notice: undefined, records: [], decided: new Map() };
      try {
        await this.client.runs.complete(state, {
          signal: context.abortSignal,
          onToolCall: async (call) => {
            if (refused.has(call.callId)) return toolResult.denied(call.callId, refusal);
            try {
              return await this.answer(call, run);
            } catch (error) {
              if (!(error instanceof AwaitingApproval)) throw error;
              return toolResult.denied(call.callId, "Not asked: the conversation moved on before this call was reached.");
            }
          },
        });
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
      }
    }
  }

  // Discovery

  private async lastRun(context: MastraContext): Promise<unknown> {
    const thread = await this.thread(context);
    const session = await thread.stored();
    if (!session) return "No program has run in this conversation yet.";
    // A program an earlier agent run left waiting finishes only once it is
    // refused; refuse it now, so the last run is that program and not an older one.
    await this.abandonWaiting(thread, session, context);
    const run = await this.client.sessions.lastRun(session.id, { signal: context.abortSignal });
    if (!run) {
      return (
        "No run is recorded for this conversation's session. " +
        "The server keeps runs in memory, so a restart clears them."
      );
    }
    return run.raw;
  }

  private async searchPackages(query: string, context: MastraContext): Promise<unknown> {
    const signal = { signal: context.abortSignal };
    if (Object.keys(this.ptc).length === 0) {
      return this.client.blueprints.searchPackages(this.options.blueprint, query, signal);
    }
    // With application tools, search through the session, so `@tools` is included.
    return this.inSession(context, (id) => this.client.sessions.searchPackages(id, query, signal));
  }

  private async packageDocs(name: string, context: MastraContext): Promise<string> {
    const signal = { signal: context.abortSignal };
    if (Object.keys(this.ptc).length === 0) {
      return (await this.client.blueprints.packageDocs(this.options.blueprint, name, signal)).text;
    }
    return (await this.inSession(context, (id) => this.client.sessions.packageDocs(id, name, signal))).text;
  }

  private async inSession<T>(context: MastraContext, fetch: (sessionId: string) => Promise<T>): Promise<T> {
    const thread = await this.thread(context);
    const catalog = await this.catalog();
    const session = await thread.session(catalog, context.abortSignal);
    try {
      return await fetch(session.id);
    } catch (error) {
      if (!(error instanceof UnknownSessionError)) throw error;
      return fetch((await thread.replace(session, catalog, context.abortSignal)).id);
    }
  }

  private catalog(): Promise<Catalog> {
    this.catalogPromise ??= (async () => {
      const declarations = Object.entries(this.ptc).map(([name, tool]) => declaration(name, tool));
      return { declarations, digest: await catalogDigest(declarations) };
    })();
    return this.catalogPromise;
  }

  /** The thread of this tool call, bound with the variables its context gives. */
  private async thread(context: MastraContext): Promise<Thread> {
    const threadId = context.agent?.threadId;
    const binding: BindingContext = {
      requestContext: context.requestContext,
      resourceId: context.agent?.resourceId,
      threadId,
    };
    const [variables, secrets] = await Promise.all([
      bind(this.options.variables, binding),
      bind(this.options.secrets, binding),
    ]);
    // Without a memory thread, the session belongs to this agent run alone.
    const key = threadId ?? `run:${context.runId ?? crypto.randomUUID()}`;
    const store =
      threadId === undefined && !this.options.store
        ? runStore
        : storeFor(this.options, context.memory, threadId);
    return new Thread(this.client, this.options.blueprint, key, store, variables, secrets);
  }
}

// Sessions of agent runs without a memory thread, which no later run can find.
const runStore: SessionStore = memorySessionStore(1_000);

async function bind(binding: Binding | undefined, context: BindingContext): Promise<Record<string, string>> {
  const values = typeof binding === "function" ? await binding(context) : (binding ?? {});
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string") {
      throw new TypeError(`Submilli variables and secrets must be strings; got ${name}: ${typeof value}`);
    }
  }
  return values;
}

function suspender(context: MastraContext): ((payload: unknown) => Promise<void>) | undefined {
  return context.agent?.suspend ?? context.workflow?.suspend;
}

function isApprovalAnswer(value: unknown): value is m.ApprovalAnswer {
  return typeof value === "object" && value !== null && typeof (value as m.ApprovalAnswer).approved === "boolean";
}

function isApprovalPayload(value: unknown): value is m.ApprovalPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Partial<m.ApprovalPayload>;
  return typeof payload.execution_id === "string" && Array.isArray(payload.calls);
}

/** One thread's session: found in the store, opened when first needed, replaced when it ends. */
class Thread {
  readonly id: string;
  readonly secrets: Record<string, string>;
  private readonly client: Submilli;
  private readonly blueprint: string;
  private readonly store: SessionStore;
  private readonly variables: Record<string, string>;

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
  }

  /** The thread's session on this server for this Blueprint, if it has one. */
  async stored(): Promise<StoredSession | undefined> {
    const session = await this.store.get(this.id);
    if (!session || !sameTarget(session, this.client, this.blueprint)) return undefined;
    this.check(session);
    return session;
  }

  /** The session for `catalog`, opened if the thread has none with those tools. */
  session(catalog: Catalog, signal: AbortSignal | undefined): Promise<StoredSession> {
    return lock(this.store, this.id, async () => {
      const session = await this.stored();
      // A session keeps the tools it was opened with for life.
      if (session && session.tools === catalog.digest) return session;
      return this.open(catalog, signal);
    });
  }

  /** A new session in place of `ended`, which the server no longer knows. */
  replace(ended: StoredSession, catalog: Catalog, signal: AbortSignal | undefined): Promise<StoredSession> {
    let held = replacements.get(this.store);
    if (!held) replacements.set(this.store, (held = new Map()));
    let replacement = held.get(ended.id);
    if (!replacement) {
      replacement = lock(this.store, this.id, async () => {
        const session = await this.stored();
        if (session && session.id !== ended.id && session.tools === catalog.digest) return session;
        return this.open(catalog, signal);
      });
      const pending = held;
      pending.set(ended.id, replacement);
      replacement.then(
        () => setTimeout(() => pending.delete(ended.id), REPLACEMENT_TTL_MS).unref?.(),
        () => pending.delete(ended.id),
      );
    }
    return replacement;
  }

  /** Remember that `executionId` waits on a person, for the agent run `agentRunId`. */
  track(executionId: string, agentRunId: string): Promise<void> {
    return this.updateWaiting((waiting) => [...waiting.filter((run) => run.executionId !== executionId), { executionId, agentRunId }]);
  }

  /** Forget that `executionId` waits on a person. */
  untrack(executionId: string): Promise<void> {
    return this.updateWaiting((waiting) => waiting.filter((run) => run.executionId !== executionId));
  }

  private updateWaiting(change: (waiting: NonNullable<StoredSession["waiting"]>) => StoredSession["waiting"]): Promise<void> {
    return lock(this.store, this.id, async () => {
      const session = await this.stored();
      if (!session) return;
      const waiting = change(session.waiting ?? []) ?? [];
      const { waiting: _previous, ...rest } = session;
      await this.store.set(this.id, waiting.length > 0 ? { ...rest, waiting } : rest);
    });
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
      "This thread's Submilli session was opened with different variables than this agent run gives " +
        `(differing: ${differing.join(", ")}). A session is never shared between bindings: use another ` +
        "thread for this binding, or end the thread's session first with close().",
    );
  }
}

// Sessions opened to replace an ended one, per store and by the ended one's id,
// so that parallel calls that all find it gone open one replacement between
// them. Threads are built per tool call, so this outlives them briefly.
const REPLACEMENT_TTL_MS = 60_000;
const replacements = new WeakMap<SessionStore, Map<string, Promise<StoredSession>>>();

// In-process locks per store and thread, so that parallel tool calls open one
// session between them.
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

function sameCalls(asked: m.ApprovalPayload["calls"], waiting: readonly PendingCall[]): boolean {
  if (asked.length !== waiting.length || asked.length === 0) return false;
  return asked.every((call, index) => {
    const pending = waiting[index]!;
    return call.tool === pending.tool && JSON.stringify(sortKeys(call.args)) === JSON.stringify(sortKeys(pending.args));
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
