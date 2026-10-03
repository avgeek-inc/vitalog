import { z } from "zod";

type Schema = Record<string, unknown>;
const catalogGuidance =
  "Use health_get_catalog with include_schema=true for the complete field schema and allowed keys. The server validates the complete schema on every call.";

const object = (value: unknown): Schema =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : {};

export function discoverySchema(schema: z.ZodType) {
  const document = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    reused: "ref",
    io: "input",
  });
  const resolve = (node: Schema): Schema => {
    if (typeof node.$ref !== "string") return node;
    if (!node.$ref.startsWith("#/"))
      throw new Error("MCP discovery requires local schema references");
    const target = node.$ref
      .slice(2)
      .split("/")
      .reduce<unknown>(
        (value, key) =>
          object(value)[key.replaceAll("~1", "/").replaceAll("~0", "~")],
        document,
      );
    if (!target) throw new Error("Unresolved MCP schema reference");
    return object(target);
  };
  const summary = (node: Schema): Schema => ({
    ...(node.type ? { type: node.type } : {}),
    description: catalogGuidance,
  });
  let depthLimit = 4;
  const visit = (
    value: unknown,
    depth: number,
    ancestors: Set<Schema>,
  ): Schema => {
    const node = resolve(object(value));
    if (ancestors.has(node) || depth >= depthLimit) return summary(node);
    const properties = object(node.properties);
    if (Object.keys(properties).length > 40) return summary(node);
    const alternatives = node.oneOf ?? node.anyOf;
    if (Array.isArray(alternatives) && alternatives.length > 6)
      return {
        ...(alternatives.every(
          (item) => resolve(object(item)).type === "object",
        )
          ? { type: "object" }
          : {}),
        description: catalogGuidance,
      };
    const next = new Set(ancestors).add(node);
    const result: Schema = {};
    for (const [key, item] of Object.entries(node)) {
      if (["$schema", "$id", "$defs", "definitions", "$ref"].includes(key))
        continue;
      if (key === "properties") {
        result.properties = Object.fromEntries(
          Object.entries(properties).map(([name, child]) => [
            name,
            visit(child, depth + 1, next),
          ]),
        );
      } else if (
        ["items", "additionalProperties", "propertyNames"].includes(key) &&
        typeof item === "object"
      ) {
        result[key] = visit(item, depth + 1, next);
      } else if (
        ["oneOf", "anyOf", "allOf"].includes(key) &&
        Array.isArray(item)
      ) {
        // Summarized variants can overlap, so discovery must not require exclusivity.
        result[key === "oneOf" ? "anyOf" : key] = item.map((child) =>
          visit(child, depth + 1, next),
        );
      } else if (key === "enum" && Array.isArray(item) && item.length > 32) {
        result.description = catalogGuidance;
      } else result[key] = item;
    }
    return result;
  };
  let result = visit(document, 0, new Set());
  while (JSON.stringify(result).length > 12 * 1024 && depthLimit > 1) {
    depthLimit--;
    result = visit(document, 0, new Set());
  }
  if (!result.properties && Array.isArray(result.anyOf)) {
    const variants = result.anyOf.map(object);
    if (variants.every((variant) => variant.type === "object")) {
      const fields = new Map<string, unknown[]>();
      for (const variant of variants)
        for (const [name, field] of Object.entries(object(variant.properties)))
          fields.set(name, [...(fields.get(name) ?? []), field]);
      result.properties = Object.fromEntries(
        [...fields].map(([name, values]) => [
          name,
          values.length === 1 ? values[0] : { anyOf: values },
        ]),
      );
      result.required = (variants[0]?.required as string[] | undefined)?.filter(
        (name) =>
          variants.every((variant) =>
            (variant.required as string[] | undefined)?.includes(name),
          ),
      );
      delete result.anyOf;
    }
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...result,
    type: "object" as const,
  };
}
