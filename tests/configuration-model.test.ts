import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configurationTabs,
  sectionFor,
  schemas,
  resolveSchema,
  childSchema,
  sensitiveKey,
  sourceReadOnly,
} from "../src/configuration-model.ts";

test("configuration navigation prioritizes General and keeps Raw config last", () => {
  assert.equal(configurationTabs[0].id, "general");
  assert.equal(configurationTabs[1].id, "mcp-servers");
  assert.equal(configurationTabs.at(-1)?.id, "raw-config");
});
test("provider contracts expose options absent from a user's local file", () => {
  for (const [provider, key] of [
    ["codex", "model_providers"],
    ["claude", "permissions"],
    ["gemini", "security"],
    ["opencode", "mcp"],
    ["continue", "models"],
    ["copilot", "disabledMcpServers"],
  ]) {
    const root = schemas[provider];
    assert.ok(
      Object.keys(childSchema(resolveSchema(root, root), root, key)).length,
      `${provider}.${key}`,
    );
  }
});
test("category routing covers provider-specific sections", () => {
  assert.equal(sectionFor("permissions"), "permissions");
  assert.equal(sectionFor("hooks"), "hooks");
  assert.equal(sectionFor("model_providers"), "models");
  assert.equal(sectionFor("enabledPlugins"), "plugins");
  assert.equal(sectionFor("shell_environment_policy"), "environment");
});
test("redaction does not hide token budgets or credential storage options", () => {
  for (const key of ["tool_output_token_limit", "maxTokens", "cli_auth_credentials_store"])
    assert.equal(sensitiveKey(key), false);
  for (const key of ["api-key", "OPENAI_API_KEY", "env", "headers", "refreshToken"])
    assert.equal(sensitiveKey(key), true);
});
test("managed state remains read-only even with a custom config root", () => {
  assert.ok(sourceReadOnly("github-copilot-cli-config-2", "/custom/config.json"));
  assert.ok(sourceReadOnly("claude-code-state", "/custom/state.json"));
  assert.equal(sourceReadOnly("claude-code-settings", "/custom/settings.json"), false);
});

test("organization-only Claude options are not writable user settings", () => {
  const root = schemas.claude;
  assert.equal(childSchema(root, root, "requireCoworkFullVmSandbox").readOnly, true);
  assert.notEqual(childSchema(root, root, "language").readOnly, true);
});
