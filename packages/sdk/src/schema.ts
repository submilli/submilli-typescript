// Helpers for the JSON Schemas of application tools.

import { isRecord } from "./errors.ts";
import type { JSONSchema } from "./types.ts";

const LOCAL_REF = /^#\/(\$defs|definitions)\/([^/]+)$/;

/**
 * `schema` with its local references (`#/$defs/...`, `#/definitions/...`)
 * replaced by what they name.
 *
 * The server's mapper does not resolve `$ref`, and types a field that uses one
 * as `unknown`. Zod and most generators put shared or recursive types behind
 * references, so inline them before declaring a tool. A recursive reference
 * becomes `{}`, which the server types `unknown`.
 */
export function inlineRefs(schema: JSONSchema): JSONSchema {
  const defs: Record<string, unknown> = {
    ...(isRecord(schema.definitions) ? schema.definitions : {}),
    ...(isRecord(schema.$defs) ? schema.$defs : {}),
  };

  const resolve = (node: unknown, seen: readonly string[]): unknown => {
    if (Array.isArray(node)) return node.map((item) => resolve(item, seen));
    if (!isRecord(node)) return node;
    // A reference to the root is recursive by definition.
    if (node.$ref === "#") return {};
    const ref = typeof node.$ref === "string" ? LOCAL_REF.exec(node.$ref) : null;
    if (ref) {
      const name = decodeURIComponent(ref[2]!.replaceAll("~1", "/").replaceAll("~0", "~"));
      const target = defs[name];
      if (seen.includes(name) || !isRecord(target)) return {};
      const { $ref: _ref, ...rest } = node;
      return resolve({ ...target, ...rest }, [...seen, name]);
    }
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== "$defs" && key !== "definitions")
        .map(([key, value]) => [key, resolve(value, seen)]),
    );
  };

  return resolve(schema, []) as JSONSchema;
}
