// The application's own AI SDK tools, for programs to call as the `@tools` Package.
//
// The harness declares each tool when it opens a session. A program's call
// suspends its run; the tool runs here, with the AI SDK's execution options,
// and the run resumes with its result. The contract is "Application tools" in
// submilli-runtime's HTTP API reference.

import { asSchema, type ModelMessage, type Tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { inlineRefs, toolResult, type JSONSchema, type PendingCall, type ToolDeclaration, type ToolResult } from "@submilli/sdk";

// A TypeScript function name, as the server requires of a tool's name. The
// server also drops reserved words, with a warning when the session opens.
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Whether a call needs a person's approval, as the AI SDK's own
 * `toolApproval` statuses say it.
 */
export type ApprovalStatus =
  | undefined
  | "not-applicable"
  | "approved"
  | "denied"
  | "user-approval"
  | { type: "not-applicable" }
  | { type: "approved"; reason?: string }
  | { type: "denied"; reason?: string }
  | { type: "user-approval"; reason?: string };

/** Decides a call's approval status from its input, as the AI SDK's per-tool approval functions do. */
export type ApprovalFunction = (
  input: unknown,
  options: { toolCallId: string; messages: ModelMessage[] },
) => ApprovalStatus | PromiseLike<ApprovalStatus>;

/** Per application tool, whether a program's call to it needs approval: a status, or a function giving one. */
export type ToolApproval = Record<string, ApprovalStatus | ApprovalFunction>;

/** A program's call that needs a person's approval, as `onApprovalRequired` is given it. */
export interface ApprovalRequest {
  toolName: string;
  input: unknown;
  /** The server's id for the call. */
  toolCallId: string;
  /** The run that made the call. */
  executionId: string;
  /** Why it needs approval, when the approval status said. */
  reason?: string;
}

/** A person's answer: `approved`, `denied`, or either with a reason the program is told. */
export type ApprovalDecision = "approved" | "denied" | { approved: boolean; reason?: string };

type NormalizedStatus = { type: "not-applicable" | "approved" | "denied" | "user-approval"; reason?: string };

/** `tool` as the server takes it: `{name, description, input_schema, output_schema}`. */
export async function declaration(name: string, tool: Tool): Promise<ToolDeclaration> {
  const declared: ToolDeclaration = {
    name,
    input_schema: inlineRefs(await jsonSchema(tool.inputSchema)),
  };
  if (tool.outputSchema !== undefined) declared.output_schema = inlineRefs(await jsonSchema(tool.outputSchema));
  if (typeof tool.description === "string" && tool.description) declared.description = tool.description;
  return declared;
}

async function jsonSchema(schema: Parameters<typeof asSchema>[0]): Promise<JSONSchema> {
  const { $schema: _dialect, ...rest } = (await asSchema(schema).jsonSchema) as JSONSchema;
  return rest;
}

/** A fingerprint of the declared tools, so a conversation notices when they changed. */
export async function catalogDigest(catalog: readonly ToolDeclaration[]): Promise<string | undefined> {
  if (catalog.length === 0) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(catalog)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Checks the names programs will call the tools by. */
export function checkTools(tools: ToolSet, approval: ToolApproval | undefined): void {
  for (const [name, tool] of Object.entries(tools)) {
    if (!IDENTIFIER.test(name)) {
      throw new TypeError(`ptc tool '${name}': programs call tools by name, so it must be an identifier`);
    }
    if (typeof tool.execute !== "function") {
      throw new TypeError(`ptc tool '${name}' has no execute(), so a program's call to it could not be answered`);
    }
  }
  const unknown = Object.keys(approval ?? {}).filter((name) => !(name in tools));
  if (unknown.length > 0) throw new TypeError(`toolApproval names tools that are not in ptc: ${unknown.join(", ")}`);
}

/** Whether any of `tools` may need approval, so that the model needs a way to ask for it. */
export function mayNeedApproval(tools: ToolSet, approval: ToolApproval | undefined): boolean {
  return Object.entries(tools).some(([name, tool]) => {
    const status = approval?.[name] ?? tool.needsApproval;
    return status !== undefined && status !== false && status !== "not-applicable" && status !== "approved";
  });
}

/** The approval status of one call: the `toolApproval` entry first, then the tool's own `needsApproval`. */
export async function approvalStatus(
  name: string,
  tool: Tool,
  approval: ToolApproval | undefined,
  input: unknown,
  options: ToolExecutionOptions<unknown>,
  callId: string,
): Promise<NormalizedStatus> {
  const configured = approval?.[name];
  if (configured !== undefined) {
    const status =
      typeof configured === "function"
        ? await configured(input, { toolCallId: callId, messages: options.messages })
        : configured;
    return normalize(status);
  }
  const needs = tool.needsApproval;
  if (needs === undefined) return { type: "not-applicable" };
  const asked =
    typeof needs === "function"
      ? await needs(input as never, { toolCallId: callId, messages: options.messages, context: options.context })
      : needs;
  return asked ? { type: "user-approval" } : { type: "not-applicable" };
}

function normalize(status: ApprovalStatus): NormalizedStatus {
  if (status === undefined) return { type: "not-applicable" };
  if (typeof status === "string") return { type: status };
  return status.type === "not-applicable" ? { type: status.type } : { ...status };
}

/** `decision` as an approval: whether it was given, and the reason the program is told. */
export function readDecision(decision: ApprovalDecision): { approved: boolean; reason: string | undefined } {
  if (decision === "approved" || decision === "denied") return { approved: decision === "approved", reason: undefined };
  if (typeof decision !== "object" || decision === null || typeof decision.approved !== "boolean") {
    throw new TypeError("onApprovalRequired must return 'approved', 'denied', or { approved, reason }");
  }
  return { approved: decision.approved, reason: decision.reason };
}

/**
 * Run one call: validate its input against the tool's schema, execute it with
 * the AI SDK's execution options, and answer with its output.
 *
 * A tool that throws, or input that does not match, is a `failed` answer: the
 * program's call throws, and the program may handle it.
 */
export async function runCall(
  call: PendingCall,
  tool: Tool,
  options: ToolExecutionOptions<unknown>,
): Promise<ToolResult> {
  const schema = asSchema(tool.inputSchema);
  let input: unknown = call.args;
  if (schema.validate) {
    const validated = await schema.validate(call.args);
    if (!validated.success) {
      return toolResult.failed(call.callId, `Invalid input for tool '${call.tool}': ${validated.error.message}`);
    }
    input = validated.value;
  }
  try {
    const nested: ToolExecutionOptions<unknown> = { ...options, toolCallId: call.callId };
    const output = tool.execute!(input as never, nested as never) as unknown;
    return toolResult.success(call.callId, toJSON(await finalOutput(output)));
  } catch (error) {
    if (options.abortSignal?.aborted) throw error;
    return toolResult.failed(call.callId, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}

async function finalOutput(output: unknown): Promise<unknown> {
  if (typeof output === "object" && output !== null && Symbol.asyncIterator in output) {
    // A streaming tool: its last value is its result, as for the model.
    let last: unknown;
    for await (const part of output as AsyncIterable<unknown>) last = part;
    return last;
  }
  return await output;
}

// What `JSON.stringify` would send, so that a class instance or a `Date`
// reaches the program as the data the model would see.
function toJSON(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value) ?? "null");
}
