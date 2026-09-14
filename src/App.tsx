import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

type HarnessStatus = "configured" | "attention" | "not-detected";

interface HarnessSummary {
  id: string;
  name: string;
  kind: string;
  status: HarnessStatus;
  installationPath?: string;
  configCount: number;
  integrationCount: number;
  message: string;
}

interface ConfigSource {
  path: string;
  format: string;
  exists: boolean;
  modifiedAt?: number;
}

interface McpServer {
  id: string;
  name: string;
  transport: string;
  command?: string;
  args: string[];
  url?: string;
  environmentKeys: string[];
  sourcePath: string;
}

interface Setting {
  label: string;
  value: string;
  sourcePath: string;
}

interface Diagnostic {
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
}

interface HarnessReport {
  summary: HarnessSummary;
  configSources: ConfigSource[];
  integrations: McpServer[];
  settings: Setting[];
  diagnostics: Diagnostic[];
  configPreview?: unknown;
}

interface ScanResult {
  harnesses: HarnessSummary[];
  scannedAt: number;
}

const statusCopy: Record<HarnessStatus, string> = {
  configured: "Configured",
  attention: "Needs attention",
  "not-detected": "Not configured",
};

function App() {
  const [harnesses, setHarnesses] = useState<HarnessSummary[]>([]);
  const [selectedId, setSelectedId] = useState("codex-cli");
  const [report, setReport] = useState<HarnessReport>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [lastScanned, setLastScanned] = useState<number>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await invoke<ScanResult>("scan_harnesses");
      setHarnesses(result.harnesses);
      setLastScanned(result.scannedAt);
      const nextId = result.harnesses.some((item) => item.id === selectedId)
        ? selectedId
        : result.harnesses[0]?.id;
      if (nextId) {
        setSelectedId(nextId);
        setReport(await invoke<HarnessReport>("inspect_harness", { id: nextId }));
        await invoke("watch_harness", { id: nextId });
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  const selectHarness = useCallback(async (id: string) => {
    setSelectedId(id);
    setError(undefined);
    try {
      setReport(await invoke<HarnessReport>("inspect_harness", { id }));
      await invoke("watch_harness", { id });
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const removeListener = listen<string>("harness:changed", (event) => {
      if (event.payload === selectedId) void refresh();
    });
    return () => {
      void removeListener.then((remove) => remove());
    };
  }, [refresh, selectedId]);

  const graphNodes = useMemo(() => {
    if (!report) return [];
    return [
      { label: report.summary.name, kind: "harness", x: 6, y: 46 },
      ...report.configSources.map((source, index) => ({
        label: source.path.split("/").pop() ?? "config.toml",
        kind: "config",
        x: 37,
        y: 22 + index * 45,
      })),
      ...report.integrations.map((server, index) => ({
        label: server.name,
        kind: "server",
        x: 70,
        y: 14 + index * 30,
      })),
    ];
  }, [report]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">OH</div>
          <div>
            <strong>Omni Harness</strong>
            <span>Local configuration atlas</span>
          </div>
        </div>

        <nav aria-label="Primary navigation">
          <a className="nav-item active" href="#inventory">
            <span>◈</span> Inventory
          </a>
          <a className="nav-item" href="#graph">
            <span>⌘</span> Connections
          </a>
          <a className="nav-item" href="#diagnostics">
            <span>△</span> Diagnostics
          </a>
        </nav>

        <div className="sidebar-section">
          <p className="section-label">Detected harnesses</p>
          <div className="harness-list">
            {harnesses.map((harness) => (
              <button
                className={`harness-button ${selectedId === harness.id ? "selected" : ""}`}
                key={harness.id}
                onClick={() => void selectHarness(harness.id)}
              >
                <span className={`status-dot ${harness.status}`} />
                <span>
                  <strong>{harness.name}</strong>
                  <small>{harness.message}</small>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="privacy-note">
          <span>◌</span>
          <p>
            <strong>Local and read-only</strong>Secrets are redacted before they reach this
            interface.
          </p>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">DEVELOPMENT ENVIRONMENT</p>
            <h1>Configuration inventory</h1>
          </div>
          <div className="scan-actions">
            <span className="last-scan">
              {lastScanned ? `Updated ${formatTime(lastScanned)}` : "Not scanned"}
            </span>
            <button className="button secondary" onClick={() => void refresh()} disabled={loading}>
              {loading ? "Scanning…" : "↻ Rescan"}
            </button>
          </div>
        </header>

        {error && <div className="error-banner">The desktop bridge returned an error: {error}</div>}

        <section id="inventory" className="overview-grid">
          <article className="hero-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">SELECTED HARNESS</p>
                <h2>{report?.summary.name ?? "Scanning local setup…"}</h2>
              </div>
              {report && (
                <span className={`status-pill ${report.summary.status}`}>
                  {statusCopy[report.summary.status]}
                </span>
              )}
            </div>
            <p className="hero-copy">
              {report?.summary.message ?? "Looking for known configuration sources."}
            </p>
            <div className="stats-row">
              <Stat value={report?.summary.configCount ?? 0} label="config sources" />
              <Stat value={report?.summary.integrationCount ?? 0} label="MCP servers" />
              <Stat
                value={report?.diagnostics.filter((item) => item.severity !== "info").length ?? 0}
                label="action items"
              />
            </div>
          </article>

          <article className="install-card">
            <p className="eyebrow">INSTALLATION</p>
            <div className="install-state">
              <span
                className={`status-dot ${report?.summary.installationPath ? "configured" : "not-detected"}`}
              />
              <strong>
                {report?.summary.installationPath ? "Found on PATH" : "Not found on PATH"}
              </strong>
            </div>
            <code>{report?.summary.installationPath ?? "The config can still be inspected."}</code>
          </article>
        </section>

        <section id="graph" className="panel relationship-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">RELATIONSHIP MAP</p>
              <h2>What is connected?</h2>
            </div>
            <div className="legend">
              <span className="legend-harness" /> Harness <span className="legend-config" /> Config{" "}
              <span className="legend-server" /> MCP server
            </div>
          </div>
          <div className="graph-canvas">
            {graphNodes.length === 0 && (
              <p className="empty-copy">Select a detected harness to see its configuration map.</p>
            )}
            {graphNodes.length > 0 && (
              <>
                <div className="edge edge-one" />
                {report?.integrations.map((server, index) => (
                  <div className={`edge edge-server edge-server-${index}`} key={server.id} />
                ))}
                {graphNodes.map((node) => (
                  <div
                    className={`graph-node ${node.kind}`}
                    key={`${node.kind}-${node.label}`}
                    style={{ left: `${node.x}%`, top: `${node.y}%` }}
                  >
                    <span>
                      {node.kind === "harness" ? "◇" : node.kind === "config" ? "▤" : "◌"}
                    </span>
                    <strong>{node.label}</strong>
                    <small>{node.kind === "server" ? "connected server" : node.kind}</small>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>

        <div className="detail-grid">
          <section className="panel">
            <div className="panel-heading compact">
              <div>
                <p className="eyebrow">CONFIGURATION</p>
                <h2>Sources & settings</h2>
              </div>
            </div>
            <div className="source-list">
              {report?.configSources.map((source) => (
                <div className="source-row" key={source.path}>
                  <span className="file-icon">▤</span>
                  <div>
                    <strong>{source.path.split("/").pop()}</strong>
                    <small>{source.path}</small>
                  </div>
                  <span className={source.exists ? "tag" : "tag muted"}>
                    {source.exists ? source.format : "missing"}
                  </span>
                </div>
              ))}
            </div>
            {report?.settings.length ? (
              <div className="settings-grid">
                {report.settings.map((setting) => (
                  <div className="setting" key={setting.sourcePath}>
                    <span>{setting.label}</span>
                    <strong>{setting.value}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-copy">No high-level settings found.</p>
            )}
          </section>

          <section className="panel">
            <div className="panel-heading compact">
              <div>
                <p className="eyebrow">INTEGRATIONS</p>
                <h2>MCP servers</h2>
              </div>
              <span className="count-badge">{report?.integrations.length ?? 0}</span>
            </div>
            {report?.integrations.length ? (
              <div className="server-list">
                {report.integrations.map((server) => (
                  <ServerCard server={server} key={server.id} />
                ))}
              </div>
            ) : (
              <p className="empty-copy">No MCP server entries were found in this config.</p>
            )}
          </section>
        </div>

        <section id="diagnostics" className="panel diagnostics-panel">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">DIAGNOSTICS</p>
              <h2>Safe inspection results</h2>
            </div>
          </div>
          {report?.diagnostics.length ? (
            report.diagnostics.map((diagnostic) => (
              <div className={`diagnostic ${diagnostic.severity}`} key={diagnostic.title}>
                <span>
                  {diagnostic.severity === "error"
                    ? "!"
                    : diagnostic.severity === "warning"
                      ? "△"
                      : "i"}
                </span>
                <div>
                  <strong>{diagnostic.title}</strong>
                  <p>{diagnostic.detail}</p>
                </div>
              </div>
            ))
          ) : (
            <div className="diagnostic success">
              <span>✓</span>
              <div>
                <strong>No issues detected</strong>
                <p>The configuration was read locally and no values were executed.</p>
              </div>
            </div>
          )}
        </section>

        {Boolean(report?.configPreview) && (
          <details className="config-preview">
            <summary>View sanitized config preview</summary>
            <pre>{JSON.stringify(report?.configPreview, null, 2)}</pre>
          </details>
        )}
      </section>
    </main>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function ServerCard({ server }: { server: McpServer }) {
  const destination = server.url ?? [server.command, ...server.args].filter(Boolean).join(" ");
  return (
    <article className="server-card">
      <div>
        <span className="server-icon">◌</span>
        <strong>{server.name}</strong>
        <small>
          {server.transport} · {server.sourcePath}
        </small>
      </div>
      <code>{destination || "No command or URL"}</code>
      {server.environmentKeys.length > 0 && (
        <p className="environment-note">
          Environment: {server.environmentKeys.join(", ")} <span>(values redacted)</span>
        </p>
      )}
    </article>
  );
}

function formatTime(unixSeconds: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(unixSeconds * 1000),
  );
}

export default App;
