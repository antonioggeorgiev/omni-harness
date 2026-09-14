import continueSchema from "../schemas/continue.json" with { type: "json" };
import copilot from "../schemas/copilot.json" with { type: "json" };
import cursorMcp from "../schemas/cursor-mcp.json" with { type: "json" };
import claudeDesktop from "../schemas/claude-desktop.json" with { type: "json" };
import clineMcp from "../schemas/cline-mcp.json" with { type: "json" };
import copilotMcp from "../schemas/copilot-mcp.json" with { type: "json" };
import opencodeTui from "../schemas/opencode-tui.json" with { type: "json" };
import codex from "../schemas/codex.json" with { type: "json" };
import claude from "../schemas/claude.json" with { type: "json" };
import gemini from "../schemas/gemini.json" with { type: "json" };
import opencode from "../schemas/opencode.json" with { type: "json" };
import cursor from "../schemas/cursor.json" with { type: "json" };
import aider from "../schemas/aider.json" with { type: "json" };
import goose from "../schemas/goose.json" with { type: "json" };

export type Json = null | string | boolean | number | Json[] | { [key: string]: Json };
export type Schema = Record<string, unknown>;
export const schemas: Record<string, Schema> = {
  codex,
  claude,
  gemini,
  opencode,
  cursor,
  aider,
  goose,
  continue: continueSchema,
  copilot,
  "cursor-mcp": cursorMcp,
  "claude-desktop": claudeDesktop,
  "cline-mcp": clineMcp,
  "copilot-mcp": copilotMcp,
  "opencode-tui": opencodeTui,
};
export const configurationTabs = [
  { id: "general", label: "General" },
  { id: "mcp-servers", label: "MCP servers" },
  { id: "models", label: "Models & providers" },
  { id: "permissions", label: "Permissions" },
  { id: "hooks", label: "Hooks & automation" },
  { id: "features", label: "Features" },
  { id: "plugins", label: "Plugins & skills" },
  { id: "projects", label: "Project config" },
  { id: "environment", label: "Environment" },
  { id: "system", label: "System" },
  { id: "raw-config", label: "Raw config" },
] as const;
export type ConfigurationTabId = (typeof configurationTabs)[number]["id"];

export const references: Record<string, { url: string; coverage: string }> = {
  codex: {
    url: "https://developers.openai.com/codex/config-reference/",
    coverage: "Published schema",
  },
  claude: {
    url: "https://code.claude.com/docs/en/settings",
    coverage: "Documentation-linked schema (may lag CLI releases)",
  },
  gemini: {
    url: "https://geminicli.com/docs/reference/configuration/",
    coverage: "Published schema",
  },
  opencode: { url: "https://opencode.ai/docs/config/", coverage: "Published schema" },
  cursor: {
    url: "https://cursor.com/docs/cli/reference/configuration",
    coverage: "Documented CLI fields",
  },
  aider: {
    url: "https://aider.chat/docs/config/options.html",
    coverage: "CLI argument definitions",
  },
  goose: {
    url: "https://github.com/block/goose/blob/main/documentation/docs/guides/config-files.md",
    coverage: "Documented configuration fields; provider-specific options may extend these",
  },
  continue: { url: "https://docs.continue.dev/reference", coverage: "Published YAML schema" },
  cline: {
    url: "https://docs.cline.bot/getting-started/config",
    coverage: "Documented MCP fields; app state has no bundled schema",
  },
  "github-copilot-cli": {
    url: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference",
    coverage: "Documented settings fields and MCP envelope",
  },
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function resolveSchema(schema: Schema, root: Schema, depth = 0): Schema {
  if (depth > 15) return schema;
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    const value = schema.$ref
      .slice(2)
      .split("/")
      .reduce<unknown>(
        (v, key) => (isObject(v) ? v[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined),
        root,
      );
    if (isObject(value))
      return {
        ...resolveSchema(value, root, depth + 1),
        ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$ref")),
      };
  }
  if (Array.isArray(schema.allOf))
    return Object.assign(
      {},
      ...schema.allOf.filter(isObject).map((s) => resolveSchema(s, root, depth + 1)),
      schema,
    );
  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (variants) {
    const shapes = variants.filter(isObject).map((s) => resolveSchema(s, root, depth + 1));
    const properties = Object.assign(
      {},
      ...shapes.map((s) => (isObject(s.properties) ? s.properties : {})),
    );
    const enums = shapes.flatMap((s) =>
      Array.isArray(s.enum) ? s.enum : s.const !== undefined ? [s.const] : [],
    );
    return {
      ...schema,
      ...(Object.keys(properties).length ? { properties } : {}),
      ...(enums.length && shapes.every((s) => s.enum || s.const !== undefined)
        ? { enum: enums }
        : {}),
    };
  }
  return schema;
}
export function childSchema(schema: Schema, root: Schema, key: string): Schema {
  const resolved = resolveSchema(schema, root);
  if (isObject(resolved.properties) && isObject(resolved.properties[key]))
    return resolveSchema(resolved.properties[key], root);
  if (isObject(resolved.additionalProperties))
    return resolveSchema(resolved.additionalProperties, root);
  if (isObject(resolved.items)) return resolveSchema(resolved.items, root);
  return {};
}
export function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return (
    [
      "apikey",
      "secret",
      "password",
      "authorization",
      "accesstoken",
      "refreshtoken",
      "authtoken",
      "bearertoken",
      "privatekey",
      "passphrase",
    ].some((term) => normalized.includes(term)) ||
    [
      "token",
      "credentials",
      "credential",
      "env",
      "envs",
      "environment",
      "headers",
      "httpheaders",
      "setenv",
    ].includes(normalized)
  );
}
export function containsSensitive(value: unknown): boolean {
  if (value === "[redacted]") return true;
  if (Array.isArray(value)) return value.some(containsSensitive);
  return (
    isObject(value) &&
    Object.entries(value).some(([k, v]) => sensitiveKey(k) || containsSensitive(v))
  );
}
export function sectionFor(key: string): ConfigurationTabId {
  const k = key.toLowerCase().replace(/[-_]/g, "");
  if (k.includes("mcp")) return "mcp-servers";
  if (/permission|approval|sandbox|security|allowedtools|deniedtools|allowedurls|trust/.test(k))
    return "permissions";
  if (/hook|notify|automation|recipe/.test(k)) return "hooks";
  if (/plugin|marketplace|extension|skill/.test(k)) return "plugins";
  if (/^env|shellenvironment|setenv/.test(k)) return "environment";
  if (/project|^profiles?$|context|instructions|claudemd|memory|memories|rules|^read$/.test(k))
    return "projects";
  if (
    /model|provider|reasoning|temperature|topp|topk|max.*tokens|thinking|completion|embedding/.test(
      k,
    )
  )
    return "models";
  if (
    /feature|experimental|^tools$|^agents$|^tui$|^ui$|desktop|browser|computer|audio|voice|websearch/.test(
      k,
    )
  )
    return "features";
  if (
    /telemetry|otel|analytics|notice|migration|auth|login|credential|logdir|sqlite|\$schema/.test(k)
  )
    return "system";
  return "general";
}
export function sourceReadOnly(id: string, path: string): boolean {
  return (
    id === "claude-code-state" ||
    id.includes("plugins-installed") ||
    id.includes("plugin-marketplaces") ||
    id === "github-copilot-cli-config-2" ||
    path.endsWith("/permissions-config.json")
  );
}
