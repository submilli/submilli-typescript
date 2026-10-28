// A scripted language model, as in submilli-runtime's checks: no API key needed.

import { MockLanguageModelV4 } from "ai/test";

type Prompt = Parameters<MockLanguageModelV4["doGenerate"]>[0];

export interface ScriptedCall {
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

/** One model turn: tool calls to make in parallel, or a final text. */
export type Turn = ScriptedCall[] | string | ((prompt: Prompt) => ScriptedCall[] | string);

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

let ids = 0;

export function call(name: string, input: object, id?: string): ScriptedCall {
  return { name, input: input as Record<string, unknown>, id: id ?? `call-${++ids}` };
}

export function execute(code: string, id?: string): ScriptedCall {
  return call("submilli__typescript__execute", { code }, id);
}

/** A model that answers with `turns` in order, and records what it was given. */
export class Scripted extends MockLanguageModelV4 {
  readonly prompts: Prompt[] = [];

  constructor(...turns: Turn[]) {
    const queue = [...turns];
    super({
      doGenerate: async (prompt) => {
        this.prompts.push(prompt);
        const next = queue.shift();
        if (next === undefined) throw new Error("the scripted model ran out of turns");
        const turn = typeof next === "function" ? next(prompt) : next;
        if (typeof turn === "string") {
          return { content: [{ type: "text", text: turn }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
        }
        return {
          content: turn.map((item) => ({
            type: "tool-call" as const,
            toolCallId: item.id ?? `call-${++ids}`,
            toolName: item.name,
            input: JSON.stringify(item.input),
          })),
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
  }

  /** The tools offered in the last request, by name. */
  toolNames(): string[] {
    return (this.prompts.at(-1)?.tools ?? []).map((tool) => tool.name);
  }

  /** A tool's description in the last request. */
  description(name: string): string | undefined {
    const found = this.prompts.at(-1)?.tools?.find((tool) => tool.name === name);
    return found?.type === "function" ? found.description : undefined;
  }

  /** The tool results the model was shown in its last request, in order. */
  toolResults(): unknown[] {
    const results: unknown[] = [];
    for (const message of this.prompts.at(-1)?.prompt ?? []) {
      if (message.role !== "tool") continue;
      for (const part of message.content) {
        if (part.type === "tool-result") results.push(part.output.type === "json" || part.output.type === "text" ? part.output.value : part.output);
      }
    }
    return results;
  }
}
