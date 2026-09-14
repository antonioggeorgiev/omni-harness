//! The privileged, local-only side of Omni Harness.
//!
//! The frontend never receives general filesystem or shell access.  Instead it
//! asks this module for a deliberately small, read-only representation of a
//! known harness configuration.

mod config_schema;

use notify::{Config as WatchConfig, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    env,
    ffi::OsString,
    fs,
    hash::{Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use toml_edit::{value, DocumentMut};

const CODEX_ID: &str = "codex-cli";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    families: Vec<HarnessFamilySummary>,
    scanned_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessFamilySummary {
    id: String,
    name: String,
    status: HarnessStatus,
    message: String,
    runtimes: Vec<HarnessRuntimeSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessRuntimeSummary {
    id: String,
    name: String,
    status: HarnessStatus,
    message: String,
    config_stores: Vec<ConfigurationStore>,
    surfaces: Vec<SurfaceSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigurationStore {
    id: String,
    label: String,
    format: String,
    path: String,
    exists: bool,
    shared_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceSummary {
    id: String,
    name: String,
    kind: String,
    status: HarnessStatus,
    evidence: Vec<DetectionEvidence>,
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
    evidence: Vec<DetectionEvidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
enum HarnessStatus {
    Configured,
    Installed,
    Attention,
    NotDetected,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectionEvidence {
    kind: String,
    label: String,
    path: String,
    found: bool,
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

/// A configuration entity is a runtime-level grouping. Individual surfaces
/// (such as a CLI, desktop application, and IDE extension) never receive a
/// separate preview when they share the same configuration stores.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigurationReport {
    id: String,
    family_name: String,
    name: String,
    status: HarnessStatus,
    message: String,
    config_stores: Vec<ConfigurationStore>,
    surfaces: Vec<SurfaceSummary>,
    previews: Vec<ConfigurationFilePreview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigurationFilePreview {
    schema_id: Option<String>,
    schema_issues: Vec<config_schema::SchemaIssue>,
    id: String,
    path: String,
    format: String,
    exists: bool,
    revision: Option<String>,
    content: Option<serde_json::Value>,
    diagnostic: Option<String>,
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

/// A deliberately small inventory of agent-facing context. Paths are gathered
/// from a user-selected project plus documented harness homes; no source is
/// executed and file contents are not returned to the renderer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectContextReport {
    root: String,
    workspace_root: String,
    scanned_at: u64,
    artifacts: Vec<ContextArtifact>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextArtifact {
    id: String,
    provider: String,
    kind: String,
    scope: String,
    state: String,
    activation: String,
    path: String,
    external: bool,
    created_at: Option<u64>,
    modified_at: Option<u64>,
}

#[tauri::command]
fn scan_harnesses() -> ScanResult {
    let mut families = vec![
        scan_codex_family(),
        scan_claude_family(),
        scan_cursor_family(),
        scan_opencode_family(),
        scan_gemini_cli_family(),
    ];
    families.extend(
        catalog_entries()
            .iter()
            .filter(|entry| entry.id != "gemini-cli")
            .map(scan_catalog_entry),
    );

    ScanResult {
        families,
        scanned_at: unix_now(),
    }
}

/// Scans only an explicitly selected project folder and known, read-only
/// provider locations. This command never evaluates instructions or skills.
#[tauri::command]
fn scan_project_context(project_path: String) -> Result<ProjectContextReport, String> {
    let root = fs::canonicalize(&project_path)
        .map_err(|error| format!("Could not open the selected folder: {error}"))?;
    if !root.is_dir() {
        return Err("Select a folder to import as a project.".into());
    }

    let workspace_root = find_workspace_root(&root).unwrap_or_else(|| root.clone());
    let mut artifacts = Vec::new();
    let mut seen = HashSet::new();

    collect_codex_context(&root, &workspace_root, &mut artifacts, &mut seen);
    collect_claude_context(&root, &workspace_root, &mut artifacts, &mut seen);
    collect_gemini_context(&root, &workspace_root, &mut artifacts, &mut seen);

    artifacts.sort_by(|left, right| {
        left.provider
            .cmp(&right.provider)
            .then(left.scope.cmp(&right.scope))
            .then(left.path.cmp(&right.path))
    });

    Ok(ProjectContextReport {
        root: display_path(root),
        workspace_root: display_path(workspace_root),
        scanned_at: unix_now(),
        artifacts,
    })
}

#[tauri::command]
fn inspect_harness(id: String) -> Result<HarnessReport, String> {
    if id != CODEX_ID {
        return Err(format!("Unsupported harness: {id}"));
    }

    Ok(inspect_codex())
}

/// Previews only configuration stores discovered from the bounded catalog.
/// The frontend can select an id, but it cannot submit a filesystem path.
#[tauri::command]
fn inspect_configuration(
    family_id: String,
    runtime_id: String,
) -> Result<ConfigurationReport, String> {
    let scan = scan_harnesses();
    let family = scan
        .families
        .into_iter()
        .find(|family| family.id == family_id)
        .ok_or_else(|| format!("Unsupported harness family: {family_id}"))?;
    let runtime = family
        .runtimes
        .iter()
        .find(|runtime| runtime.id == runtime_id)
        .cloned()
        .ok_or_else(|| format!("Unsupported runtime for {}: {runtime_id}", family.name))?;
    let name = if family.runtimes.len() == 1 {
        family.name.clone()
    } else {
        format!("{} · {}", family.name, runtime.name)
    };
    let previews = runtime
        .config_stores
        .iter()
        .map(configuration_file_preview)
        .collect();

    Ok(ConfigurationReport {
        id: format!("{}:{}", family.id, runtime.id),
        family_name: family.name,
        name,
        status: runtime.status,
        message: runtime.message,
        config_stores: runtime.config_stores,
        surfaces: runtime.surfaces,
        previews,
    })
}

/// Writes a whitelisted Codex general setting after checking the file revision
/// observed by the UI. The caller can never select an arbitrary path or key.
#[tauri::command]
fn update_codex_general_setting(
    key: String,
    setting_value: String,
    expected_revision: String,
) -> Result<ConfigurationReport, String> {
    update_codex_document(&expected_revision, |document, _| {
        set_codex_general_setting(document, &key, &setting_value)
    })?;

    inspect_configuration("codex".into(), "codex-local".into())
}

/// Updates an existing Codex feature flag. Feature keys must already exist as
/// booleans, which prevents this command from introducing arbitrary TOML.
#[tauri::command]
fn update_codex_feature(
    key: String,
    enabled: bool,
    expected_revision: String,
) -> Result<ConfigurationReport, String> {
    update_codex_document(&expected_revision, |document, config| {
        set_codex_feature(document, config, &key, enabled)
    })?;

    inspect_configuration("codex".into(), "codex-local".into())
}

/// Changes only the explicit enabled state of an existing Codex MCP server.
#[tauri::command]
fn update_codex_mcp_enabled(
    server: String,
    enabled: bool,
    expected_revision: String,
) -> Result<ConfigurationReport, String> {
    update_codex_document(&expected_revision, |document, config| {
        set_codex_mcp_enabled(document, config, &server, enabled)
    })?;

    inspect_configuration("codex".into(), "codex-local".into())
}

/// Updates an existing scalar in a discovered JSON, JSONC, or YAML configuration
/// source. This is the shared write path used by providers whose settings are
/// structurally compatible with the generic editor.
#[tauri::command]
fn update_configuration_value(
    family_id: String,
    runtime_id: String,
    store_id: String,
    path: Vec<String>,
    setting_value: serde_json::Value,
    expected_revision: String,
) -> Result<ConfigurationReport, String> {
    let store = configuration_store_for(&family_id, &runtime_id, &store_id)?;
    if !matches!(
        store.format.as_str(),
        "JSON" | "JSONC" | "YAML" | "YML" | "TOML"
    ) {
        return Err(format!(
            "{} uses a dedicated configuration writer",
            store.format
        ));
    }
    if path.is_empty() {
        return Err("A configuration path is required.".into());
    }
    if path.iter().any(|segment| is_sensitive_key(segment)) {
        return Err("Sensitive settings cannot be changed through Omni Harness.".into());
    }

    if store.id == "claude-code-state"
        || store.id.contains("plugins-installed")
        || store.id.contains("plugin-marketplaces")
        || store.id == "github-copilot-cli-config-2"
        || store.id == "github-copilot-cli-config-5"
    {
        return Err("This file is managed by the provider and is read-only here.".into());
    }
    update_structured_configuration(&store, &path, setting_value, &expected_revision)?;
    inspect_configuration(family_id, runtime_id)
}

fn configuration_store_for(
    family_id: &str,
    runtime_id: &str,
    store_id: &str,
) -> Result<ConfigurationStore, String> {
    let scan = scan_harnesses();
    let family = scan
        .families
        .into_iter()
        .find(|family| family.id == family_id)
        .ok_or_else(|| format!("Unsupported harness family: {family_id}"))?;
    let runtime = family
        .runtimes
        .into_iter()
        .find(|runtime| runtime.id == runtime_id)
        .ok_or_else(|| format!("Unsupported runtime for {}: {runtime_id}", family.name))?;
    runtime
        .config_stores
        .into_iter()
        .find(|store| store.id == store_id)
        .ok_or_else(|| "Unsupported configuration source.".into())
}

fn set_codex_general_setting(
    document: &mut DocumentMut,
    key: &str,
    setting_value: &str,
) -> Result<(), String> {
    if !matches!(
        key,
        "model" | "model_reasoning_effort" | "approval_policy" | "personality"
    ) {
        return Err(format!("Unsupported Codex setting: {key}"));
    }

    let before: serde_json::Value = document
        .to_string()
        .parse::<toml::Value>()
        .ok()
        .and_then(|v| serde_json::to_value(v).ok())
        .ok_or("Could not read Codex settings.")?;
    let mut after = before.clone();
    after[key] = serde_json::Value::String(setting_value.into());
    config_schema::validate_change("codex", &before, &after, &[key.into()])?;
    document[key] = value(setting_value);
    Ok(())
}

fn set_codex_feature(
    document: &mut DocumentMut,
    config: &toml::Value,
    key: &str,
    enabled: bool,
) -> Result<(), String> {
    let is_feature_flag = config
        .get("features")
        .and_then(toml::Value::as_table)
        .and_then(|features| features.get(key))
        .and_then(toml::Value::as_bool)
        .is_some();
    if !is_feature_flag {
        return Err(format!("Unknown Codex feature flag: {key}"));
    }

    document["features"][key] = value(enabled);
    Ok(())
}

fn set_codex_mcp_enabled(
    document: &mut DocumentMut,
    config: &toml::Value,
    server: &str,
    enabled: bool,
) -> Result<(), String> {
    let exists = config
        .get("mcp_servers")
        .and_then(toml::Value::as_table)
        .and_then(|servers| servers.get(server))
        .and_then(toml::Value::as_table)
        .is_some();
    if !exists {
        return Err(format!("Unknown Codex MCP server: {server}"));
    }

    document["mcp_servers"][server]["enabled"] = value(enabled);
    Ok(())
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
    } else if installation_path.is_some() {
        HarnessStatus::Installed
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
        HarnessStatus::Installed => "Installed · no user configuration found".into(),
        HarnessStatus::NotDetected => "No local configuration found".into(),
    };

    let mut evidence = vec![DetectionEvidence {
        kind: "config".into(),
        label: "User configuration".into(),
        path: display_path(config_path.clone()),
        found: config_exists,
    }];
    if let Some(path) = installation_path.as_ref() {
        evidence.insert(
            0,
            DetectionEvidence {
                kind: "executable".into(),
                label: "CLI executable".into(),
                path: path.clone(),
                found: true,
            },
        );
    }

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
            evidence,
        },
        config_sources,
        integrations,
        settings,
        diagnostics,
        config_preview,
    }
}

struct CatalogEntry {
    id: &'static str,
    name: &'static str,
    executables: &'static [&'static str],
    applications: &'static [&'static str],
    extensions: &'static [&'static str],
    home_configs: &'static [(&'static str, &'static str)],
}

fn scan_codex_family() -> HarnessFamilySummary {
    let report = inspect_codex();
    let summary = report.summary;
    let config_path = codex_config_path();
    let config_store = configuration_store(
        "codex-home",
        "Codex shared configuration",
        "TOML",
        config_path,
        &["CLI", "Desktop", "IDE extension"],
    );
    let cli = cli_surface("codex-cli", "Codex CLI", &["codex"]);
    let desktop = application_surface(
        "codex-desktop",
        "Codex desktop",
        &["Codex.app", "ChatGPT.app"],
    );
    let ide = extension_surface(
        "codex-ide",
        "Codex IDE extension",
        &["openai.codex", "openai.chatgpt"],
    );
    let status = if matches!(summary.status, HarnessStatus::Attention) {
        HarnessStatus::Attention
    } else {
        aggregate_status(&[
            summary.status.clone(),
            cli.status.clone(),
            desktop.status.clone(),
            ide.status.clone(),
        ])
    };
    let runtime = HarnessRuntimeSummary {
        id: "codex-local".into(),
        name: "Codex local runtime".into(),
        status: status.clone(),
        message: "CLI, desktop, and IDE surfaces share this configuration store.".into(),
        config_stores: vec![config_store],
        surfaces: vec![cli, desktop, ide],
    };

    family("codex", "Codex", vec![runtime], status)
}

fn scan_claude_family() -> HarnessFamilySummary {
    let code_stores = claude_code_stores();
    let code_surfaces = vec![
        cli_surface("claude-code-cli", "Claude Code CLI", &["claude"]),
        application_surface(
            "claude-code-desktop",
            "Claude Code desktop",
            &["Claude.app"],
        ),
        extension_surface(
            "claude-code-vscode",
            "Claude Code IDE extension",
            &["anthropic.claude-code"],
        ),
    ];
    let code_status = runtime_status(&code_stores, &code_surfaces);
    let code_runtime = HarnessRuntimeSummary {
        id: "claude-code".into(),
        name: "Claude Code".into(),
        status: code_status,
        message: "CLI, IDE extension, and the Desktop Code tab share Claude Code settings.".into(),
        config_stores: code_stores,
        surfaces: code_surfaces,
    };

    let desktop_store = home_dir()
        .map(|home| {
            configuration_store(
                "claude-desktop-chat",
                "Claude Desktop Chat configuration",
                "JSON",
                home.join("Library/Application Support/Claude/claude_desktop_config.json"),
                &["Desktop chat"],
            )
        })
        .into_iter()
        .collect::<Vec<_>>();
    let desktop_surfaces = vec![application_surface(
        "claude-desktop-chat-app",
        "Claude Desktop Chat",
        &["Claude.app"],
    )];
    let desktop_status = runtime_status(&desktop_store, &desktop_surfaces);
    let desktop_runtime = HarnessRuntimeSummary {
        id: "claude-desktop-chat".into(),
        name: "Claude Desktop Chat".into(),
        status: desktop_status,
        message: "Desktop chat connectors and MCP configuration are separate from Claude Code."
            .into(),
        config_stores: desktop_store,
        surfaces: desktop_surfaces,
    };

    let status = aggregate_status(&[code_runtime.status.clone(), desktop_runtime.status.clone()]);
    family(
        "claude",
        "Claude",
        vec![code_runtime, desktop_runtime],
        status,
    )
}

fn scan_cursor_family() -> HarnessFamilySummary {
    let stores = home_dir()
        .map(|home| {
            vec![
                configuration_store(
                    "cursor-cli",
                    "Cursor Agent CLI configuration",
                    "JSON",
                    home.join(".cursor/cli-config.json"),
                    &["CLI"],
                ),
                configuration_store(
                    "cursor-mcp",
                    "Cursor global MCP configuration",
                    "JSON",
                    home.join(".cursor/mcp.json"),
                    &["CLI", "Desktop"],
                ),
            ]
        })
        .unwrap_or_default();
    let surfaces = vec![
        cli_surface("cursor-agent-cli", "Cursor Agent CLI", &["cursor-agent"]),
        application_surface("cursor-desktop", "Cursor desktop", &["Cursor.app"]),
    ];
    let status = runtime_status(&stores, &surfaces);
    let runtime = HarnessRuntimeSummary {
        id: "cursor-agent".into(),
        name: "Cursor Agent".into(),
        status: status.clone(),
        message: "The CLI and desktop editor are tracked as separate surfaces.".into(),
        config_stores: stores,
        surfaces,
    };
    family("cursor", "Cursor", vec![runtime], status)
}

fn scan_opencode_family() -> HarnessFamilySummary {
    let stores = opencode_config_root()
        .map(|root| {
            vec![
                configuration_store(
                    "opencode-global-json",
                    "OpenCode global configuration",
                    "JSON",
                    root.join("opencode/opencode.json"),
                    &["CLI"],
                ),
                configuration_store(
                    "opencode-global-jsonc",
                    "OpenCode global configuration",
                    "JSONC",
                    root.join("opencode/opencode.jsonc"),
                    &["CLI"],
                ),
                configuration_store(
                    "opencode-tui-json",
                    "OpenCode terminal interface",
                    "JSON",
                    root.join("opencode/tui.json"),
                    &["CLI"],
                ),
                configuration_store(
                    "opencode-tui-jsonc",
                    "OpenCode terminal interface",
                    "JSONC",
                    root.join("opencode/tui.jsonc"),
                    &["CLI"],
                ),
                configuration_directory_store(
                    "opencode-global-plugins",
                    "OpenCode local plugins",
                    root.join("opencode/plugins"),
                    &["CLI"],
                ),
            ]
        })
        .unwrap_or_default();
    let surfaces = vec![cli_surface("opencode-cli", "OpenCode CLI", &["opencode"])];
    let status = runtime_status(&stores, &surfaces);
    let runtime = HarnessRuntimeSummary {
        id: "opencode-cli".into(),
        name: "OpenCode CLI".into(),
        status: status.clone(),
        message: "Global configuration and CLI installation are checked independently.".into(),
        config_stores: stores,
        surfaces,
    };
    family("opencode", "OpenCode", vec![runtime], status)
}

fn scan_gemini_cli_family() -> HarnessFamilySummary {
    let stores = gemini_cli_stores();
    let surfaces = vec![cli_surface("gemini-cli", "Gemini CLI", &["gemini"])];
    let status = runtime_status(&stores, &surfaces);
    let runtime = HarnessRuntimeSummary {
        id: "gemini-cli-runtime".into(),
        name: "Gemini CLI".into(),
        status: status.clone(),
        message: "User settings and installed extension manifests are checked locally.".into(),
        config_stores: stores,
        surfaces,
    };
    family("gemini-cli", "Gemini CLI", vec![runtime], status)
}

fn scan_catalog_entry(entry: &CatalogEntry) -> HarnessFamilySummary {
    let config_stores = home_config_stores(entry.id, entry.name, entry.home_configs);
    let mut surfaces = Vec::new();
    if !entry.executables.is_empty() {
        surfaces.push(cli_surface(
            &format!("{}-cli", entry.id),
            "CLI",
            entry.executables,
        ));
    }
    if !entry.applications.is_empty() {
        surfaces.push(application_surface(
            &format!("{}-desktop", entry.id),
            "Desktop app",
            entry.applications,
        ));
    }
    if !entry.extensions.is_empty() {
        surfaces.push(extension_surface(
            &format!("{}-extension", entry.id),
            "IDE extension",
            entry.extensions,
        ));
    }
    let status = runtime_status(&config_stores, &surfaces);
    let message = if entry.home_configs.is_empty() {
        "Catalog probe currently checks installation surfaces only.".into()
    } else {
        "Known installation and configuration paths are checked locally.".into()
    };
    let runtime = HarnessRuntimeSummary {
        id: format!("{}-runtime", entry.id),
        name: entry.name.into(),
        status: status.clone(),
        message,
        config_stores,
        surfaces,
    };
    family(entry.id, entry.name, vec![runtime], status)
}

fn family(
    id: &str,
    name: &str,
    runtimes: Vec<HarnessRuntimeSummary>,
    status: HarnessStatus,
) -> HarnessFamilySummary {
    let configured = runtimes
        .iter()
        .filter(|runtime| matches!(runtime.status, HarnessStatus::Configured))
        .count();
    let installed = runtimes
        .iter()
        .filter(|runtime| matches!(runtime.status, HarnessStatus::Installed))
        .count();
    let message = match status {
        HarnessStatus::Configured => format!(
            "{} configured runtime{}{}",
            configured,
            if configured == 1 { "" } else { "s" },
            if installed > 0 {
                format!(" · {installed} installed-only")
            } else {
                String::new()
            }
        ),
        HarnessStatus::Installed => "Installed with no known configuration source".into(),
        HarnessStatus::Attention => "A configuration source needs attention".into(),
        HarnessStatus::NotDetected => "No bounded signal found".into(),
    };

    HarnessFamilySummary {
        id: id.into(),
        name: name.into(),
        status,
        message,
        runtimes,
    }
}

fn runtime_status(
    config_stores: &[ConfigurationStore],
    surfaces: &[SurfaceSummary],
) -> HarnessStatus {
    let configured = config_stores.iter().any(|store| store.exists);
    let installed = surfaces
        .iter()
        .any(|surface| !matches!(surface.status, HarnessStatus::NotDetected));
    presence_status(installed, configured)
}

fn aggregate_status(statuses: &[HarnessStatus]) -> HarnessStatus {
    if statuses
        .iter()
        .any(|status| matches!(status, HarnessStatus::Attention))
    {
        HarnessStatus::Attention
    } else if statuses
        .iter()
        .any(|status| matches!(status, HarnessStatus::Configured))
    {
        HarnessStatus::Configured
    } else if statuses
        .iter()
        .any(|status| matches!(status, HarnessStatus::Installed))
    {
        HarnessStatus::Installed
    } else {
        HarnessStatus::NotDetected
    }
}

fn presence_status(installed: bool, configured: bool) -> HarnessStatus {
    if configured {
        HarnessStatus::Configured
    } else if installed {
        HarnessStatus::Installed
    } else {
        HarnessStatus::NotDetected
    }
}

fn configuration_store(
    id: &str,
    label: &str,
    format: &str,
    path: PathBuf,
    shared_by: &[&str],
) -> ConfigurationStore {
    let exists = path.is_file();
    ConfigurationStore {
        id: id.into(),
        label: label.into(),
        format: format.into(),
        path: display_path(path),
        exists,
        shared_by: shared_by.iter().map(|item| (*item).into()).collect(),
    }
}

fn configuration_directory_store(
    id: &str,
    label: &str,
    path: PathBuf,
    shared_by: &[&str],
) -> ConfigurationStore {
    let exists = path.is_dir();
    ConfigurationStore {
        id: id.into(),
        label: label.into(),
        format: "Directory".into(),
        path: display_path(path),
        exists,
        shared_by: shared_by.iter().map(|item| (*item).into()).collect(),
    }
}

fn home_config_stores(id: &str, name: &str, paths: &[(&str, &str)]) -> Vec<ConfigurationStore> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    paths
        .iter()
        .enumerate()
        .map(|(index, (path, format))| {
            configuration_store(
                &format!("{id}-config-{index}"),
                &format!("{name} configuration"),
                format,
                catalog_config_path(id, &home, path),
                &["CLI"],
            )
        })
        .collect()
}

fn catalog_config_path(id: &str, home: &Path, relative: &str) -> PathBuf {
    let override_path = match id {
        "github-copilot-cli" if relative == ".copilot/providers.json" => {
            env::var_os("COPILOT_PROVIDERS_CONFIG").map(PathBuf::from)
        }
        _ => None,
    };
    if let Some(path) = override_path {
        return path;
    }
    let (variable, prefix) = match id {
        "github-copilot-cli" => ("COPILOT_HOME", ".copilot/"),
        "cline" => ("CLINE_DATA_DIR", ".cline/data/"),
        "goose" => ("XDG_CONFIG_HOME", ".config/"),
        _ => return home.join(relative),
    };
    env::var_os(variable)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .and_then(|root| {
            relative
                .strip_prefix(prefix)
                .map(|suffix| root.join(suffix))
        })
        .unwrap_or_else(|| home.join(relative))
}

fn cli_surface(id: &str, name: &str, executable_names: &[&str]) -> SurfaceSummary {
    let installation = executable_names
        .iter()
        .find_map(|name| find_executable(name));
    let found = installation.is_some();
    let path = installation
        .map(display_path)
        .unwrap_or_else(|| executable_names.join(", "));
    SurfaceSummary {
        id: id.into(),
        name: name.into(),
        kind: "CLI".into(),
        status: if found {
            HarnessStatus::Installed
        } else {
            HarnessStatus::NotDetected
        },
        evidence: vec![DetectionEvidence {
            kind: "executable".into(),
            label: "CLI executable".into(),
            path,
            found,
        }],
    }
}

fn application_surface(id: &str, name: &str, application_names: &[&str]) -> SurfaceSummary {
    let installation = find_application(application_names);
    let found = installation.is_some();
    let path = installation
        .map(display_path)
        .unwrap_or_else(|| application_names.join(", "));
    SurfaceSummary {
        id: id.into(),
        name: name.into(),
        kind: "Desktop".into(),
        status: if found {
            HarnessStatus::Installed
        } else {
            HarnessStatus::NotDetected
        },
        evidence: vec![DetectionEvidence {
            kind: "application".into(),
            label: "Desktop application".into(),
            path,
            found,
        }],
    }
}

fn extension_surface(id: &str, name: &str, extension_prefixes: &[&str]) -> SurfaceSummary {
    let installation = find_editor_extension(extension_prefixes);
    let found = installation.is_some();
    let path = installation
        .map(display_path)
        .unwrap_or_else(|| extension_prefixes.join(", "));
    SurfaceSummary {
        id: id.into(),
        name: name.into(),
        kind: "IDE extension".into(),
        status: if found {
            HarnessStatus::Installed
        } else {
            HarnessStatus::NotDetected
        },
        evidence: vec![DetectionEvidence {
            kind: "extension".into(),
            label: "Editor extension".into(),
            path,
            found,
        }],
    }
}

fn claude_code_stores() -> Vec<ConfigurationStore> {
    let root = env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".claude")));
    let mut stores = root
        .map(|root| {
            vec![
                configuration_store(
                    "claude-code-settings",
                    "Claude Code settings",
                    "JSON",
                    root.join("settings.json"),
                    &["CLI", "IDE extension", "Desktop Code tab"],
                ),
                configuration_store(
                    "claude-code-plugins-installed",
                    "Claude Code installed plugins",
                    "JSON",
                    root.join("plugins/installed_plugins.json"),
                    &["CLI", "IDE extension", "Desktop Code tab"],
                ),
                configuration_store(
                    "claude-code-plugin-marketplaces",
                    "Claude Code plugin marketplaces",
                    "JSON",
                    root.join("plugins/known_marketplaces.json"),
                    &["CLI", "IDE extension", "Desktop Code tab"],
                ),
            ]
        })
        .unwrap_or_default();
    if let Some(home) = home_dir() {
        stores.push(configuration_store(
            "claude-code-state",
            "Claude Code user state and MCP servers",
            "JSON",
            home.join(".claude.json"),
            &["CLI", "IDE extension", "Desktop Code tab"],
        ));
    }
    stores
}

