//! The privileged, local-only side of Omni Harness.
//!
//! The frontend never receives general filesystem or shell access.  Instead it
//! asks this module for a deliberately small, read-only representation of a
//! known harness configuration.

use notify::{Config as WatchConfig, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

const CODEX_ID: &str = "codex-cli";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    harnesses: Vec<HarnessSummary>,
    scanned_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessSummary {
    id: String,
    name: String,
    kind: String,
    status: HarnessStatus,
    installation_path: Option<String>,
    config_count: usize,
    integration_count: usize,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
enum HarnessStatus {
    Configured,
    Attention,
    NotDetected,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessReport {
    summary: HarnessSummary,
    config_sources: Vec<ConfigSource>,
    integrations: Vec<McpServer>,
    settings: Vec<Setting>,
    diagnostics: Vec<Diagnostic>,
    config_preview: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigSource {
    path: String,
    format: String,
    exists: bool,
    modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServer {
    id: String,
    name: String,
    transport: String,
    command: Option<String>,
    args: Vec<String>,
    url: Option<String>,
    environment_keys: Vec<String>,
    source_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Setting {
    label: String,
    value: String,
    source_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic {
    severity: String,
    title: String,
    detail: String,
}

#[derive(Default)]
struct ConfigWatcher {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[tauri::command]
fn scan_harnesses() -> ScanResult {
    ScanResult {
        harnesses: vec![inspect_codex().summary],
        scanned_at: unix_now(),
    }
}

#[tauri::command]
fn inspect_harness(id: String) -> Result<HarnessReport, String> {
    if id != CODEX_ID {
        return Err(format!("Unsupported harness: {id}"));
    }

    Ok(inspect_codex())
}

/// Starts a non-recursive watch on a known config file. No arbitrary user path
/// can be passed from the webview.
#[tauri::command]
fn watch_harness(
    app: AppHandle,
    watcher_state: State<'_, ConfigWatcher>,
    id: String,
) -> Result<(), String> {
    if id != CODEX_ID {
        return Err(format!("Unsupported harness: {id}"));
    }

    let path = codex_config_path();
    if !path.exists() {
        return Ok(());
    }

    let event_app = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<notify::Event>| {
            if result.is_ok() {
                let _ = event_app.emit("harness:changed", CODEX_ID);
            }
        },
        WatchConfig::default(),
    )
    .map_err(|error| format!("Could not create config watcher: {error}"))?;

    watcher
        .watch(&path, RecursiveMode::NonRecursive)
        .map_err(|error| format!("Could not watch {}: {error}", path.display()))?;

    *watcher_state
        .watcher
        .lock()
        .map_err(|_| "Config watcher lock was poisoned".to_string())? = Some(watcher);

    Ok(())
}

fn inspect_codex() -> HarnessReport {
    let config_path = codex_config_path();
    let installation_path = find_executable("codex").map(display_path);
    let config_exists = config_path.is_file();
    let mut diagnostics = Vec::new();
    let mut integrations = Vec::new();
    let mut settings = Vec::new();
    let mut config_preview = None;

    if config_exists {
        match fs::read_to_string(&config_path) {
            Ok(content) => match content.parse::<toml::Value>() {
                Ok(config) => {
                    integrations = extract_mcp_servers(&config);
                    settings = extract_settings(&config);
                    config_preview = Some(redact_toml(&config, None));
                }
                Err(error) => diagnostics.push(Diagnostic {
                    severity: "error".into(),
                    title: "Could not parse config.toml".into(),
                    detail: error.to_string(),
                }),
            },
            Err(error) => diagnostics.push(Diagnostic {
                severity: "error".into(),
                title: "Could not read config.toml".into(),
                detail: error.to_string(),
            }),
        }
    } else {
        diagnostics.push(Diagnostic {
            severity: "info".into(),
            title: "No Codex configuration found".into(),
            detail: "Omni Harness looked in ~/.codex/config.toml. Create the file or add a config location in a future release.".into(),
        });
    }

    if installation_path.is_none() {
        diagnostics.push(Diagnostic {
            severity: "warning".into(),
            title: "Codex CLI is not on PATH".into(),
            detail:
                "Its configuration can still be inspected, but launch diagnostics are unavailable."
                    .into(),
        });
    }

    let status = if diagnostics.iter().any(|item| item.severity == "error") {
        HarnessStatus::Attention
    } else if config_exists {
        HarnessStatus::Configured
    } else {
        HarnessStatus::NotDetected
    };

    let message = match status {
        HarnessStatus::Configured => format!(
            "{} config source{} · {} MCP server{}",
            1,
            "",
            integrations.len(),
            if integrations.len() == 1 { "" } else { "s" }
        ),
        HarnessStatus::Attention => "Configuration needs attention".into(),
        HarnessStatus::NotDetected => "No local configuration found".into(),
    };

    let config_sources = vec![ConfigSource {
        path: display_path(config_path),
        format: "TOML".into(),
        exists: config_exists,
        modified_at: modified_at(codex_config_path()),
    }];

    HarnessReport {
        summary: HarnessSummary {
            id: CODEX_ID.into(),
            name: "Codex CLI".into(),
            kind: "Harness".into(),
            status,
            installation_path,
            config_count: usize::from(config_exists),
            integration_count: integrations.len(),
            message,
        },
        config_sources,
        integrations,
        settings,
        diagnostics,
        config_preview,
    }
}

fn extract_mcp_servers(config: &toml::Value) -> Vec<McpServer> {
    let Some(servers) = config.get("mcp_servers").and_then(toml::Value::as_table) else {
        return Vec::new();
    };

    servers
        .iter()
        .filter_map(|(name, value)| {
            let table = value.as_table()?;
            let args = table
                .get("args")
                .and_then(toml::Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(toml::Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let environment_keys = table
                .get("env")
                .and_then(toml::Value::as_table)
                .map(|env| env.keys().cloned().collect())
                .unwrap_or_default();

            Some(McpServer {
                id: format!("mcp:{name}"),
                name: name.clone(),
                transport: if table.contains_key("url") {
                    "HTTP"
                } else {
                    "stdio"
                }
                .into(),
                command: table
                    .get("command")
                    .and_then(toml::Value::as_str)
                    .map(str::to_owned),
                args,
                url: table
                    .get("url")
                    .and_then(toml::Value::as_str)
                    .map(str::to_owned),
                environment_keys,
                source_path: format!("mcp_servers.{name}"),
            })
        })
        .collect()
}

fn extract_settings(config: &toml::Value) -> Vec<Setting> {
    ["model", "model_provider", "approval_policy", "sandbox_mode"]
        .into_iter()
        .filter_map(|key| {
            config.get(key).map(|value| Setting {
                label: key.replace('_', " "),
                value: toml_display(value),
                source_path: key.to_string(),
            })
        })
        .collect()
}

fn toml_display(value: &toml::Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn redact_toml(value: &toml::Value, key: Option<&str>) -> serde_json::Value {
    if key.is_some_and(is_sensitive_key) {
        return serde_json::Value::String("[redacted]".into());
    }

    match value {
        toml::Value::Table(table) => table
            .iter()
            .map(|(child_key, child_value)| {
                (child_key.clone(), redact_toml(child_value, Some(child_key)))
            })
            .collect::<serde_json::Map<_, _>>()
            .into(),
        toml::Value::Array(values) => values
            .iter()
            .map(|child| redact_toml(child, key))
            .collect::<Vec<_>>()
            .into(),
        toml::Value::String(value) => serde_json::Value::String(value.clone()),
        toml::Value::Integer(value) => serde_json::Value::Number((*value).into()),
        toml::Value::Float(value) => serde_json::Number::from_f64(*value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        toml::Value::Boolean(value) => serde_json::Value::Bool(*value),
        toml::Value::Datetime(value) => serde_json::Value::String(value.to_string()),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "api_key",
        "apikey",
        "authorization",
        "credential",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn codex_config_path() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("config.toml")
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let paths: OsString = env::var_os("PATH")?;
    env::split_paths(&paths)
        .map(|directory| directory.join(name))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn display_path(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn modified_at(path: PathBuf) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ConfigWatcher::default())
        .invoke_handler(tauri::generate_handler![
            scan_harnesses,
            inspect_harness,
            watch_harness
        ])
        .run(tauri::generate_context!())
        .expect("error while running Omni Harness");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_mcp_servers_and_redacts_secret_values() {
        let config: toml::Value = r#"
model = "gpt-5.2-codex"

[mcp_servers.linear]
command = "npx"
args = ["-y", "mcp-remote", "https://mcp.linear.app"]

[mcp_servers.linear.env]
LINEAR_API_KEY = "super-secret"
"#
        .parse()
        .expect("fixture is valid TOML");

        let servers = extract_mcp_servers(&config);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "linear");
        assert_eq!(servers[0].environment_keys, vec!["LINEAR_API_KEY"]);

        let preview = redact_toml(&config, None);
        assert_eq!(
            preview["mcp_servers"]["linear"]["env"]["LINEAR_API_KEY"],
            "[redacted]"
        );
    }

    #[test]
    fn recognizes_common_secret_names() {
        assert!(is_sensitive_key("OPENAI_API_KEY"));
        assert!(is_sensitive_key("authorization"));
        assert!(!is_sensitive_key("model"));
    }
}
