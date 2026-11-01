// The application's own Mastra tools, for programs to call as the `@tools` Package.
//
// The harness declares each tool when it opens a session. A program's call
// suspends its run; the tool runs here, with the execute tool's own Mastra
// execution context, and the run resumes with its result. The contract is
// "Application tools" in submilli-runtime's HTTP API reference.

import { toStandardSchema, type PublicSchema } from "@mastra/core/schema";
import {
  isValidationError,
  type RequireToolApproval,
  type ToolAction,
  type ToolExecutionContext,
} from "@mastra/core/tools";
import { inlineRefs, toolResult, type JSONSchema, type PendingCall, type ToolDeclaration, type ToolResult } from "@submilli/sdk";

// A TypeScript function name, as the server requires of a tool's name. The
// server also drops reserved words, with a warning when the session opens.
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A Mastra tool a program may call, as `createTool` makes it. */
export type ApplicationTool = ToolAction<any, any, any, any, any>;

/** The application's tools, by the name programs call them by. */
export type ApplicationTools = Record<string, ApplicationTool>;

/** A program's call that needs a person's approval, as `onApprovalRequired` is given it. */
export interface ApprovalRequest {
  toolName: string;
  input: unknown;
  /** The server's id for the call. */
  toolCallId: string;
  /** The run that made the call. */
  executionId: string;
}

/** A person's answer: `approved`, `denied`, or either with a reason the program is told. */
export type ApprovalDecision = "approved" | "denied" | { approved: boolean; reason?: string };

const EMPTY_INPUT: JSONSchema = { type: "object", properties: {}, additionalProperties: false };

/** `tool` as the server takes it: `{name, description, input_schema, output_schema}`. */
export function declaration(name: string, tool: ApplicationTool): ToolDeclaration {
  const declared: ToolDeclaration = {
    name,
    input_schema: tool.inputSchema === undefined ? EMPTY_INPUT : jsonSchema(tool.inputSchema, "input"),
  };
  if (tool.outputSchema !== undefined) declared.output_schema = jsonSchema(tool.outputSchema, "output");
  if (tool.description) declared.description = tool.description;
  return declared;
}

function jsonSchema(schema: PublicSchema<unknown>, io: "input" | "output"): JSONSchema {
  const converted = toStandardSchema(schema)["~standard"].jsonSchema[io]({ target: "draft-07" }) as JSONSchema;
  const { $schema: _dialect, ...rest } = converted;
  return inlineRefs(rest);
}

/** A fingerprint of the declared tools, so a thread notices when they changed. */
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
export function checkTools(tools: ApplicationTools): void {
  for (const [name, tool] of Object.entries(tools)) {
    if (!IDENTIFIER.test(name)) {
      throw new TypeError(`ptc tool '${name}': programs call tools by name, so it must be an identifier`);
    }
    if (typeof tool.execute !== "function") {
      throw new TypeError(`ptc tool '${name}' has no execute(), so a program's call to it could not be answered`);
    }
  }
}

/** Whether any of `tools` may need approval, so that the execute tool tells the model refusals can happen. */
export function mayNeedApproval(tools: ApplicationTools, required: RequireToolApproval | undefined): boolean {
  if (required !== undefined && required !== false) return Object.keys(tools).length > 0;
  return Object.values(tools).some((tool) => tool.requireApproval !== undefined && tool.requireApproval !== false);
}

/**
 * Whether one call needs a person's approval, as Mastra decides it for the
 * model's own tool calls: a tool's `requireApproval` function decides alone;
 * otherwise the tool's `requireApproval: true` or `requireToolApproval`.
 */
export async function needsApproval(
  name: string,
  tool: ApplicationTool,
  required: RequireToolApproval | undefined,
  input: unknown,
  context: ToolExecutionContext,
): Promise<boolean> {
  const requestContext = plain(context);
  const own = tool.requireApproval;
  if (typeof own === "function") return Boolean(await own(input, { requestContext }));
  if (own === true) return true;
  if (typeof required === "function") {
    try {
      return Boolean(await required({ toolName: name, args: (input ?? {}) as Record<string, unknown>, requestContext }));
    } catch {
      // As in Mastra: a policy that throws asks a person.
      return true;
    }
  }
  return required === true;
}

function plain(context: ToolExecutionContext): Record<string, unknown> | undefined {
  const entries = context.requestContext?.entries();
  return entries ? Object.fromEntries(entries) : undefined;
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
 * the execute tool's Mastra context, and answer with its output.
 *
 * A tool that throws, input or output that does not match, or a tool that
 * tries to suspend, is a `failed` answer: the program's call throws, and the
 * program may handle it.
 */
export async function runCall(call: PendingCall, tool: ApplicationTool, context: ToolExecutionContext): Promise<ToolResult> {
  let input: unknown = call.args;
  if (tool.inputSchema !== undefined) {
    const validated = await toStandardSchema(tool.inputSchema)["~standard"].validate(call.args);
    if (validated.issues) {
      const issues = validated.issues.map((issue) => issue.message).join("; ");
      return toolResult.failed(call.callId, `Invalid input for tool '${call.tool}': ${issues}`);
    }
    input = validated.value;
  }
  let suspended = false;
  const refuseSuspend = async (): Promise<void> => {
    suspended = true;
  };
  const nested: ToolExecutionContext = {
    ...context,
    // The tool runs inside a program, which cannot wait on Mastra's suspend.
    ...(context.agent
      ? {
          agent: {
            ...context.agent,
            toolCallId: call.callId,
            suspend: refuseSuspend,
            resumeData: undefined,
            suspendPayload: undefined,
          },
        }
      : {}),
    suspend: refuseSuspend,
    resumeData: undefined,
    suspendPayload: undefined,
  };
  delete nested.workflow;
  try {
    const output = await tool.execute!(input, nested as never);
    if (suspended) {
      return toolResult.failed(
        call.callId,
        `${call.tool} asked to suspend, which a program's call cannot do: give the tool to the agent directly instead.`,
      );
    }
    if (isValidationError(output)) return toolResult.failed(call.callId, output.message);
    return toolResult.success(call.callId, toJSON(output));
  } catch (error) {
    if (context.abortSignal?.aborted) throw error;
    return toolResult.failed(call.callId, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}

// What `JSON.stringify` would send, so that a class instance or a `Date`
// reaches the program as the data the model would see.
function toJSON(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value) ?? "null");
}
