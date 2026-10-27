// What the model is shown: tool names, descriptions, and the results of runs.

import type { BlueprintPrompt, ExecuteResult, IdempotencyError, PendingCall, RunStateError } from "@submilli/sdk";

// The server's own names, as its MCP endpoint lists them. Its responses refer
// to its tools by these names, so they are kept.
export const EXECUTE = "submilli__typescript__execute";
export const LAST_RUN = "submilli__typescript__last_run";
export const PACKAGES_SEARCH = "submilli__typescript__packages__search";
export const PACKAGES_DOCS = "submilli__typescript__packages__docs";
export const BUILTINS_LIST = "submilli__typescript__builtins__list";
export const BUILTINS_DOCS = "submilli__typescript__builtins__docs";
// Ours: continues a program that waits on a person's approval.
export const RESUME = "submilli__typescript__resume";

/** The description of each server tool, from the Blueprint's prompt endpoint. */
export function descriptions(prompt: BlueprintPrompt): Record<string, string> {
  return {
    [EXECUTE]: prompt.prompt,
    [LAST_RUN]: prompt.tools.last_run ?? "Return the most recent execution's result and full console.",
    [PACKAGES_SEARCH]: prompt.tools.search ?? "Search the Packages a program may import.",
    [PACKAGES_DOCS]: prompt.tools.docs ?? "Return a Package's documentation and TypeScript declarations.",
    [BUILTINS_LIST]: prompt.tools.builtins_list ?? "List the built-ins in scope without an import.",
    [BUILTINS_DOCS]: prompt.tools.builtins_docs ?? "Return the declarations of built-ins.",
  };
}

/** What the execute tool's description adds about the application's tools. */
export function applicationToolsPrompt(names: readonly string[], approvals: boolean): string {
  if (names.length === 0) return "";
  const listed = names.map((name) => `\`${name}\``).join(", ");
  const approval = approvals
    ? " Some calls wait for a person's approval, who may refuse them: a refusal throws `PermissionDeniedError`, " +
      "and is final."
    : "";
  return (
    "\n\nThis agent's programs can also call the application's own tools, as the `@tools` package " +
    `(\`import tools from "@tools";\`): ${listed}. The application runs each call and returns its result to the ` +
    `program.${approval} Read their signatures with \`${PACKAGES_DOCS}("@tools")\`.`
  );
}

export const RESUME_DESCRIPTION: string =
  "Continue a program that waits on a person's approval of a call to one of the application's tools. " +
  `Call it with the \`resume_input\` that ${EXECUTE} or this tool returned in \`awaiting_approval\`, ` +
  "exactly as given. The person approves or refuses the call; the program then carries on and this tool " +
  "returns its result, as the execute tool would.";

export const DENIAL_NOTE: string =
  "The operator's policy denied this. The denial is final: tell the user what was refused, " +
  "and do not try another route to the same effect.";

export const SESSION_REPLACED_NOTE: string =
  "This conversation's previous Submilli session had ended (idle timeout, or the server no longer " +
  "knows it), so a new session was opened for this call. Files the earlier session kept outside " +
  "persistent volumes, and its `submilli:session` state, are gone.";

export const AWAITING_APPROVAL_NOTE: string =
  `The program is paused: it called an application tool that needs a person's approval. Call ${RESUME} ` +
  "with `resume_input` exactly as given to ask for it. Until then the call waits, up to the Blueprint's " +
  "`tool_call_timeout`. Running another program first abandons this one, and its waiting calls are refused.";