fn gemini_cli_stores() -> Vec<ConfigurationStore> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };

    let extension_root = home.join(".gemini/extensions");
    let mut stores = vec![configuration_store(
        "gemini-cli-settings",
        "Gemini CLI user settings",
        "JSON",
        home.join(".gemini/settings.json"),
        &["CLI"],
    )];

    let Ok(entries) = fs::read_dir(extension_root) else {
        return stores;
    };

    let mut manifests = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path().join("gemini-extension.json");
            path.is_file().then_some((entry.file_name(), path))
        })
        .collect::<Vec<_>>();
    manifests.sort_by(|(left, _), (right, _)| left.cmp(right));

    stores.extend(
        manifests
            .into_iter()
            .enumerate()
            .map(|(index, (name, path))| {
                configuration_store(
                    &format!("gemini-cli-extension-{index}"),
                    &format!("Gemini CLI extension: {}", name.to_string_lossy()),
                    "JSON",
                    path,
                    &["CLI"],
                )
            }),
    );
    stores
}

fn opencode_config_root() -> Option<PathBuf> {
    env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            #[cfg(windows)]
            {
                env::var_os("APPDATA").map(PathBuf::from)
            }
            #[cfg(not(windows))]
            {
                home_dir().map(|home| home.join(".config"))
            }
        })
}

