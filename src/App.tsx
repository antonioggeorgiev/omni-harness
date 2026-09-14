import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  AppWindow,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash2,
  Code2,
  Command,
  FileText,
  FolderCog,
  Moon,
  Plus,
  Radar,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Sun,
  Terminal,
  Trash2,
} from "lucide-react";
import { Switch } from "./components/ui/switch";
import { getFamilyPresentation, getRuntimePresentation } from "./harness-registry";

type Screen = "configuration" | "home" | "detection" | "settings";
type Theme = "light" | "dark";
type HarnessStatus = "configured" | "installed" | "attention" | "not-detected";

interface DetectionEvidence {
  kind: "executable" | "application" | "extension" | "config" | string;
  label: string;
  path: string;
  found: boolean;
}

interface SurfaceSummary {
  id: string;
  name: string;
  kind: string;
  status: HarnessStatus;
  evidence: DetectionEvidence[];
}

interface ConfigurationStore {
  id: string;
  label: string;
  format: string;
  path: string;
  exists: boolean;
  sharedBy: string[];
}

interface HarnessRuntimeSummary {
  id: string;
  name: string;
  status: HarnessStatus;
  message: string;
  configStores: ConfigurationStore[];
  surfaces: SurfaceSummary[];
}

interface HarnessFamilySummary {
  id: string;
  name: string;
  status: HarnessStatus;
  message: string;
  runtimes: HarnessRuntimeSummary[];
}

interface ScanResult {
  families: HarnessFamilySummary[];
  scannedAt: number;
}

interface ConfigurationFilePreview {
  path: string;
  format: string;
  exists: boolean;
  content?: unknown;
  diagnostic?: string;
}

interface ConfigurationReport {
  id: string;
  familyName: string;
  name: string;
  status: HarnessStatus;
  message: string;
  configStores: ConfigurationStore[];
  surfaces: SurfaceSummary[];
  previews: ConfigurationFilePreview[];
}

interface ConfigurationTarget {
  id: string;
  familyId: string;
  runtimeId: string;
  familyName: string;
  name: string;
  description: string;
  status: HarnessStatus;
}

const statusPresentation: Record<
  HarnessStatus,
  { label: string; classes: string; icon: typeof CheckCircle2 }
> = {
  configured: {
    label: "Configured",
    classes: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    icon: CheckCircle2,
  },
  installed: {
    label: "Installed",
    classes: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
    icon: Terminal,
  },
  attention: {
    label: "Needs attention",
    classes: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    icon: AlertTriangle,
  },
  "not-detected": {
    label: "Not detected",
    classes: "bg-muted text-muted-foreground",
    icon: CircleSlash2,
  },
};

