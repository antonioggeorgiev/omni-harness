//! The privileged, local-only side of Omni Harness.
//!
//! The frontend never receives general filesystem or shell access.  Instead it
//! asks this module for a deliberately small, read-only representation of a
//! known harness configuration.

use notify::{Config as WatchConfig, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashSet,
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
    path: String,
    format: String,
    exists: bool,
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

#[tauri::command]
fn scan_harnesses() -> ScanResult {
    let mut families = vec![
        scan_codex_family(),
        scan_claude_family(),
        scan_cursor_family(),
        scan_opencode_family(),
    ];
    families.extend(catalog_entries().iter().map(scan_catalog_entry));

    ScanResult {
        families,
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
                "Claude Desktop configuration",
                "JSON",
                home.join("Library/Application Support/Claude/claude_desktop_config.json"),
                &["Desktop chat"],
            )
        })
        .into_iter()
        .collect::<Vec<_>>();
    let desktop_surfaces = vec![application_surface(
        "claude-desktop-chat-app",
        "Claude Desktop",
        &["Claude.app"],
    )];
    let desktop_status = runtime_status(&desktop_store, &desktop_surfaces);
    let desktop_runtime = HarnessRuntimeSummary {
        id: "claude-desktop-chat".into(),
        name: "Claude Desktop".into(),
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
            vec![configuration_store(
                "cursor-cli",
                "Cursor Agent CLI configuration",
                "JSON",
                home.join(".cursor/cli-config.json"),
                &["CLI"],
            )]
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
                home.join(path),
                &["CLI"],
            )
        })
        .collect()
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
            vec![configuration_store(
                "claude-code-settings",
                "Claude Code settings",
                "JSON",
                root.join("settings.json"),
                &["CLI", "IDE extension", "Desktop Code tab"],
            )]
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
            home_configs: &[],
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

fn configuration_file_preview(store: &ConfigurationStore) -> ConfigurationFilePreview {
    let mut preview = ConfigurationFilePreview {
        path: store.path.clone(),
        format: store.format.clone(),
        exists: store.exists,
        content: None,
        diagnostic: None,
    };

    if !store.exists {
        preview.diagnostic = Some("No configuration file was found at this known location.".into());
        return preview;
    }

    let content = match fs::read_to_string(&store.path) {
        Ok(content) => content,
        Err(error) => {
            preview.diagnostic = Some(format!("Could not read this configuration: {error}"));
            return preview;
        }
    };

    match store.format.as_str() {
        "TOML" => match content.parse::<toml::Value>() {
            Ok(value) => preview.content = Some(redact_toml(&value, None)),
            Err(error) => preview.diagnostic = Some(format!("Could not parse TOML: {error}")),
        },
        "JSON" => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(value) => preview.content = Some(redact_json(&value, None)),
            Err(error) => preview.diagnostic = Some(format!("Could not parse JSON: {error}")),
        },
        format => {
            preview.diagnostic = Some(format!(
                "A safe structured preview for {format} files is not available yet."
            ));
        }
    }

    preview
}

fn redact_json(value: &serde_json::Value, key: Option<&str>) -> serde_json::Value {
    if key.is_some_and(is_sensitive_key) {
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
        .manage(ConfigWatcher::default())
        .invoke_handler(tauri::generate_handler![
            scan_harnesses,
            inspect_harness,
            inspect_configuration,
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
}