const IDEMPOTENCY_MESSAGES: Record<string, string> = {
  idempotency_conflict:
    "Nothing ran. This tool call id was already used in this session with different code. " +
    "Make a new tool call to run this program.",
  idempotency_incomplete:
    "Nothing ran now. An earlier attempt of this same tool call started, but the server stopped " +
    "before it recorded the outcome, so its side effects are unknown: it may have done some, all, " +
    "or none of its work. Check what it would have changed (read the files, look up the records) " +
    "before running anything that repeats it, and tell the user if you cannot tell.",
  idempotency_in_progress:
    "Nothing new ran. An earlier attempt of this same tool call is still running on the server and " +
    "did not finish within the server's wait. Check its effects, or the last run, before trying again.",
  idempotency_unavailable:
    "Nothing ran. The server could not read or write its idempotency record, so it refused to run " +
    "the program rather than risk running it twice. Trying again later may work.",
  idempotency_key_invalid: "Nothing ran. The server refused this call's idempotency key.",
  idempotency_response_expired:
    "Nothing new ran. The earlier program finished, but the server no longer keeps its result. " +
    "Check its effects before running anything that repeats it; changing the key would run it again.",
};

const UNKNOWN_EFFECTS =
  "Check what it would have changed before running anything that repeats it, and tell the user if you cannot tell.";

const LOST_RUN_MESSAGE =
  "The run was lost while it waited on one of the application's tools: the server restarted or no " +
  `longer holds it. Its effects up to that point are unknown. ${UNKNOWN_EFFECTS}`;

const NO_RESULT: [string, string] = [
  "run_result_unavailable",
  "The run finished, but the server no longer keeps its result. Check its effects, or the last run, " +
    "before running anything that repeats it.",
];

// By run status: the error kind the model sees, and what it is told.
const RUN_STATE_MESSAGES: Record<string, [string, string]> = {
  stuck: [
    "run_stuck",
    "The run stopped before it finished, and the server holds it until an operator recovers it. Its " +
      "effects up to that point are unknown, and programs run after it in this session wait until it is " +
      "recovered. Tell the user before running anything else.",
  ],
  cancelled: [
    "run_cancelled",
    "The run was cancelled before it finished, because its session was closed. Its effects up to that " +
      `point are unknown. ${UNKNOWN_EFFECTS}`,
  ],
  aborted: ["run_aborted", "The run was abandoned before the program started, so nothing ran."],
  indeterminate: [
    "run_indeterminate",
    "The run was interrupted, and the server cannot tell how far it got: it may have done some, all, " +
      `or none of its work. ${UNKNOWN_EFFECTS}`,
  ],
  expired: NO_RESULT,
  completed: NO_RESULT,
};

/** A program's call to one of the application's tools, as the execute result records it. */
export interface ToolCallRecord {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
  /** How it was answered: `ok`, `failed`, or `denied`; `awaiting_approval` while a person decides. */
  outcome: "ok" | "failed" | "denied" | "awaiting_approval";
  /** The approval decision, for a call that needed one. */
  decision?: "approved" | "denied";
}

/** What `submilli__typescript__resume` takes: the waiting run and the calls a person is asked about. */
export interface ResumeInput {
  execution_id: string;
  calls: { call_id: string; tool: string; args: Record<string, unknown> }[];
}

/**
 * What the execute and resume tools return.
 *
 * The model is shown `result`, `console`, `error`, `denied` and the notes
 * (see `toModelOutput`). `execution_id`, `session_id` and `tool_calls` are
 * for the application: they link a step to the server's audit trail.
 */
export interface ExecuteOutput {
  result: string | null;
  console: string[];
  error: Record<string, unknown> | null;
  denied: boolean;
  note?: string;
  notice?: string;
  discovery_warnings?: string[];
  /** Set while the program waits on a person's approval. */
  awaiting_approval?: { resume_input: ResumeInput; note: string };
  execution_id?: string;
  session_id: string;
  /** The program's calls to the application's tools, in order. */
  tool_calls?: ToolCallRecord[];
}

export function executeOutput(
  result: ExecuteResult,
  extra: { notice?: string | undefined; toolCalls: ToolCallRecord[] },
): ExecuteOutput {
  const output: ExecuteOutput = {
    result: result.result,
    console: result.console,
    error: result.error?.raw ?? null,
    denied: result.denied,
    execution_id: result.executionId,
    session_id: result.sessionId,
  };
  if (result.denied) output.note = DENIAL_NOTE;
  if (result.discoveryWarnings.length > 0) output.discovery_warnings = result.discoveryWarnings;
  return withExtra(output, extra);
}