function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [scanResult, setScanResult] = useState<ScanResult>();
  const [scanError, setScanError] = useState<string>();
  const [selectedConfiguration, setSelectedConfiguration] = useState<string>();
  const [managedHarnessIds, setManagedHarnessIds] = useState<string[]>(() => {
    try {
      const storedHarnesses =
        localStorage.getItem("managed-harness-ids") ??
        localStorage.getItem("saved-configuration-ids") ??
        "[]";
      return JSON.parse(storedHarnesses) as string[];
    } catch {
      return [];
    }
  });
  const [theme, setTheme] = useState<Theme>(() => {
    const savedTheme = localStorage.getItem("theme");
    return savedTheme === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    void invoke<ScanResult>("scan_harnesses")
      .then((result) => {
        setScanResult(result);
        setScanError(undefined);
      })
      .catch((reason) => setScanError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const discoveredConfigurationTargets = useMemo(
    () => configurationTargetsFromScan(scanResult),
    [scanResult],
  );
  const savedConfigurationTargets = useMemo(
    () =>
      discoveredConfigurationTargets.filter((target) => managedHarnessIds.includes(target.id)),
    [discoveredConfigurationTargets, managedHarnessIds],
  );

  const addConfiguration = useCallback((target: ConfigurationTarget) => {
    setManagedHarnessIds((current) => {
      if (current.includes(target.id)) {
        return current;
      }
      const next = [...current, target.id];
      localStorage.setItem("managed-harness-ids", JSON.stringify(next));
      return next;
    });
  }, []);

  const removeConfiguration = useCallback((target: ConfigurationTarget) => {
    setManagedHarnessIds((current) => {
      const next = current.filter((id) => id !== target.id);
      localStorage.setItem("managed-harness-ids", JSON.stringify(next));
      return next;
    });
    setSelectedConfiguration((current) => (current === target.id ? undefined : current));
  }, []);

  const openConfiguration = useCallback((target: ConfigurationTarget) => {
    setSelectedConfiguration(target.id);
    setScreen("configuration");
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <aside className="flex h-full w-[248px] shrink-0 flex-col overflow-y-auto border-r bg-card px-3 py-4">
        <button
          aria-label="Go to overview"
          className="flex items-center gap-2.5 px-2 text-left"
          onClick={() => setScreen("home")}
        >
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Command className="size-[18px]" strokeWidth={2.4} />
          </span>
          <span className="text-[15px] font-semibold tracking-[-0.02em]">OmniHarness</span>
        </button>

        <nav className="mt-8" aria-label="Primary navigation">
          <p className="px-2 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Managed harnesses
          </p>
          <ConfigurationNavigation
            onOpen={openConfiguration}
            selectedId={screen === "configuration" ? selectedConfiguration : undefined}
            targets={savedConfigurationTargets}
          />

          <p className="mt-7 px-2 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Testing
          </p>
          <button
            aria-current={screen === "detection" ? "page" : undefined}
            className={`mt-2 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors ${
              screen === "detection"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            onClick={() => setScreen("detection")}
          >
            <Radar className="size-[17px]" />
            Detection Lab
          </button>
        </nav>

        <div className="mt-auto border-t pt-3">
          <button
            aria-current={screen === "settings" ? "page" : undefined}
            aria-label="Settings"
            className={`grid size-9 place-items-center rounded-md transition-colors ${
              screen === "settings"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            onClick={() => setScreen("settings")}
          >
            <Settings className="size-[17px]" />
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {screen === "home" && (
          <WelcomePage onOpen={openConfiguration} target={savedConfigurationTargets[0]} />
        )}
        {screen === "configuration" && (
          <ConfigurationPage
            scanError={scanError}
            selectedId={selectedConfiguration}
            targets={savedConfigurationTargets}
          />
        )}
        {screen === "detection" && (
          <DetectionLab
            onAddConfiguration={addConfiguration}
            onRemoveConfiguration={removeConfiguration}
            onScanResult={setScanResult}
            managedHarnessIds={managedHarnessIds}
            setScanError={setScanError}
          />
        )}
        {screen === "settings" && <SettingsPage theme={theme} setTheme={setTheme} />}
      </main>
    </div>
  );
}

function ConfigurationNavigation({
  onOpen,
  selectedId,
  targets,
}: {
  onOpen: (target: ConfigurationTarget) => void;
  selectedId?: string;
  targets: ConfigurationTarget[];
}) {
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  const targetsByProvider = Object.values(
    targets.reduce<
      Record<
        string,
        {
          presentation: ReturnType<typeof getFamilyPresentation>;
          targets: ConfigurationTarget[];
        }
      >
    >((groups, target) => {
      const presentation = getFamilyPresentation(target.familyId, target.familyName);
      const groupId = presentation.groupId ?? target.familyId;
      const group = groups[groupId];

      groups[groupId] = {
        presentation,
        targets: [...(group?.targets ?? []), target],
      };
      return groups;
    }, {}),
  );

  if (targets.length === 0) {
    return (
      <p className="mt-2 px-2 text-xs leading-5 text-muted-foreground">
        Scan in Detection Lab to discover configuration families.
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-1">
      {targetsByProvider.map(({ presentation, targets: providerTargets }) => {
        const groupId = presentation.groupId ?? providerTargets[0].familyId;
        const isOpen = expandedProviders[groupId] ?? true;

        return (
          <ConfigurationProviderGroup
            icon={presentation.icon}
            id={groupId}
            isOpen={isOpen}
            key={groupId}
            label={presentation.label}
            onOpen={onOpen}
            onToggle={() =>
              setExpandedProviders((current) => ({
                ...current,
                [groupId]: !(current[groupId] ?? true),
              }))
            }
            selectedId={selectedId}
            targets={providerTargets}
          />
        );
      })}
    </div>
  );
}

function ConfigurationProviderGroup({
  icon: Icon,
  id,
  isOpen,
  label,
  onOpen,
  onToggle,
  selectedId,
  targets,
}: {
  icon: ReturnType<typeof getFamilyPresentation>["icon"];
  id: string;
  isOpen: boolean;
  label: string;
  onOpen: (target: ConfigurationTarget) => void;
  onToggle: () => void;
  selectedId?: string;
  targets: ConfigurationTarget[];
}) {
  const contentId = `${id}-configuration-items`;

  return (
    <div className="pt-1">
      <button
        aria-controls={contentId}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={onToggle}
        type="button"
      >
        <Icon className="size-[17px] shrink-0" />
        <span className="min-w-0 flex-1">{label}</span>
        <ChevronDown
          className={`size-3.5 shrink-0 transition-transform ${isOpen ? "" : "-rotate-90"}`}
        />
      </button>

      {isOpen && (
        <div className="mt-1 ml-[19px] space-y-0.5 border-l border-border/80 pl-2" id={contentId}>
          {targets.map((target) => (
            <ConfigurationNavItem
              compact
              key={target.id}
              onOpen={onOpen}
              selected={selectedId === target.id}
              target={target}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigurationNavItem({
  compact = false,
  onOpen,
  selected,
  target,
}: {
  compact?: boolean;
  onOpen: (target: ConfigurationTarget) => void;
  selected: boolean;
  target: ConfigurationTarget;
}) {
  return (
    <button
      aria-current={selected ? "page" : undefined}
      className={`flex w-full items-center rounded-md py-2 text-left text-sm font-medium transition-colors ${
        compact ? "gap-2 px-2" : "gap-2.5 px-2.5"
      } ${
        selected
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
      onClick={() => onOpen(target)}
      type="button"
    >
      <span className="min-w-0 flex-1 truncate">{target.name}</span>
      <ChevronRight className="size-3.5 shrink-0 opacity-50" />
    </button>
  );
}

function WelcomePage({
  onOpen,
  target,
}: {
  onOpen: (target: ConfigurationTarget) => void;
  target?: ConfigurationTarget;
}) {
  return (
    <div className="mx-auto max-w-2xl px-8 py-12 sm:px-12">
      <span className="grid size-10 place-items-center rounded-lg bg-secondary text-secondary-foreground">
        <SlidersHorizontal className="size-5" />
      </span>
      <h1 className="mt-5 text-2xl font-semibold tracking-[-0.035em]">Harness configurations</h1>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
        Select a configuration in the sidebar to review its local files. Shared surfaces appear as
        one configuration, so a provider is never duplicated just because it has a CLI, desktop, or
        IDE entry point.
      </p>
      {target ? (
        <button
          className="mt-6 inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
          onClick={() => onOpen(target)}
          type="button"
        >
          Open {target.name}
          <ChevronRight className="size-4" />
        </button>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          Run Detection Lab to populate this list.
        </p>
      )}
    </div>
  );
}

function ConfigurationPage({
  scanError,
  selectedId,
  targets,
}: {
  scanError?: string;
  selectedId?: string;
  targets: ConfigurationTarget[];
}) {
  const target = targets.find((item) => item.id === selectedId) ?? targets[0];
  const [report, setReport] = useState<ConfigurationReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!target) {
      setReport(undefined);
      return;
    }

    const inspect = async () => {
      setLoading(true);
      setError(undefined);
      try {
        if (!("__TAURI_INTERNALS__" in window)) {
          throw new Error("Open OmniHarness as a desktop app to preview a local configuration.");
        }
        setReport(
          await invoke<ConfigurationReport>("inspect_configuration", {
            familyId: target.familyId,
            runtimeId: target.runtimeId,
          }),
        );
      } catch (reason) {
        setReport(undefined);
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoading(false);
      }
    };

    void inspect();
  }, [target]);

  if (!target) {
    return (
      <div className="mx-auto max-w-2xl px-8 py-12 sm:px-12">
        <h1 className="text-2xl font-semibold tracking-[-0.035em]">No saved configurations</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Use Detection Lab to add a detected harness to this sidebar. We’ll keep the CLI, desktop,
          and IDE surfaces together whenever they share one configuration.
        </p>
        {scanError && <p className="mt-5 text-sm text-muted-foreground">{scanError}</p>}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-8 sm:px-12">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-7">
        <div>
          <p className="text-sm text-muted-foreground">{target.familyName}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.035em]">{target.name}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {target.description}
          </p>
        </div>
        <StatusBadge presentation={statusPresentation[target.status]} />
      </header>

      {loading && <ConfigurationSkeleton />}

      {error && (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">The configuration could not be previewed</p>
            <p className="mt-1 opacity-80">{error}</p>
          </div>
        </div>
      )}

      {report && <ConfigurationPreview report={report} />}
    </div>
  );
}

function ConfigurationPreview({ report }: { report: ConfigurationReport }) {
  return (
    <div className="space-y-7 py-7">
      <section aria-labelledby="shared-by-heading">
        <h2 className="text-sm font-semibold" id="shared-by-heading">
          Shared by
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          These entry points use the same configuration entity.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {report.surfaces.map((surface) => (
            <SurfaceChip key={surface.id} surface={surface} />
          ))}
        </div>
      </section>

      <section aria-labelledby="configuration-files-heading">
        <h2 className="text-sm font-semibold" id="configuration-files-heading">
          Configuration preview
        </h2>
        <div className="mt-3 space-y-4">
          {report.previews.map((preview) => (
            <article className="overflow-hidden rounded-lg border bg-card" key={preview.path}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <code className="truncate text-xs text-muted-foreground">{preview.path}</code>
                </div>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                  {preview.format}
                </span>
              </div>
              {preview.content !== undefined ? (
                <pre className="max-h-[420px] overflow-auto p-4 text-xs leading-5 text-foreground">
                  <code>{JSON.stringify(preview.content, null, 2)}</code>
                </pre>
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  {preview.diagnostic ?? "No configuration file was found at this known location."}
                </p>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ConfigurationSkeleton() {
  return (
    <div className="mt-7 animate-pulse space-y-4" aria-label="Loading configuration preview">
      <div className="h-16 rounded-lg bg-muted" />
      <div className="h-56 rounded-lg bg-muted" />
    </div>
  );
}

function DetectionLab({
  onAddConfiguration,
  onRemoveConfiguration,
  onScanResult,
  managedHarnessIds,
  setScanError,
}: {
  onAddConfiguration: (target: ConfigurationTarget) => void;
  onRemoveConfiguration: (target: ConfigurationTarget) => void;
  onScanResult: (result: ScanResult) => void;
  managedHarnessIds: string[];
  setScanError: (error: string | undefined) => void;
}) {
  const [result, setResult] = useState<ScanResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const scan = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setScanError(undefined);

    try {
      if (!("__TAURI_INTERNALS__" in window)) {
        throw new Error("Open OmniHarness as a desktop app to scan this machine.");
      }
      const nextResult = await invoke<ScanResult>("scan_harnesses");
      setResult(nextResult);
      onScanResult(nextResult);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setScanError(message);
    } finally {
      setLoading(false);
    }
  }, [onScanResult, setScanError]);

  useEffect(() => {
    void scan();
  }, [scan]);

  const detected = useMemo(
    () => result?.families.filter((family) => family.status !== "not-detected") ?? [],
    [result],
  );
  const notDetected = useMemo(
    () => result?.families.filter((family) => family.status === "not-detected") ?? [],
    [result],
  );
  const configuredRuntimes = useMemo(
    () =>
      result?.families.flatMap((family) => family.runtimes).filter(isConfiguredRuntime).length ?? 0,
    [result],
  );
  const managedTargets = useMemo(
    () =>
      configurationTargetsFromScan(result).filter((target) => managedHarnessIds.includes(target.id)),
    [managedHarnessIds, result],
  );
  const availableDetectedFamilies = useMemo(
    () =>
      detected.filter((family) =>
        family.runtimes.some(
          (runtime) => !managedHarnessIds.includes(configurationTarget(family, runtime).id),
        ),
      ),
    [detected, managedHarnessIds],
  );

  return (
    <div className="mx-auto max-w-5xl px-8 py-8 sm:px-12">
      <header className="flex flex-wrap items-start justify-between gap-5 border-b pb-7">
        <div>
          <p className="text-sm text-muted-foreground">Testing</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.035em]">Harness detection</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            A read-only scan of 50 catalogued harness families. Surfaces are grouped under their
            runtime, so shared configuration is only represented once.
          </p>
        </div>
        <button
          className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={loading}
          onClick={() => void scan()}
          type="button"
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Scanning…" : "Scan again"}
        </button>
      </header>

      <div aria-live="polite">
        {error && (
          <div className="mt-6 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">The scan could not run</p>
              <p className="mt-1 opacity-80">{error}</p>
            </div>
          </div>
        )}

        {loading && !result && <DetectionSkeleton />}

        {result && (
          <>
            <section className="grid gap-3 py-6 sm:grid-cols-3" aria-label="Scan summary">
              <ScanStat label="Families found" value={detected.length} />
              <ScanStat label="Managed harnesses" value={managedTargets.length} />
              <ScanStat label="Configured runtimes" value={configuredRuntimes} />
            </section>

            <ManagedHarnesses
              onRemove={onRemoveConfiguration}
              targets={managedTargets}
            />

            <section className="mt-8" aria-labelledby="detected-heading">
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <h2 className="text-sm font-semibold" id="detected-heading">
                  Available on this machine
                </h2>
                <p className="text-xs text-muted-foreground">
                  Scanned {formatScanTime(result.scannedAt)}
                </p>
              </div>

              <p className="mb-3 text-sm text-muted-foreground">
                Detected harnesses that are not yet managed by OmniHarness.
              </p>

              {availableDetectedFamilies.length > 0 ? (
                <div className="overflow-hidden rounded-lg border bg-card">
                  {availableDetectedFamilies.map((family) => (
                    <FamilyRow
                      family={family}
                      key={family.id}
                      onAddConfiguration={onAddConfiguration}
                      managedHarnessIds={managedHarnessIds}
                      hideManaged
                    />
                  ))}
                </div>
              ) : (
                <EmptyResult />
              )}
            </section>

            {notDetected.length > 0 && (
              <section className="mt-8" aria-labelledby="not-detected-heading">
                <details>
                  <summary
                    className="cursor-pointer text-sm font-semibold"
                    id="not-detected-heading"
                  >
                    Not detected · {notDetected.length} catalog families
                  </summary>
                  <div className="mt-3 overflow-hidden rounded-lg border bg-card">
                    {notDetected.map((family) => (
                      <FamilyRow
                        canAdd={false}
                        family={family}
                        key={family.id}
                        onAddConfiguration={onAddConfiguration}
                        managedHarnessIds={managedHarnessIds}
                      />
                    ))}
                  </div>
                </details>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ManagedHarnesses({
  onRemove,
  targets,
}: {
  onRemove: (target: ConfigurationTarget) => void;
  targets: ConfigurationTarget[];
}) {
  return (
    <section aria-labelledby="managed-harnesses-heading">
      <div className="rounded-xl border border-emerald-500/45 bg-emerald-500/[0.045] p-4 sm:p-5 dark:bg-emerald-400/[0.07]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="grid size-6 place-items-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="size-4" />
              </span>
              <h2 className="text-sm font-semibold" id="managed-harnesses-heading">
                Managed harnesses
              </h2>
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Harnesses added here appear in the sidebar, ready for configuration and tracing in
              OmniHarness.
            </p>
          </div>
          <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:text-emerald-200">
            {targets.length} {targets.length === 1 ? "harness" : "harnesses"}
          </span>
        </div>

        {targets.length > 0 ? (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {targets.map((target) => {
              const presentation = getFamilyPresentation(target.familyId, target.familyName);
              const Icon = presentation.icon;

              return (
                <article
                  className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-card p-3.5 shadow-sm"
                  key={target.id}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                      <Icon className="size-[18px]" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-muted-foreground">{presentation.label}</p>
                      <h3 className="mt-0.5 truncate text-sm font-semibold">{target.name}</h3>
                    </div>
                  </div>
                  <button
                    aria-label={`Remove ${target.name} from OmniHarness`}
                    className="grid size-6 shrink-0 place-items-center rounded-md bg-red-800 text-white shadow-sm transition-colors hover:bg-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700/70 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                    onClick={() => onRemove(target)}
                    title={`Remove ${target.name}`}
                    type="button"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="mt-4 rounded-lg border border-dashed border-emerald-500/35 bg-card/50 px-4 py-3 text-sm text-muted-foreground">
            Add a detected harness below to manage its configuration in OmniHarness.
          </p>
        )}
      </div>
    </section>
  );
}

function FamilyRow({
  canAdd = true,
  family,
  hideManaged = false,
  onAddConfiguration,
  managedHarnessIds,
}: {
  canAdd?: boolean;
  family: HarnessFamilySummary;
  hideManaged?: boolean;
  onAddConfiguration: (target: ConfigurationTarget) => void;
  managedHarnessIds: string[];
}) {
  const status = statusPresentation[family.status];
  const presentation = getFamilyPresentation(family.id, family.name);
  const FamilyIcon = presentation.icon;
  const visibleRuntimes = hideManaged
    ? family.runtimes.filter(
        (runtime) => !managedHarnessIds.includes(configurationTarget(family, runtime).id),
      )
    : family.runtimes;

  if (visibleRuntimes.length === 0) {
    return null;
  }

  return (
    <article className="border-b p-4 last:border-b-0 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-secondary-foreground">
            <FamilyIcon className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{presentation.label}</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">{family.message}</p>
          </div>
        </div>
        <StatusBadge presentation={status} />
      </div>

      <div className="mt-4 space-y-3 pl-0 sm:pl-12">
        {visibleRuntimes.map((runtime) => (
          <RuntimeRow
            family={family}
            key={runtime.id}
            onAddConfiguration={onAddConfiguration}
            runtime={runtime}
            canAdd={canAdd}
            saved={managedHarnessIds.includes(configurationTarget(family, runtime).id)}
          />
        ))}
      </div>
    </article>
  );
}

function RuntimeRow({
  canAdd,
  family,
  onAddConfiguration,
  runtime,
  saved,
}: {
  canAdd: boolean;
  family: HarnessFamilySummary;
  onAddConfiguration: (target: ConfigurationTarget) => void;
  runtime: HarnessRuntimeSummary;
  saved: boolean;
}) {
  const presentation = statusPresentation[runtime.status];
  const runtimePresentation = getRuntimePresentation(family.id, runtime.id, runtime.name);

  return (
    <div className="rounded-md bg-secondary/50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{runtimePresentation.label}</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{runtime.message}</p>
        </div>
        <StatusBadge presentation={presentation} />
      </div>

      <div className="mt-3 flex flex-wrap gap-2" aria-label={`${runtime.name} surfaces`}>
        {runtime.surfaces.map((surface) => (
          <SurfaceChip surface={surface} key={surface.id} />
        ))}
      </div>

      {(runtime.configStores.length > 0 || runtime.surfaces.length > 0) && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
            Configuration stores and evidence
          </summary>
          <div className="mt-3 space-y-3">
            {runtime.configStores.map((store) => (
              <div className="flex min-w-0 items-start gap-2 text-xs" key={store.id}>
                <FolderCog className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className={store.exists ? "font-medium" : "text-muted-foreground"}>
                    {store.label} · {store.exists ? "found" : "not found"}
                  </p>
                  <code className="mt-0.5 block break-all text-muted-foreground">{store.path}</code>
                  <p className="mt-1 text-muted-foreground">
                    {store.format} · shared by {store.sharedBy.join(", ")}
                  </p>
                </div>
              </div>
            ))}
            {runtime.surfaces
              .flatMap((surface) => surface.evidence)
              .map((evidence) => (
                <EvidenceRow evidence={evidence} key={`${evidence.kind}-${evidence.path}`} />
              ))}
          </div>
        </details>
      )}

      {canAdd && (
        <div className="mt-4 flex justify-end">
          <button
            aria-label={`Add ${runtimePresentation.label} to OmniHarness`}
            className="group inline-flex h-6 items-center gap-1 rounded-full bg-primary py-0.5 pr-2 pl-0.5 text-[11px] font-semibold text-primary-foreground shadow-[0_1px_2px_oklch(0_0_0/0.16),inset_0_0_0_1px_oklch(1_0_0/0.14)] transition-[filter,transform,box-shadow] hover:brightness-110 hover:shadow-[0_2px_5px_oklch(0_0_0/0.2),inset_0_0_0_1px_oklch(1_0_0/0.18)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
            disabled={saved}
            onClick={() => onAddConfiguration(configurationTarget(family, runtime))}
            title={`Add ${runtimePresentation.label} to OmniHarness`}
            type="button"
          >
            <span className="grid size-4 place-items-center rounded-full bg-white/15 transition-colors group-hover:bg-white/20">
              <Plus className="size-2.5" strokeWidth={2.75} />
            </span>
            {saved ? "Managed in Omni Harness" : "Add to Omni Harness"}
          </button>
        </div>
      )}
    </div>
  );
}

function SurfaceChip({ surface }: { surface: SurfaceSummary }) {
  const presentation = statusPresentation[surface.status];
  const Icon = surface.kind === "CLI" ? Terminal : surface.kind === "Desktop" ? AppWindow : Code2;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${presentation.classes}`}
    >
      <Icon className="size-3.5" />
      {surface.name}
    </span>
  );
}

function EvidenceRow({ evidence }: { evidence: DetectionEvidence }) {
  const Icon = evidence.kind === "executable" ? Terminal : FileText;

  return (
    <div className="flex min-w-0 items-start gap-2 text-xs">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <span className={evidence.found ? "font-medium" : "text-muted-foreground"}>
          {evidence.label} · {evidence.found ? "found" : "not found"}
        </span>
        <code className="mt-0.5 block break-all text-muted-foreground">{evidence.path}</code>
      </div>
    </div>
  );
}

function StatusBadge({
  presentation,
}: {
  presentation: (typeof statusPresentation)[HarnessStatus];
}) {
  const StatusIcon = presentation.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${presentation.classes}`}
    >
      <StatusIcon className="size-3.5" />
      {presentation.label}
    </span>
  );
}

function EmptyResult() {
  return (
    <div className="rounded-lg border border-dashed px-5 py-10 text-center">
      <CircleSlash2 className="mx-auto size-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">No catalogued harnesses detected</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Expand the catalog section to see the bounded probes that were checked.
      </p>
    </div>
  );
}

function ScanStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-[-0.03em] tabular-nums">{value}</p>
    </div>
  );
}

function DetectionSkeleton() {
  return (
    <div className="animate-pulse py-6" aria-label="Scanning for harnesses">
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div className="h-[74px] rounded-lg bg-muted" key={item} />
        ))}
      </div>
      <div className="mt-6 h-40 rounded-lg bg-muted" />
    </div>
  );
}

function SettingsPage({ theme, setTheme }: { theme: Theme; setTheme: (theme: Theme) => void }) {
  const isDark = theme === "dark";

  return (
    <div className="mx-auto max-w-2xl px-8 py-8 sm:px-12">
      <header className="border-b pb-7">
        <p className="text-sm text-muted-foreground">Workspace</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.035em]">Settings</h1>
      </header>

      <section className="py-7" aria-labelledby="appearance-heading">
        <h2 className="text-sm font-semibold" id="appearance-heading">
          Appearance
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Customize how OmniHarness looks on this device.
        </p>
        <div className="mt-5 flex items-center justify-between rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md bg-secondary text-secondary-foreground">
              {isDark ? <Moon className="size-[18px]" /> : <Sun className="size-[18px]" />}
            </span>
            <div>
              <label className="text-sm font-medium" htmlFor="theme-switch">
                Dark theme
              </label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isDark ? "Dark mode is enabled" : "Use the light appearance"}
              </p>
            </div>
          </div>
          <Switch
            checked={isDark}
            id="theme-switch"
            onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
          />
        </div>
      </section>
    </div>
  );
}

function isConfiguredRuntime(runtime: HarnessRuntimeSummary) {
  return runtime.status === "configured" || runtime.status === "attention";
}

function configurationTargetsFromScan(result?: ScanResult) {
  return (
    result?.families.flatMap((family) =>
      family.runtimes.map((runtime) => configurationTarget(family, runtime)),
    ) ?? []
  );
}

function configurationTarget(
  family: HarnessFamilySummary,
  runtime: HarnessRuntimeSummary,
): ConfigurationTarget {
  const familyPresentation = getFamilyPresentation(family.id, family.name);
  const runtimePresentation = getRuntimePresentation(family.id, runtime.id, runtime.name);
  const surfaceNames = runtime.surfaces.map((surface) => surface.name).join(", ");

  return {
    id: `${family.id}:${runtime.id}`,
    familyId: family.id,
    runtimeId: runtime.id,
    familyName: familyPresentation.label,
    name: runtimePresentation.label,
    description: surfaceNames
      ? `${runtime.message} Shared across: ${surfaceNames}.`
      : runtime.message,
    status: runtime.status,
  };
}

function formatScanTime(unixSeconds: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

export default App;