fn catalog_entries() -> Vec<CatalogEntry> {
    vec![
        CatalogEntry {
            id: "deepseek-harness",
            name: "DeepSeek Harness",
            executables: &["deepseek-harness"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "gemini-cli",
            name: "Gemini CLI",
            executables: &["gemini"],
            applications: &[],
            extensions: &[],
            home_configs: &[(".gemini/settings.json", "JSON")],
        },
        CatalogEntry {
            id: "pi",
            name: "Pi",
            executables: &["pi"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "openhands",
            name: "OpenHands",
            executables: &["openhands"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "open-interpreter",
            name: "Open Interpreter",
            executables: &["interpreter"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "cline",
            name: "Cline",
            executables: &["cline"],
            applications: &[],
            extensions: &["saoudrizwan.claude-dev", "saoudrizwan.cline", "cline.cline"],
            home_configs: &[
                (".cline/data/settings/global-settings.json", "JSON"),
                (".cline/data/settings/cline_mcp_settings.json", "JSON"),
                (".cline/data/settings/providers.json", "JSON"),
            ],
        },
        CatalogEntry {
            id: "warp",
            name: "Warp",
            executables: &["warp"],
            applications: &["Warp.app"],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "goose",
            name: "Goose",
            executables: &["goose"],
            applications: &["Goose.app"],
            extensions: &[],
            home_configs: &[(".config/goose/config.yaml", "YAML")],
        },
        CatalogEntry {
            id: "aider",
            name: "Aider",
            executables: &["aider"],
            applications: &[],
            extensions: &[],
            home_configs: &[(".aider.conf.yml", "YAML")],
        },
        CatalogEntry {
            id: "codewhale",
            name: "Codewhale",
            executables: &["codewhale"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "continue",
            name: "Continue",
            executables: &["continue"],
            applications: &[],
            extensions: &["continuedev.continue"],
            home_configs: &[(".continue/config.yaml", "YAML")],
        },
        CatalogEntry {
            id: "deepseek-reasonix",
            name: "DeepSeek Reasonix",
            executables: &["reasonix"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "gpt-pilot",
            name: "GPT Pilot",
            executables: &["gpt-pilot"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "oh-my-pi",
            name: "OH-MY-PI",
            executables: &["oh-my-pi"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "deep-agents-code",
            name: "Deep Agents Code",
            executables: &["deepagents", "deep-agents"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "crush",
            name: "Crush",
            executables: &["crush"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "qwen-code",
            name: "Qwen Code",
            executables: &["qwen", "qwen-code"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "kilo-code",
            name: "Kilo Code",
            executables: &["kilo", "kilocode"],
            applications: &[],
            extensions: &["kilocode.kilo-code"],
            home_configs: &[],
        },
        CatalogEntry {
            id: "grok-build",
            name: "Grok Build",
            executables: &["grok-build"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "dyad",
            name: "Dyad",
            executables: &["dyad"],
            applications: &["Dyad.app"],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "swe-agent",
            name: "SWE-agent",
            executables: &["sweagent", "swe-agent"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "prime-agent",
            name: "Prime Agent",
            executables: &["prime-agent"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "devika",
            name: "Devika",
            executables: &["devika"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "jcode",
            name: "JCode",
            executables: &["jcode"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "bolt",
            name: "Bolt",
            executables: &["bolt"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "deepcode",
            name: "DeepCode",
            executables: &["deepcode"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "plandex",
            name: "Plandex",
            executables: &["plandex"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "mimo-code",
            name: "MiMo Code",
            executables: &["mimo"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "trae-agent",
            name: "Trae Agent",
            executables: &["trae-agent"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "codebuff",
            name: "Codebuff",
            executables: &["codebuff"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "kimi-code-cli",
            name: "Kimi Code CLI",
            executables: &["kimi", "kimi-cli"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "claude-engineer",
            name: "Claude Engineer",
            executables: &["claude-engineer"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "github-copilot-cli",
            name: "GitHub Copilot CLI",
            executables: &["copilot"],
            applications: &[],
            extensions: &[],
            home_configs: &[
                (".copilot/settings.json", "JSONC"),
                (".copilot/mcp-config.json", "JSON"),
                (".copilot/config.json", "JSON"),
                (".copilot/providers.json", "JSON"),
                (".copilot/lsp-config.json", "JSON"),
                (".copilot/permissions-config.json", "JSON"),
            ],
        },
        CatalogEntry {
            id: "open-swe",
            name: "Open SWE",
            executables: &["open-swe"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "forgecode",
            name: "ForgeCode",
            executables: &["forgecode"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "stagewise",
            name: "Stagewise",
            executables: &[],
            applications: &["Stagewise.app"],
            extensions: &["stagewise.stagewise"],
            home_configs: &[],
        },
        CatalogEntry {
            id: "opencursor",
            name: "OpenCursor",
            executables: &["opencursor"],
            applications: &["OpenCursor.app"],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "melty",
            name: "Melty",
            executables: &["melty"],
            applications: &["Melty.app"],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "kodu",
            name: "Kodu",
            executables: &["kodu"],
            applications: &[],
            extensions: &["kodu.kodu"],
            home_configs: &[],
        },
        CatalogEntry {
            id: "mistral-vibe",
            name: "Mistral Vibe",
            executables: &["vibe"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "gptme",
            name: "gptme",
            executables: &["gptme"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "command-code",
            name: "Command Code",
            executables: &["command-code"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "grok-cli",
            name: "Grok CLI",
            executables: &["grok"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "devon",
            name: "Devon",
            executables: &["devon"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "letta-code",
            name: "Letta Code",
            executables: &["letta"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
        CatalogEntry {
            id: "autocoderover",
            name: "AutoCodeRover",
            executables: &["autocoderover"],
            applications: &[],
            extensions: &[],
            home_configs: &[],
        },
    ]
}

fn find_application(names: &[&str]) -> Option<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from("/Applications"));
        if let Some(home) = home_dir() {
            roots.push(home.join("Applications"));
        }
    }
    #[cfg(windows)]
    {
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            roots.push(PathBuf::from(local_app_data).join("Programs"));
        }
    }

    roots.into_iter().find_map(|root| {
        names
            .iter()
            .map(|name| root.join(name))
            .find(|candidate| candidate.is_dir())
    })
}

fn find_editor_extension(prefixes: &[&str]) -> Option<PathBuf> {
    let home = home_dir()?;
    let roots = [
        home.join(".vscode/extensions"),
        home.join(".vscode-insiders/extensions"),
        home.join(".cursor/extensions"),
        home.join(".windsurf/extensions"),
        home.join(".vscode-oss/extensions"),
        home.join(".vscode-server/extensions"),
    ];

    roots.into_iter().find_map(|root| {
        fs::read_dir(root)
            .ok()?
            .filter_map(Result::ok)
            .find_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                prefixes
                    .iter()
                    .any(|prefix| name.starts_with(&prefix.to_ascii_lowercase()))
                    .then(|| entry.path())
            })
    })
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
        if let Some(table) = value.as_table() {
            return table
                .keys()
                .map(|key| (key.clone(), serde_json::Value::String("[redacted]".into())))
                .collect::<serde_json::Map<_, _>>()
                .into();
        }
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

fn update_codex_document<F>(expected_revision: &str, mutate: F) -> Result<(), String>
where
    F: FnOnce(&mut DocumentMut, &toml::Value) -> Result<(), String>,
{
    let path = codex_config_path();
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let revision = configuration_revision(&content);
    if revision != expected_revision {
        return Err("The configuration changed on disk. Reload it before saving again.".into());
    }

    let config = content
        .parse::<toml::Value>()
        .map_err(|error| format!("Could not parse Codex configuration: {error}"))?;
    let mut document = content
        .parse::<DocumentMut>()
        .map_err(|error| format!("Could not preserve Codex configuration formatting: {error}"))?;

    mutate(&mut document, &config)?;

    let next_content = document.to_string();
    next_content
        .parse::<toml::Value>()
        .map_err(|error| format!("The updated Codex configuration is invalid: {error}"))?;
    write_configuration_atomically(&path, &next_content)
}

fn write_configuration_atomically(path: &Path, content: &str) -> Result<(), String> {
    let resolved_path = fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve configuration path: {error}"))?;
    let path = resolved_path.as_path();
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Could not determine filename for {}", path.display()))?;
    let parent = path.parent().ok_or_else(|| {
        format!(
            "Could not determine parent directory for {}",
            path.display()
        )
    })?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temporary_path = parent.join(format!(".{file_name}.omniharness-{nonce}.tmp"));
    let backup_path = parent.join(format!("{file_name}.omniharness.bak"));

    let mut temporary = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .map_err(|error| format!("Could not prepare configuration update: {error}"))?;
    if let Err(error) = temporary
        .write_all(content.as_bytes())
        .and_then(|_| temporary.sync_all())
    {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("Could not write configuration update: {error}"));
    }
    fs::set_permissions(&temporary_path, metadata.permissions())
        .map_err(|error| format!("Could not preserve configuration permissions: {error}"))?;
    fs::copy(path, &backup_path)
        .map_err(|error| format!("Could not create configuration backup: {error}"))?;
    fs::rename(&temporary_path, path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        format!("Could not replace configuration atomically: {error}")
    })
}

fn configuration_revision(content: &str) -> String {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn update_structured_configuration(
    store: &ConfigurationStore,
    path: &[String],
    setting_value: serde_json::Value,
    expected_revision: &str,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("A configuration path is required.".into());
    }
    let content = fs::read_to_string(&store.path)
        .map_err(|error| format!("Could not read {}: {error}", store.path))?;
    if configuration_revision(&content) != expected_revision {
        return Err("The configuration changed on disk. Reload it before saving again.".into());
    }

    let mut config = parse_structured_configuration(&store.format, &content)?;
    let before = config.clone();
    let schema = config_schema::schema_id(&store.id);
    let pointer = format!(
        "/{}",
        path.iter()
            .map(|p| p.replace('~', "~0").replace('/', "~1"))
            .collect::<Vec<_>>()
            .join("/")
    );
    if before
        .pointer(&pointer)
        .is_some_and(contains_sensitive_value)
        || contains_sensitive_value(&setting_value)
    {
        return Err("Edit individual non-sensitive fields instead of replacing a section containing secrets.".into());
    }
    if let Some(schema_id) = schema {
        if !config_schema::known_root(schema_id, &path[0]) {
            return Err(
                "This setting is not in the bundled provider schema. It is preserved read-only."
                    .into(),
            );
        }
        set_json_value(&mut config, path, setting_value.clone())?;
        config_schema::validate_change(schema_id, &before, &config, path)?;
    } else {
        set_existing_json_value(&mut config, path, setting_value.clone())?;
    }
    let next_content = if store.format == "TOML" {
        let mut document = content.parse::<DocumentMut>().map_err(|e| e.to_string())?;
        set_toml_value(
            document.as_item_mut(),
            path,
            json_to_toml_item(&setting_value)?,
        )?;
        document.to_string()
    } else {
        serialize_structured_configuration(&store.format, &config)?
    };
    write_configuration_atomically(Path::new(&store.path), &next_content)
}

fn parse_structured_configuration(
    format: &str,
    content: &str,
) -> Result<serde_json::Value, String> {
    match format {
        "TOML" => content
            .parse::<toml::Value>()
            .map_err(|e| e.to_string())
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "JSON" => {
            serde_json::from_str(content).map_err(|error| format!("Could not parse JSON: {error}"))
        }
        "JSONC" => {
            json5::from_str(content).map_err(|error| format!("Could not parse JSONC: {error}"))
        }
        "YAML" | "YML" => {
            let value = serde_yaml::from_str::<serde_yaml::Value>(content)
                .map_err(|error| format!("Could not parse YAML: {error}"))?;
            serde_json::to_value(value)
                .map_err(|error| format!("Could not normalize YAML: {error}"))
        }
        _ => Err(format!(
            "Unsupported structured configuration format: {format}"
        )),
    }
}

fn serialize_structured_configuration(
    format: &str,
    value: &serde_json::Value,
) -> Result<String, String> {
    match format {
        "JSON" | "JSONC" => serde_json::to_string_pretty(value)
            .map(|content| format!("{content}\n"))
            .map_err(|error| format!("Could not serialize JSON configuration: {error}")),
        "YAML" | "YML" => serde_yaml::to_string(value)
            .map_err(|error| format!("Could not serialize YAML configuration: {error}")),
        _ => Err(format!(
            "Unsupported structured configuration format: {format}"
        )),
    }
}

fn set_existing_json_value(
    current: &mut serde_json::Value,
    path: &[String],
    next: serde_json::Value,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("A configuration path is required.".into());
    }
    if path.len() == 1 {
        let object = current
            .as_object_mut()
            .ok_or_else(|| "The configuration root is not an object.".to_string())?;
        let existing = object
            .get(&path[0])
            .ok_or_else(|| "This setting is not present in the configuration.".to_string())?;
        if !matching_scalar_types(existing, &next) {
            return Err("The updated value has an incompatible type.".into());
        }
        object.insert(path[0].clone(), next);
        return Ok(());
    }

    let segment = &path[0];
    match current {
        serde_json::Value::Object(object) => {
            let child = object
                .get_mut(segment)
                .ok_or_else(|| "This setting is not present in the configuration.".to_string())?;
            set_existing_json_value(child, &path[1..], next)
        }
        serde_json::Value::Array(values) => {
            let index = segment.parse::<usize>().map_err(|_| {
                "The configuration path contains an invalid list index.".to_string()
            })?;
            let child = values
                .get_mut(index)
                .ok_or_else(|| "This setting is not present in the configuration.".to_string())?;
            set_existing_json_value(child, &path[1..], next)
        }
        _ => Err("The configuration path cannot be updated.".into()),
    }
}

fn matching_scalar_types(current: &serde_json::Value, next: &serde_json::Value) -> bool {
    (current.is_string() && next.is_string())
        || (current.is_boolean() && next.is_boolean())
        || (current.is_number() && next.is_number())
}

fn configuration_file_preview(store: &ConfigurationStore) -> ConfigurationFilePreview {
    let mut preview = ConfigurationFilePreview {
        schema_id: config_schema::schema_id(&store.id).map(str::to_string),
        schema_issues: Vec::new(),
        id: store.id.clone(),
        path: store.path.clone(),
        format: store.format.clone(),
        exists: store.exists,
        revision: None,
        content: None,
        diagnostic: None,
    };

    if !store.exists {
        preview.diagnostic = Some("No configuration file was found at this known location.".into());
        return preview;
    }

    if store.format == "Directory" {
        let entries = match fs::read_dir(&store.path) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| !name.starts_with('.'))
                .collect::<Vec<_>>(),
            Err(error) => {
                preview.diagnostic = Some(format!("Could not read this directory: {error}"));
                return preview;
            }
        };
        let mut entries = entries;
        entries.sort();
        entries.truncate(200);
        let content = entries.join("\n");
        preview.revision = Some(configuration_revision(&content));
        preview.content = Some(serde_json::json!({ "plugins": entries }));
        return preview;
    }

    let content = match fs::read_to_string(&store.path) {
        Ok(content) => content,
        Err(error) => {
            preview.diagnostic = Some(format!("Could not read this configuration: {error}"));
            return preview;
        }
    };
    preview.revision = Some(configuration_revision(&content));

    match store.format.as_str() {
        "TOML" => match content.parse::<toml::Value>() {
            Ok(value) => preview.content = Some(redact_toml(&value, None)),
            Err(error) => preview.diagnostic = Some(format!("Could not parse TOML: {error}")),
        },
        "JSON" => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(value) => preview.content = Some(redact_json(&value, None)),
            Err(error) => preview.diagnostic = Some(format!("Could not parse JSON: {error}")),
        },
        "JSONC" => match json5::from_str::<serde_json::Value>(&content) {
            Ok(value) => preview.content = Some(redact_json(&value, None)),
            Err(error) => preview.diagnostic = Some(format!("Could not parse JSONC: {error}")),
        },
        "YAML" | "YML" => match serde_yaml::from_str::<serde_yaml::Value>(&content) {
            Ok(value) => match serde_json::to_value(value) {
                Ok(value) => preview.content = Some(redact_json(&value, None)),
                Err(error) => {
                    preview.diagnostic = Some(format!("Could not normalize YAML: {error}"));
                }
            },
            Err(error) => preview.diagnostic = Some(format!("Could not parse YAML: {error}")),
        },
        format => {
            preview.diagnostic = Some(format!(
                "A safe structured preview for {format} files is not available yet."
            ));
        }
    }

    if let Some(id) = &preview.schema_id {
        // Validate original data before redaction changes sensitive values into strings.
        if let Ok(value) = parse_structured_configuration(&store.format, &content) {
            preview.schema_issues = config_schema::issues(id, &value);
        }
    }
    preview
}

fn redact_json(value: &serde_json::Value, key: Option<&str>) -> serde_json::Value {
    if key.is_some_and(is_sensitive_key) {
        if let Some(object) = value.as_object() {
            return object
                .keys()
                .map(|key| (key.clone(), serde_json::Value::String("[redacted]".into())))
                .collect::<serde_json::Map<_, _>>()
                .into();
        }
        return serde_json::Value::String("[redacted]".into());
    }

    match value {
        serde_json::Value::Object(object) => object
            .iter()
            .map(|(child_key, child_value)| {
                (child_key.clone(), redact_json(child_value, Some(child_key)))
            })
            .collect::<serde_json::Map<_, _>>()
            .into(),
        serde_json::Value::Array(values) => values
            .iter()
            .map(|child| redact_json(child, key))
            .collect::<Vec<_>>()
            .into(),
        value => value.clone(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
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
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
        || matches!(
            normalized.as_str(),
            "token"
                | "credentials"
                | "credential"
                | "env"
                | "envs"
                | "environment"
                | "headers"
                | "httpheaders"
                | "setenv"
        )
}

fn contains_sensitive_value(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => object
            .iter()
            .any(|(key, value)| is_sensitive_key(key) || contains_sensitive_value(value)),
        serde_json::Value::Array(values) => values.iter().any(contains_sensitive_value),
        serde_json::Value::String(value) => value == "[redacted]",
        _ => false,
    }
}

fn set_json_value(
    current: &mut serde_json::Value,
    path: &[String],
    next: serde_json::Value,
) -> Result<(), String> {
    let (head, tail) = path
        .split_first()
        .ok_or("A configuration path is required.")?;
    match current {
        serde_json::Value::Object(object) => {
            if tail.is_empty() {
                object.insert(head.clone(), next);
                return Ok(());
            }
            let child = object
                .entry(head.clone())
                .or_insert_with(|| serde_json::json!({}));
            set_json_value(child, tail, next)
        }
        serde_json::Value::Array(values) => {
            let index = head.parse::<usize>().map_err(|_| "Invalid list index.")?;
            let child = values.get_mut(index).ok_or("List index is out of range.")?;
            if tail.is_empty() {
                *child = next;
                Ok(())
            } else {
                set_json_value(child, tail, next)
            }
        }
        _ => Err("The parent setting is not a collection.".into()),
    }
}

fn json_to_toml_item(value: &serde_json::Value) -> Result<toml_edit::Item, String> {
    // Parse a one-value TOML document to support arrays, inline tables and scalars.
    let wrapped = serde_json::json!({"setting": value});
    let text = toml::to_string(&wrapped)
        .map_err(|e| format!("Value cannot be represented in TOML: {e}"))?;
    let mut document = text.parse::<DocumentMut>().map_err(|e| e.to_string())?;
    Ok(document.remove("setting").ok_or("Missing TOML value.")?)
}

fn set_toml_value(
    current: &mut toml_edit::Item,
    path: &[String],
    next: toml_edit::Item,
) -> Result<(), String> {
    let (head, tail) = path
        .split_first()
        .ok_or("A configuration path is required.")?;
    if current.is_none() {
        *current = toml_edit::Item::Table(toml_edit::Table::new());
    }
    if let Some(table) = current.as_table_like_mut() {
        if tail.is_empty() {
            table.insert(head, next);
            return Ok(());
        }
        if !table.contains_key(head) {
            table.insert(head, toml_edit::Item::Table(toml_edit::Table::new()));
        }
        return set_toml_value(
            table.get_mut(head).ok_or("Missing TOML parent.")?,
            tail,
            next,
        );
    }
    // Array elements are edited through their containing array, preserving all other sections.
    Err("Edit the containing TOML list to change this entry.".into())
}

#[derive(Serialize)]
struct ContextDocument {
    content: String,
    revision: String,
}

fn resolve_context_file(project_path: String, id: String) -> Result<PathBuf, String> {
    scan_project_context(project_path)?
        .artifacts
        .into_iter()
        .find(|item| item.id == id)
        .map(|item| PathBuf::from(item.path))
        .ok_or_else(|| {
            "This context file is no longer in the project inventory. Rescan first.".into()
        })
}

#[tauri::command]
fn read_context_file(project_path: String, id: String) -> Result<ContextDocument, String> {
    let path = resolve_context_file(project_path, id)?;
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 1_048_576 {
        return Err("This file exceeds the 1 MB editor limit.".into());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(ContextDocument {
        revision: configuration_revision(&content),
        content,
    })
}

#[tauri::command]
fn open_context_file(project_path: String, id: String) -> Result<(), String> {
    let path = resolve_context_file(project_path, id)?;
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&path).status();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("notepad.exe")
        .arg(&path)
        .spawn()
        .map(|_| ());
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = std::process::Command::new("xdg-open").arg(&path).status();
    #[cfg(not(target_os = "windows"))]
    {
        let status = result.map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("Could not open the default text editor.".into());
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    result.map_err(|error| error.to_string())
}

#[tauri::command]
fn save_context_file(
    project_path: String,
    id: String,
    content: String,
    expected_revision: String,
) -> Result<(), String> {
    if content.len() > 1_048_576 {
        return Err("This file exceeds the 1 MB editor limit.".into());
    }
    let path = resolve_context_file(project_path, id)?;
    let current = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if configuration_revision(&current) != expected_revision {
        return Err("The file changed on disk. Close and reopen it before saving.".into());
    }
    write_configuration_atomically(&path, &content)
}

#[tauri::command]
fn delete_context_file(
    project_path: String,
    id: String,
    expected_revision: String,
) -> Result<(), String> {
    let path = resolve_context_file(project_path, id)?;
    let current = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if configuration_revision(&current) != expected_revision {
        return Err("The file changed on disk. Close and reopen it before deleting.".into());
    }
    let backup = path.with_file_name(format!(
        "{}.omniharness-deleted-{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        unix_now()
    ));
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup)
        .and_then(|mut file| file.write_all(current.as_bytes()))
        .map_err(|e| e.to_string())?;
    fs::remove_file(path).map_err(|e| e.to_string())
}

fn collect_codex_context(
    project_root: &Path,
    workspace_root: &Path,
    artifacts: &mut Vec<ContextArtifact>,
    seen: &mut HashSet<String>,
) {
    let codex_home = codex_config_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(".codex"));
    add_instruction_pair(
        artifacts,
        seen,
        "Codex",
        "User",
        "active",
        "Loaded before project instructions",
        codex_home.join("AGENTS.override.md"),
        codex_home.join("AGENTS.md"),
        project_root,
    );

    if let Some(home) = home_dir() {
        add_skill_directory(
            artifacts,
            seen,
            "Codex",
            "User",
            "active",
            "Available in every project",
            &home.join(".agents/skills"),
            project_root,
        );
    }
    // Older local Codex installations and some managed setups retain this
    // directory. Showing it separately makes migrations visible.
    add_skill_directory(
        artifacts,
        seen,
        "Codex",
        "User",
        "active",
        "Available in every project",
        &codex_home.join("skills"),
        project_root,
    );
    add_skill_directory(
        artifacts,
        seen,
        "Codex",
        "System",
        "active",
        "Machine-managed skill",
        Path::new("/etc/codex/skills"),
        project_root,
    );

    let active_directories = context_path_directories(workspace_root, project_root);
    let project_directories = project_directories(project_root);
    for directory in project_directories {
        let active = active_directories.contains(&directory);
        let scope = if directory == workspace_root {
            "Project"
        } else {
            "Nested"
        };
        let state = if active { "active" } else { "conditional" };
        let activation = if active {
            "Loaded for the selected working directory"
        } else {
            "Discovered when work reaches this directory"
        };
        add_instruction_pair(
            artifacts,
            seen,
            "Codex",
            scope,
            state,
            activation,
            directory.join("AGENTS.override.md"),
            directory.join("AGENTS.md"),
            project_root,
        );
        add_skill_directory(
            artifacts,
            seen,
            "Codex",
            scope,
            state,
            activation,
            &directory.join(".agents/skills"),
            project_root,
        );
    }
}

fn collect_claude_context(
    project_root: &Path,
    workspace_root: &Path,
    artifacts: &mut Vec<ContextArtifact>,
    seen: &mut HashSet<String>,
) {
    #[cfg(target_os = "macos")]
    let managed_path = PathBuf::from("/Library/Application Support/ClaudeCode/CLAUDE.md");
    #[cfg(not(target_os = "macos"))]
    let managed_path = PathBuf::from("/etc/claude-code/CLAUDE.md");
    add_context_artifact(
        artifacts,
        seen,
        "Claude Code",
        "instruction",
        "Organization",
        "active",
        "Managed policy loaded before user and project context",
        managed_path,
        project_root,
    );

    if let Some(home) = home_dir() {
        add_context_artifact(
            artifacts,
            seen,
            "Claude Code",
            "instruction",
            "User",
            "active",
            "Loaded for every local Claude Code project",
            home.join(".claude/CLAUDE.md"),
            project_root,
        );
        add_skill_directory(
            artifacts,
            seen,
            "Claude Code",
            "User",
            "active",
            "Available in every local project",
            &home.join(".claude/skills"),
            project_root,
        );
    }

    let active_directories = context_path_directories(workspace_root, project_root);
    for directory in project_directories(project_root) {
        let active = active_directories.contains(&directory);
        let scope = if directory == workspace_root || directory == project_root {
            "Project"
        } else {
            "Nested"
        };
        let state = if active { "active" } else { "conditional" };
        let activation = if active {
            "Loaded for the selected working directory"
        } else {
            "Loaded when Claude works in this directory"
        };
        add_context_artifact(
            artifacts,
            seen,
            "Claude Code",
            "instruction",
            scope,
            state,
            activation,
            directory.join("CLAUDE.md"),
            project_root,
        );
        add_context_artifact(
            artifacts,
            seen,
            "Claude Code",
            "instruction",
            if directory == workspace_root {
                "Project"
            } else {
                "Local"
            },
            state,
            activation,
            directory.join("CLAUDE.local.md"),
            project_root,
        );
        add_context_artifact(
            artifacts,
            seen,
            "Claude Code",
            "instruction",
            scope,
            state,
            activation,
            directory.join(".claude/CLAUDE.md"),
            project_root,
        );
        add_skill_directory(
            artifacts,
            seen,
            "Claude Code",
            scope,
            state,
            activation,
            &directory.join(".claude/skills"),
            project_root,
        );
        add_markdown_directory(
            artifacts,
            seen,
            "Claude Code",
            "rule",
            scope,
            state,
            "Always loaded or path-matched by Claude Code",
            &directory.join(".claude/rules"),
            project_root,
        );
        add_markdown_directory(
            artifacts,
            seen,
            "Claude Code",
            "command",
            scope,
            state,
            "Available as a legacy Claude command",
            &directory.join(".claude/commands"),
            project_root,
        );
    }
}

fn collect_gemini_context(
    project_root: &Path,
    workspace_root: &Path,
    artifacts: &mut Vec<ContextArtifact>,
    seen: &mut HashSet<String>,
) {
    let mut names = vec!["GEMINI.md".to_string()];
    if let Some(home) = home_dir() {
        names.extend(gemini_context_filenames(
            &home.join(".gemini/settings.json"),
        ));
        for name in &names {
            add_context_artifact(
                artifacts,
                seen,
                "Gemini CLI",
                "instruction",
                "User",
                "active",
                "Loaded before workspace context",
                home.join(".gemini").join(name),
                project_root,
            );
        }
        add_skill_directory(
            artifacts,
            seen,
            "Gemini CLI",
            "User",
            "active",
            "Available in every project",
            &home.join(".gemini/skills"),
            project_root,
        );
        add_skill_directory(
            artifacts,
            seen,
            "Gemini CLI",
            "User",
            "active",
            "Available through Gemini's .agents alias",
            &home.join(".agents/skills"),
            project_root,
        );
    }

    let active_directories = context_path_directories(workspace_root, project_root);
    for directory in project_directories(project_root) {
        let mut directory_names = names.clone();
        directory_names.extend(gemini_context_filenames(
            &directory.join(".gemini/settings.json"),
        ));
        directory_names.sort();
        directory_names.dedup();
        let active = active_directories.contains(&directory);
        let scope = if directory == workspace_root || directory == project_root {
            "Project"
        } else {
            "Nested"
        };
        let state = if active { "active" } else { "conditional" };
        let activation = if active {
            "Loaded for the selected working directory"
        } else {
            "Discovered when Gemini works in this directory"
        };
        for name in &directory_names {
            add_context_artifact(
                artifacts,
                seen,
                "Gemini CLI",
                "instruction",
                scope,
                state,
                activation,
                directory.join(name),
                project_root,
            );
        }
        add_skill_directory(
            artifacts,
            seen,
            "Gemini CLI",
            scope,
            state,
            activation,
            &directory.join(".gemini/skills"),
            project_root,
        );
        add_skill_directory(
            artifacts,
            seen,
            "Gemini CLI",
            scope,
            state,
            "Available through Gemini's .agents alias",
            &directory.join(".agents/skills"),
            project_root,
        );
    }
}

fn gemini_context_filenames(settings_path: &Path) -> Vec<String> {
    let Ok(content) = fs::read_to_string(settings_path) else {
        return Vec::new();
    };
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Vec::new();
    };
    let Some(file_name) = settings
        .get("context")
        .and_then(serde_json::Value::as_object)
        .and_then(|context| context.get("fileName"))
    else {
        return Vec::new();
    };
    match file_name {
        serde_json::Value::String(name) => vec![name.clone()],
        serde_json::Value::Array(names) => names
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

#[allow(clippy::too_many_arguments)]
fn add_instruction_pair(
    artifacts: &mut Vec<ContextArtifact>,
    seen: &mut HashSet<String>,
    provider: &str,
    scope: &str,
    requested_state: &str,
    activation: &str,
    override_path: PathBuf,
    standard_path: PathBuf,
    project_root: &Path,
) {
    let override_exists = override_path.is_file();
    let standard_state = if override_exists {
        "shadowed"
    } else {
        requested_state
    };
    add_context_artifact(
        artifacts,
        seen,
        provider,
        "instruction",
        scope,
        requested_state,
        activation,
        override_path,
        project_root,
    );
    add_context_artifact(
        artifacts,
        seen,
        provider,
        "instruction",
        scope,
        standard_state,
        if override_exists {
            "Ignored because an override exists beside it"
        } else {
            activation
        },
        standard_path,
        project_root,
    );
}

#[allow(clippy::too_many_arguments)]
fn add_skill_directory(
    artifacts: &mut Vec<ContextArtifact>,
    seen: &mut HashSet<String>,
    provider: &str,
    scope: &str,
    state: &str,
    activation: &str,
    directory: &Path,
    project_root: &Path,
) {
    for skill_directory in project_directories(directory) {
        add_context_artifact(
            artifacts,
            seen,
            provider,
            "skill",
            scope,
            state,
            activation,
            skill_directory.join("SKILL.md"),
            project_root,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn add_markdown_directory(
    artifacts: &mut Vec<ContextArtifact>,
    seen: &mut HashSet<String>,
    provider: &str,
    kind: &str,
    scope: &str,
    state: &str,
    activation: &str,
    directory: &Path,
    project_root: &Path,
) {
    for child_directory in project_directories(directory) {
        let Ok(entries) = fs::read_dir(child_directory) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.extension().is_some_and(|extension| extension == "md") {
                add_context_artifact(
                    artifacts,
                    seen,
                    provider,
                    kind,
                    scope,
                    state,
                    activation,
                    path,
                    project_root,
                );
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn add_context_artifact(
    artifacts: &mut Vec<ContextArtifact>,
    seen: &mut HashSet<String>,
    provider: &str,
    kind: &str,
    scope: &str,
    state: &str,
    activation: &str,
    path: PathBuf,
    project_root: &Path,
) {
    if !path.is_file() {
        return;
    }
    let canonical_path = fs::canonicalize(&path).unwrap_or(path);
    let path_string = display_path(canonical_path.clone());
    let key = format!("{provider}:{kind}:{path_string}");
    if !seen.insert(key.clone()) {
        return;
    }
    let metadata = fs::metadata(&canonical_path).ok();
    let timestamp = |time: SystemTime| {
        time.duration_since(UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_secs())
    };
    let created_at = metadata
        .as_ref()
        .and_then(|meta| meta.created().ok())
        .and_then(timestamp);
    let modified_at = metadata
        .as_ref()
        .and_then(|meta| meta.modified().ok())
        .and_then(timestamp);
    artifacts.push(ContextArtifact {
        id: context_artifact_id(&key),
        provider: provider.into(),
        kind: kind.into(),
        scope: scope.into(),
        state: state.into(),
        activation: activation.into(),
        path: path_string,
        external: !canonical_path.starts_with(project_root),
        created_at,
        modified_at,
    });
}

fn context_artifact_id(source: &str) -> String {
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    format!("context-{:x}", hasher.finish())
}

fn find_workspace_root(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|ancestor| ancestor.join(".git").exists())
        .map(Path::to_path_buf)
}

fn context_path_directories(workspace_root: &Path, project_root: &Path) -> HashSet<PathBuf> {
    let mut directories = HashSet::new();
    if let Ok(relative) = project_root.strip_prefix(workspace_root) {
        let mut current = workspace_root.to_path_buf();
        directories.insert(current.clone());
        for component in relative.components() {
            current.push(component.as_os_str());
            directories.insert(current.clone());
        }
    } else {
        directories.insert(project_root.to_path_buf());
    }
    directories
}

fn project_directories(root: &Path) -> Vec<PathBuf> {
    if !root.is_dir() {
        return Vec::new();
    }
    const MAX_DEPTH: usize = 8;
    const MAX_DIRECTORIES: usize = 1_200;
    let mut directories = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0_usize)];
    while let Some((directory, depth)) = pending.pop() {
        if directories.len() >= MAX_DIRECTORIES {
            break;
        }
        directories.push(directory.clone());
        if depth >= MAX_DEPTH {
            continue;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if matches!(
                name.as_ref(),
                ".git" | "node_modules" | "target" | "dist" | "build" | ".next"
            ) {
                continue;
            }
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                pending.push((entry.path(), depth + 1));
            }
        }
    }
    directories
}

fn codex_config_path() -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
        .join("config.toml")
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let paths: OsString = env::var_os("PATH").unwrap_or_default();
    let mut directories = env::split_paths(&paths).collect::<Vec<_>>();

    if let Some(home) = home_dir() {
        directories.extend([
            home.join(".local/bin"),
            home.join(".opencode/bin"),
            home.join(".cargo/bin"),
            home.join(".npm-global/bin"),
        ]);
    }

    #[cfg(target_os = "macos")]
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);

    let mut seen = HashSet::new();
    directories
        .into_iter()
        .filter(|directory| seen.insert(directory.clone()))
        .flat_map(|directory| executable_candidates(&directory, name))
        .find(|candidate| is_executable(candidate))
}

fn executable_candidates(directory: &Path, name: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let extensions = env::var_os("PATHEXT")
            .map(|value| {
                value
                    .to_string_lossy()
                    .split(';')
                    .filter(|extension| !extension.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec![".EXE".into(), ".CMD".into(), ".BAT".into()]);
        let mut candidates = vec![directory.join(name)];
        candidates.extend(
            extensions
                .into_iter()
                .map(|extension| directory.join(format!("{name}{extension}"))),
        );
        candidates
    }

    #[cfg(not(windows))]
    {
        vec![directory.join(name)]
    }
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
        .plugin(tauri_plugin_dialog::init())
        .manage(ConfigWatcher::default())
        .invoke_handler(tauri::generate_handler![
            scan_harnesses,
            scan_project_context,
            read_context_file,
            open_context_file,
            save_context_file,
            delete_context_file,
            inspect_harness,
            inspect_configuration,
            update_codex_general_setting,
            update_codex_feature,
            update_codex_mcp_enabled,
            update_configuration_value,
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

    #[test]
    fn redacts_secret_values_in_json_previews() {
        let config = serde_json::json!({
            "model": "example",
            "connection": { "api_key": "super-secret" }
        });

        let preview = redact_json(&config, None);
        assert_eq!(preview["model"], "example");
        assert_eq!(preview["connection"]["api_key"], "[redacted]");
    }

    #[test]
    fn configuration_and_installation_are_distinct_presence_states() {
        assert!(matches!(
            presence_status(false, true),
            HarnessStatus::Configured
        ));
        assert!(matches!(
            presence_status(true, false),
            HarnessStatus::Installed
        ));
        assert!(matches!(
            presence_status(false, false),
            HarnessStatus::NotDetected
        ));
    }

    #[test]
    fn scan_checks_the_fifty_family_catalog() {
        let result = scan_harnesses();

        assert_eq!(result.families.len(), 50);
        assert!(result.families.iter().any(|item| item.id == "codex"));
        assert!(result.families.iter().any(|item| item.id == "claude"));
        assert!(result.families.iter().any(|item| item.id == "aider"));
    }

    #[test]
    fn codex_family_groups_all_surfaces_under_one_config_store() {
        let family = scan_codex_family();
        let runtime = family
            .runtimes
            .iter()
            .find(|runtime| runtime.id == "codex-local")
            .expect("Codex local runtime is present");

        assert_eq!(runtime.config_stores.len(), 1);
        assert_eq!(runtime.surfaces.len(), 3);
        assert!(runtime.config_stores[0]
            .shared_by
            .iter()
            .any(|surface| surface == "Desktop"));
    }

    #[test]
    fn codex_mutations_preserve_comments_and_validate_known_paths() {
        let source = r#"# Keep this comment
model = "old-model"

[features]
fast_mode = false

[mcp_servers.example]
command = "example-mcp"
"#;
        let config: toml::Value = source.parse().expect("fixture is valid TOML");
        let mut document = source
            .parse::<DocumentMut>()
            .expect("fixture preserves formatting");

        set_codex_general_setting(&mut document, "model", "new-model").expect("known setting");
        set_codex_feature(&mut document, &config, "fast_mode", true).expect("known feature");
        set_codex_mcp_enabled(&mut document, &config, "example", false).expect("known server");

        let output = document.to_string();
        assert!(output.contains("# Keep this comment"));
        let parsed: toml::Value = output.parse().expect("updated TOML is valid");
        assert_eq!(parsed["model"].as_str(), Some("new-model"));
        assert_eq!(parsed["features"]["fast_mode"].as_bool(), Some(true));
        assert_eq!(
            parsed["mcp_servers"]["example"]["enabled"].as_bool(),
            Some(false)
        );

        assert!(set_codex_general_setting(&mut document, "unknown", "value").is_err());
        assert!(set_codex_feature(&mut document, &config, "unknown", true).is_err());
        assert!(set_codex_mcp_enabled(&mut document, &config, "unknown", true).is_err());
    }

    #[test]
    fn configuration_revision_detects_content_changes() {
        assert_eq!(
            configuration_revision("model = \"a\""),
            configuration_revision("model = \"a\"")
        );
        assert_ne!(
            configuration_revision("model = \"a\""),
            configuration_revision("model = \"b\"")
        );
    }

    #[test]
    fn structured_writer_validates_additions_preserves_secrets_and_rejects_stale_edits() {
        let root = env::temp_dir().join(format!("omni-schema-write-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        let original = r#"{"model":"sonnet","env":{"KEY":"secret-value"},"futureSetting":true}"#;
        fs::write(&path, original).unwrap();
        let store = configuration_store("claude-code-settings", "test", "JSON", path.clone(), &[]);
        let revision = configuration_revision(original);
        assert!(update_structured_configuration(
            &store,
            &["cleanupPeriodDays".into()],
            serde_json::json!(0),
            &revision
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        update_structured_configuration(
            &store,
            &["permissions".into(), "allow".into()],
            serde_json::json!(["Bash(npm test)"]),
            &revision,
        )
        .unwrap();
        let saved = fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(parsed["env"]["KEY"], "secret-value");
        assert_eq!(parsed["futureSetting"], true);
        assert_eq!(parsed["permissions"]["allow"][0], "Bash(npm test)");
        assert!(update_structured_configuration(
            &store,
            &["model".into()],
            serde_json::json!("opus"),
            &revision
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), saved);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn toml_writer_supports_nested_options_lists_and_preserves_other_sections() {
        let root = env::temp_dir().join(format!("omni-toml-write-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("config.toml");
        let original = "# keep this comment\nmodel = \"example\"\n\n[mcp_servers.demo]\ncommand = \"demo\" # keep server\n";
        fs::write(&path, original).unwrap();
        let store = configuration_store("codex-home", "test", "TOML", path.clone(), &[]);
        update_structured_configuration(
            &store,
            &["project_doc_fallback_filenames".into()],
            serde_json::json!(["TEAM.md", "GUIDE.md"]),
            &configuration_revision(original),
        )
        .unwrap();
        let saved = fs::read_to_string(&path).unwrap();
        assert!(saved.contains("# keep this comment"));
        assert!(saved.contains("# keep server"));
        let parsed: toml::Value = saved.parse().unwrap();
        assert_eq!(
            parsed["project_doc_fallback_filenames"][1].as_str(),
            Some("GUIDE.md")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sensitive_containers_cannot_be_overwritten_and_budgets_are_visible() {
        assert!(contains_sensitive_value(
            &serde_json::json!({"env":{"KEY":"value"}})
        ));
        assert!(contains_sensitive_value(
            &serde_json::json!({"nested":[{"api-key":"value"}]})
        ));
        assert!(!is_sensitive_key("tool_output_token_limit"));
        assert!(!is_sensitive_key("cli_auth_credentials_store"));
        let redacted = redact_json(
            &serde_json::json!({"env":{"UNUSUAL_NAME":"value"},"maxTokens":500}),
            None,
        );
        assert_eq!(redacted["env"]["UNUSUAL_NAME"], "[redacted]");
        assert_eq!(redacted["maxTokens"], 500);
    }

    #[test]
    fn structured_updates_only_replace_existing_matching_scalars() {
        let mut config = serde_json::json!({
            "permissions": { "defaultMode": "ask" },
            "mcpServers": [{ "name": "docs", "disabled": false }]
        });

        set_existing_json_value(
            &mut config,
            &["permissions".into(), "defaultMode".into()],
            serde_json::json!("allow"),
        )
        .expect("existing nested string is writable");
        set_existing_json_value(
            &mut config,
            &["mcpServers".into(), "0".into(), "disabled".into()],
            serde_json::json!(true),
        )
        .expect("existing list boolean is writable");

        assert_eq!(config["permissions"]["defaultMode"], "allow");
        assert_eq!(config["mcpServers"][0]["disabled"], true);
        assert!(set_existing_json_value(
            &mut config,
            &["permissions".into(), "missing".into()],
            serde_json::json!("value"),
        )
        .is_err());
        assert!(set_existing_json_value(
            &mut config,
            &["permissions".into(), "defaultMode".into()],
            serde_json::json!(true),
        )
        .is_err());
        assert!(is_sensitive_key("api_key"));
        assert!(is_sensitive_key("accessToken"));
        assert!(!is_sensitive_key("defaultMode"));
    }

    #[test]
    fn atomic_write_keeps_a_recoverable_backup() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is available")
            .as_nanos();
        let directory = env::temp_dir().join(format!("omni-harness-test-{nonce}"));
        fs::create_dir(&directory).expect("temporary directory is created");
        let path = directory.join("config.toml");
        fs::write(&path, "model = \"before\"\n").expect("fixture is written");

        write_configuration_atomically(&path, "model = \"after\"\n")
            .expect("atomic write succeeds");

        assert_eq!(
            fs::read_to_string(&path).expect("updated file"),
            "model = \"after\"\n"
        );
        assert_eq!(
            fs::read_to_string(directory.join("config.toml.omniharness.bak")).expect("backup file"),
            "model = \"before\"\n"
        );

        fs::remove_dir_all(directory).expect("temporary directory is removed");
    }

    #[test]
    fn previews_plugin_directories_as_entry_names_only() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is available")
            .as_nanos();
        let directory = env::temp_dir().join(format!("omni-harness-plugins-test-{nonce}"));
        fs::create_dir_all(directory.join("local-package"))
            .expect("plugin package directory is created");
        fs::write(directory.join("reviewer.ts"), "export {};")
            .expect("plugin source fixture is written");
        fs::write(directory.join(".ignored"), "hidden").expect("hidden fixture is written");

        let preview = configuration_file_preview(&configuration_directory_store(
            "plugins",
            "Plugin directory fixture",
            directory.clone(),
            &[],
        ));
        let content = preview.content.expect("directory preview content");
        let plugins = content["plugins"]
            .as_array()
            .expect("plugin entries are an array");

        assert_eq!(plugins, &["local-package", "reviewer.ts"]);
        assert!(preview.revision.is_some());
        fs::remove_dir_all(directory).expect("temporary directory is removed");
    }

    #[test]
    fn project_context_marks_nested_guidance_as_conditional() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is available")
            .as_nanos();
        let directory = env::temp_dir().join(format!("omni-harness-context-test-{nonce}"));
        fs::create_dir_all(directory.join(".git")).expect("git fixture is created");
        fs::write(directory.join("AGENTS.md"), "# Root instructions")
            .expect("root instructions are written");
        fs::create_dir_all(directory.join(".agents/skills/review"))
            .expect("Codex skill fixture is created");
        fs::write(
            directory.join(".agents/skills/review/SKILL.md"),
            "---\nname: review\ndescription: Review code\n---\n",
        )
        .expect("skill is written");
        fs::create_dir_all(directory.join("packages/web")).expect("nested fixture is created");
        fs::write(
            directory.join("packages/web/AGENTS.md"),
            "# Nested instructions",
        )
        .expect("nested instructions are written");
        fs::create_dir_all(directory.join(".claude/rules"))
            .expect("Claude rules fixture is created");
        fs::write(directory.join(".claude/rules/testing.md"), "# Test rules")
            .expect("Claude rule is written");

        let report = scan_project_context(display_path(directory.clone()))
            .expect("project context is scanned");

        assert!(report.artifacts.iter().any(|artifact| {
            artifact.provider == "Codex"
                && artifact.kind == "instruction"
                && artifact.state == "active"
                && artifact.path.ends_with("AGENTS.md")
        }));
        assert!(report.artifacts.iter().any(|artifact| {
            artifact.provider == "Codex"
                && artifact.kind == "skill"
                && artifact.state == "active"
                && artifact.path.ends_with("review/SKILL.md")
        }));
        assert!(report.artifacts.iter().any(|artifact| {
            artifact.provider == "Codex"
                && artifact.state == "conditional"
                && artifact.path.ends_with("packages/web/AGENTS.md")
        }));
        assert!(report.artifacts.iter().any(|artifact| {
            artifact.provider == "Claude Code"
                && artifact.kind == "rule"
                && artifact.path.ends_with(".claude/rules/testing.md")
        }));

        fs::remove_dir_all(directory).expect("temporary directory is removed");
    }

    #[test]
    fn previews_jsonc_and_yaml_configurations_without_exposing_secrets() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is available")
            .as_nanos();
        let directory = env::temp_dir().join(format!("omni-harness-preview-test-{nonce}"));
        fs::create_dir(&directory).expect("temporary directory is created");

        let jsonc_path = directory.join("opencode.jsonc");
        fs::write(
            &jsonc_path,
            "// comment\n{ mcp: { servers: { docs: { disabled: true } } } }",
        )
        .expect("JSONC fixture is written");
        let jsonc_preview = configuration_file_preview(&configuration_store(
            "jsonc",
            "JSONC fixture",
            "JSONC",
            jsonc_path,
            &[],
        ));
        assert_eq!(
            jsonc_preview.content.expect("JSONC content")["mcp"]["servers"]["docs"]["disabled"],
            true
        );

        let yaml_path = directory.join("config.yaml");
        fs::write(&yaml_path, "api_key: hidden\nmcpServers:\n  - name: docs\n")
            .expect("YAML fixture is written");
        let yaml_preview = configuration_file_preview(&configuration_store(
            "yaml",
            "YAML fixture",
            "YAML",
            yaml_path,
            &[],
        ));
        assert_eq!(
            yaml_preview.content.expect("YAML content")["api_key"],
            "[redacted]"
        );

        fs::remove_dir_all(directory).expect("temporary directory is removed");
    }
}
