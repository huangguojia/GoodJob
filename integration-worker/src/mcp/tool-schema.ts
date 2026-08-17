import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/client";

export interface DiscoveredToolSnapshot {
  remoteName: string;
  displayName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  descriptionHash: string;
  inputSchemaHash: string;
  schemaHash: string;
}

const allowedSchemaKeys = new Set([
  "$schema", "type", "properties", "required", "items", "enum", "const",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength",
  "maxLength", "minItems", "maxItems", "pattern", "format", "description",
  "additionalProperties", "anyOf", "oneOf", "allOf"
]);

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSchemaNode(value: unknown, depth: number, state: { properties: number }): unknown {
  if (depth > 12) throw new Error("INTEGRATION_REMOTE_SCHEMA_INVALID: Schema 嵌套超过 12 层");
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error("INTEGRATION_REMOTE_SCHEMA_INVALID: Schema 数组过大");
    return value.map((item) => normalizeSchemaNode(item, depth + 1, state));
  }
  if (typeof value !== "object") throw new Error("INTEGRATION_REMOTE_SCHEMA_INVALID: Schema 包含不支持的值");
  const source = value as Record<string, unknown>;
  if ("$ref" in source || "$dynamicRef" in source || "patternProperties" in source) {
    throw new Error("INTEGRATION_REMOTE_SCHEMA_INVALID: Schema 包含未支持的引用或动态属性");
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (!allowedSchemaKeys.has(key)) continue;
    if (key === "properties") {
      if (!source.properties || typeof source.properties !== "object" || Array.isArray(source.properties)) {
        throw new Error("INTEGRATION_REMOTE_SCHEMA_INVALID: properties 必须是对象");
      }
      const properties: Record<string, unknown> = {};
      for (const property of Object.keys(source.properties as Record<string, unknown>).sort()) {
        state.properties += 1;
        if (state.properties > 200) throw new Error("INTEGRATION_REMOTE_SCHEMA_INVALID: Schema 属性超过 200 个");
        properties[property] = normalizeSchemaNode((source.properties as Record<string, unknown>)[property], depth + 1, state);
      }
      result.properties = properties;
      continue;
    }
    result[key] = normalizeSchemaNode(source[key], depth + 1, state);
  }
  if (result.type === "object" && result.additionalProperties === undefined) result.additionalProperties = false;
  return result;
}

export function normalizeJsonSchema(value: unknown): Record<string, unknown> {
  const normalized = normalizeSchemaNode(value || { type: "object", properties: {} }, 0, { properties: 0 });
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new Error("INTEGRATION_REMOTE_SCHEMA_INVALID: Schema 根节点必须是对象");
  }
  return normalized as Record<string, unknown>;
}

export function normalizeDiscoveredTool(tool: Tool): DiscoveredToolSnapshot {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(tool.name)) {
    throw new Error("INTEGRATION_REMOTE_SCHEMA_INVALID: 工具名称格式无效");
  }
  const description = String(tool.description || "").slice(0, 2000);
  const inputSchema = normalizeJsonSchema(tool.inputSchema);
  const outputSchema = tool.outputSchema ? normalizeJsonSchema(tool.outputSchema) : null;
  const descriptionHash = sha256(description);
  const inputSchemaHash = sha256(canonicalJson(inputSchema));
  const schemaHash = sha256(canonicalJson({
    name: tool.name,
    descriptionHash,
    inputSchema,
    outputSchema
  }));
  return {
    remoteName: tool.name,
    displayName: String(tool.title || tool.name).slice(0, 200),
    description,
    inputSchema,
    outputSchema,
    descriptionHash,
    inputSchemaHash,
    schemaHash
  };
}

export function normalizeToolList(tools: Tool[], maxTools = 200) {
  if (tools.length > maxTools) throw new Error(`INTEGRATION_REMOTE_SCHEMA_INVALID: 工具数量超过 ${maxTools}`);
  const names = new Set<string>();
  return tools.map((tool) => {
    if (names.has(tool.name)) throw new Error("INTEGRATION_REMOTE_SCHEMA_INVALID: 工具名称重复");
    names.add(tool.name);
    return normalizeDiscoveredTool(tool);
  });
}