export function awaitingOutput(
  executionId: string,
  sessionId: string,
  calls: readonly PendingCall[],
  extra: { notice?: string | undefined; toolCalls: ToolCallRecord[] },
): ExecuteOutput {
  const resumeInput: ResumeInput = {
    execution_id: executionId,
    calls: calls.map((call) => ({ call_id: call.callId, tool: call.tool, args: call.args })),
  };
  const output: ExecuteOutput = {
    result: null,
    console: [],
    error: null,
    denied: false,
    awaiting_approval: { resume_input: resumeInput, note: AWAITING_APPROVAL_NOTE },
    execution_id: executionId,
    session_id: sessionId,
  };
  return withExtra(output, extra);
}

export function lostRunOutput(
  executionId: string,
  sessionId: string,
  extra: { notice?: string | undefined; toolCalls: ToolCallRecord[] },
): ExecuteOutput {
  const output: ExecuteOutput = {
    result: null,
    console: [],
    error: { kind: "run_lost", message: LOST_RUN_MESSAGE },
    denied: false,
    execution_id: executionId,
    session_id: sessionId,
  };
  return withExtra(output, extra);
}

export function runStateOutput(
  error: RunStateError,
  sessionId: string,
  extra: { notice?: string | undefined; toolCalls: ToolCallRecord[] },
): ExecuteOutput {
  const [kind, message] = RUN_STATE_MESSAGES[error.status] ?? [
    "run_state_unknown",
    `The server reported the run as '${error.status}', which this version of @submilli/ai-sdk does not know, ` +
      `so its outcome is unknown. ${UNKNOWN_EFFECTS}`,
  ];
  const reported: Record<string, unknown> = { kind, message, status: error.status };
  if (error.reason) reported.reason = error.reason;
  const output: ExecuteOutput = {
    result: null,
    console: [],
    error: reported,
    denied: false,
    execution_id: error.executionId,
    session_id: sessionId,
  };
  return withExtra(output, extra);
}

export function idempotencyOutput(error: IdempotencyError, sessionId: string): ExecuteOutput {
  const message =
    IDEMPOTENCY_MESSAGES[error.code ?? ""] ?? `Nothing ran. The server refused the call: ${error.detail}`;
  const output: ExecuteOutput = {
    result: null,
    console: [],
    error: { kind: error.code, message, detail: error.detail },
    denied: false,
    session_id: sessionId,
  };
  if (error.executionId) output.execution_id = error.executionId;
  return output;
}

/** A resume whose calls no longer match what the run waits on. Nothing was answered. */
export function staleResumeOutput(input: ResumeInput, sessionId: string, waiting: readonly PendingCall[]): ExecuteOutput {
  const now = waiting.length
    ? `It now waits on: ${JSON.stringify(waiting.map((call) => ({ call_id: call.callId, tool: call.tool, args: call.args })))}.`
    : "It no longer waits on any call.";
  return {
    result: null,
    console: [],
    error: {
      kind: "approval_stale",
      message:
        "Nothing was answered. The calls in this resume are not the ones the program waits on, so the " +
        `approval does not apply to them. ${now}`,
    },
    denied: false,
    execution_id: input.execution_id,
    session_id: sessionId,
  };
}

/** The part of an execute or resume output the model is shown. */
export function modelView(output: ExecuteOutput): Record<string, unknown> {
  const { execution_id: _execution, session_id: _session, tool_calls: _calls, ...shown } = output;
  return JSON.parse(JSON.stringify(shown)) as Record<string, unknown>;
}

function withExtra(
  output: ExecuteOutput,
  extra: { notice?: string | undefined; toolCalls: ToolCallRecord[] },
): ExecuteOutput {
  if (extra.notice) output.notice = extra.notice;
  if (extra.toolCalls.length > 0) output.tool_calls = extra.toolCalls;
  return output;
}

export function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
