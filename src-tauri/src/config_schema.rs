//! Offline provider contracts. Never resolve a user-supplied $schema URL.
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, sync::LazyLock};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaIssue {
    pub path: String,
    pub rule: String,
}

static SCHEMAS: LazyLock<HashMap<&'static str, (Value, jsonschema::Validator)>> =
    LazyLock::new(|| {
        [
            ("continue", include_str!("../../schemas/continue.json")),
            ("copilot", include_str!("../../schemas/copilot.json")),
            ("cursor-mcp", include_str!("../../schemas/cursor-mcp.json")),
            (
                "claude-desktop",
                include_str!("../../schemas/claude-desktop.json"),
            ),
            ("cline-mcp", include_str!("../../schemas/cline-mcp.json")),
            (
                "copilot-mcp",
                include_str!("../../schemas/copilot-mcp.json"),
            ),
            (
                "opencode-tui",
                include_str!("../../schemas/opencode-tui.json"),
            ),
            ("codex", include_str!("../../schemas/codex.json")),
            ("claude", include_str!("../../schemas/claude.json")),
            ("gemini", include_str!("../../schemas/gemini.json")),
            ("opencode", include_str!("../../schemas/opencode.json")),
            ("cursor", include_str!("../../schemas/cursor.json")),
            ("aider", include_str!("../../schemas/aider.json")),
            ("goose", include_str!("../../schemas/goose.json")),
        ]
        .into_iter()
        .map(|(id, text)| {
            let schema: Value = serde_json::from_str(text).expect("bundled schema is JSON");
            let validator =
                jsonschema::validator_for(&schema).expect("bundled schema compiles offline");
            (id, (schema, validator))
        })
        .collect()
    });

pub fn schema_id(store_id: &str) -> Option<&'static str> {
    match store_id {
        "continue-config-0" => Some("continue"),
        "github-copilot-cli-config-0" => Some("copilot"),
        "cursor-mcp" => Some("cursor-mcp"),
        "cline-config-1" => Some("cline-mcp"),
        "github-copilot-cli-config-1" => Some("copilot-mcp"),
        "claude-desktop-chat" => Some("claude-desktop"),
        "opencode-tui-json" | "opencode-tui-jsonc" => Some("opencode-tui"),
        "codex-home" => Some("codex"),
        "claude-code-settings" => Some("claude"),
        "gemini-cli-settings" => Some("gemini"),
        "opencode-global-json" | "opencode-global-jsonc" => Some("opencode"),
        "cursor-cli" => Some("cursor"),
        "aider-config-0" => Some("aider"),
        "goose-config-0" => Some("goose"),
        _ => None,
    }
}

pub fn issues(id: &str, config: &Value) -> Vec<SchemaIssue> {
    let Some((_, validator)) = SCHEMAS.get(id) else {
        return Vec::new();
    };
    validator
        .iter_errors(config)
        .map(|error| SchemaIssue {
            path: error.instance_path().to_string(),
            rule: error
                .schema_path()
                .to_string()
                .rsplit('/')
                .next()
                .unwrap_or("schema")
                .into(),
        })
        .collect()
}

pub fn known_root(id: &str, key: &str) -> bool {
    let Some((schema, _)) = SCHEMAS.get(id) else {
        return false;
    };
    let root = schema
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|r| r.strip_prefix('#'))
        .and_then(|p| schema.pointer(p))
        .unwrap_or(schema);
    root.get("properties").and_then(|p| p.get(key)).is_some()
}

pub fn validate_change(
    id: &str,
    before: &Value,
    after: &Value,
    path: &[String],
) -> Result<(), String> {
    if let Some((schema, _)) = SCHEMAS.get(id) {
        if schema
            .get("properties")
            .and_then(|p| p.get(&path[0]))
            .and_then(|p| p.get("readOnly"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            return Err("This setting is managed by the provider or organization and cannot be set in this user file.".into());
        }
    }
    let prefix = format!(
        "/{}",
        path.iter()
            .map(|s| s.replace('~', "~0").replace('/', "~1"))
            .collect::<Vec<_>>()
            .join("/")
    );
    let old = issues(id, before);
    let bad = issues(id, after).into_iter().find(|issue| {
        issue.path == prefix
            || issue.path.starts_with(&format!("{prefix}/"))
            || (!issue.path.is_empty() && prefix.starts_with(&format!("{}/", issue.path)))
            || !old
                .iter()
                .any(|previous| previous.path == issue.path && previous.rule == issue.rule)
    });
    if let Some(issue) = bad {
        return Err(format!(
            "This change does not match the provider schema at {} ({}).",
            if issue.path.is_empty() {
                "/"
            } else {
                &issue.path
            },
            issue.rule
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn bundled_schemas_compile_without_network() {
        assert_eq!(SCHEMAS.len(), 14);
    }
    #[test]
    fn fields_without_validation_rules_produce_no_findings() {
        let config = json!({
            "coworkUserFilesPath": "/example/files",
            "preferences": { "theme": "dark" },
            "mcpServers": { "demo": { "command": "demo", "futureOption": true } }
        });
        assert!(issues("claude-desktop", &config).is_empty());
        assert!(issues("provider-without-schema", &config).is_empty());
    }

    #[test]
    fn known_invalid_fields_still_produce_findings() {
        let findings = issues(
            "claude-desktop",
            &json!({
                "preferences": { "theme": "dark" },
                "mcpServers": { "demo": { "command": 42 } }
            }),
        );
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].path, "/mcpServers/demo/command");
        assert_eq!(findings[0].rule, "type");
        // An explicit rule forbidding extra properties is actual validation.
        assert!(!issues("codex", &json!({"unknown_future_key": true})).is_empty());
    }

    #[test]
    fn organization_only_settings_are_rejected_in_user_files() {
        assert!(validate_change(
            "claude",
            &serde_json::json!({}),
            &serde_json::json!({"requireCoworkFullVmSandbox": true}),
            &["requireCoworkFullVmSandbox".into()]
        )
        .is_err());
    }

    #[test]
    fn validates_provider_specific_types_and_enums() {
        assert!(!issues("codex", &json!({"approval_policy":"random"})).is_empty());
        assert!(!issues("claude", &json!({"permissions":{"allow":"Bash(ls)"}})).is_empty());
        assert!(!issues("gemini", &json!({"general":{"vimMode":"yes"}})).is_empty());
        assert!(issues(
            "opencode",
            &json!({"mcp":{"demo":{"type":"local","command":["demo"]}}})
        )
        .is_empty());
    }
    #[test]
    fn can_repair_invalid_data_without_blocking_on_unrelated_old_keys() {
        let before = json!({"model":42,"unknown_future_key":true});
        assert!(validate_change(
            "codex",
            &before,
            &json!({"model":"example","unknown_future_key":true}),
            &["model".into()]
        )
        .is_ok());
        assert!(validate_change(
            "codex",
            &before,
            &json!({"model":43,"unknown_future_key":true}),
            &["model".into()]
        )
        .is_err());
    }
}
