import {
  configurationTabs,
  type ConfigurationTabId,
  type Json,
  sourceReadOnly,
} from "./configuration-model";
import { ConfigurationExplorer, ConfigurationValidation } from "./configuration-explorer";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  FolderTree,
  Moon,
  Plus,
  Radar,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Sun,
  Terminal,
  Trash2,
  User,
  Shield,
  Eye,
  Pencil,
  X,
  ExternalLink,
  Clock,
} from "lucide-react";
import { Switch } from "./components/ui/switch";
import { getFamilyPresentation, getRuntimePresentation } from "./harness-registry";

type Screen = "configuration" | "home" | "detection" | "projects" | "settings";
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

interface ManagedProject {
  id: string;
  name: string;
  path: string;
  workspaceRoot?: string;
}

interface ContextArtifact {
  id: string;
  provider: string;
  kind: "instruction" | "skill" | "rule" | "command";
  scope: string;
  state: "active" | "conditional" | "shadowed";
  activation: string;
  path: string;
  external: boolean;
  createdAt?: number | null;
  modifiedAt?: number | null;
}

interface ProjectContextReport {
  root: string;
  workspaceRoot: string;
  scannedAt: number;
  artifacts: ContextArtifact[];
}

interface ConfigurationFilePreview {
  id: string;
  path: string;
  format: string;
  exists: boolean;
  revision?: string;
  content?: unknown;
  diagnostic?: string;
  schemaId?: string;
  schemaIssues?: { path: string; rule: string }[];
}

interface McpServerSummary {
  id: string;
  sourceId: string;
  name: string;
  transport: string;
  endpoint: string;
  enabled: boolean;
  enabledPath?: string[];
  usesDisabledFlag: boolean;
}

const lastOpenedConfigurationKey = "last-opened-configuration-id";
const configurationTabsByTargetKey = "configuration-tabs-by-target";
const managedProjectsKey = "managed-projects";
const lastOpenedScreenKey = "last-opened-screen";
const lastOpenedProjectKey = "last-opened-project-id";

function storedLastOpenedScreen(): Screen {
  const stored = localStorage.getItem(lastOpenedScreenKey);
  switch (stored) {
    case "configuration":
    case "home":
    case "detection":
    case "projects":
    case "settings":
      return stored;
    default:
      // Preserve the previous harness-only restoration for existing installations.
      return storedLastOpenedConfiguration() ? "configuration" : "home";
  }
}

function storedLastOpenedConfiguration() {
  return localStorage.getItem(lastOpenedConfigurationKey) ?? undefined;
}

function storedConfigurationTabsByTarget(): Partial<Record<string, ConfigurationTabId>> {
  try {
    const stored = JSON.parse(localStorage.getItem(configurationTabsByTargetKey) ?? "{}");
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, ConfigurationTabId] =>
          typeof entry[1] === "string" && configurationTabs.some((tab) => tab.id === entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function storedConfigurationTab(targetId?: string): ConfigurationTabId {
  if (!targetId) {
    return "general";
  }

  return storedConfigurationTabsByTarget()[targetId] ?? "general";
}

function storeConfigurationTab(targetId: string, tab: ConfigurationTabId) {
  const tabsByTarget = storedConfigurationTabsByTarget();
  tabsByTarget[targetId] = tab;
  localStorage.setItem(configurationTabsByTargetKey, JSON.stringify(tabsByTarget));
}

function removeStoredConfiguration(targetId: string) {
  if (storedLastOpenedConfiguration() === targetId) {
    localStorage.removeItem(lastOpenedConfigurationKey);
  }

  const tabsByTarget = storedConfigurationTabsByTarget();
  if (targetId in tabsByTarget) {
    delete tabsByTarget[targetId];
    localStorage.setItem(configurationTabsByTargetKey, JSON.stringify(tabsByTarget));
  }
}

function storedProjects(): ManagedProject[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(managedProjectsKey) ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (project): project is ManagedProject =>
        typeof project === "object" &&
        project !== null &&
        typeof project.id === "string" &&
        typeof project.name === "string" &&
        typeof project.path === "string",
    );
  } catch {
    return [];
  }
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
  const [screen, setScreen] = useState<Screen>(storedLastOpenedScreen);
  const [scanResult, setScanResult] = useState<ScanResult>();
  const [scanError, setScanError] = useState<string>();
  const [selectedConfiguration, setSelectedConfiguration] = useState<string | undefined>(
    storedLastOpenedConfiguration,
  );
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
  const [managedHarnessesOpen, setManagedHarnessesOpen] = useState(
    () => localStorage.getItem("managed-harnesses-open") !== "false",
  );
  const [projects, setProjects] = useState<ManagedProject[]>(storedProjects);
  const [projectsOpen, setProjectsOpen] = useState(
    () => localStorage.getItem("projects-open") !== "false",
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(() => {
    const storedId = localStorage.getItem(lastOpenedProjectKey);
    return projects.find((project) => project.id === storedId)?.id ?? projects[0]?.id;
  });
  const [projectImportRequest, setProjectImportRequest] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => {
    const savedTheme = localStorage.getItem("theme");
    return savedTheme === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    localStorage.setItem(lastOpenedScreenKey, screen);
  }, [screen]);

  useEffect(() => {
    if (selectedProjectId) {
      localStorage.setItem(lastOpenedProjectKey, selectedProjectId);
    } else {
      localStorage.removeItem(lastOpenedProjectKey);
    }
  }, [selectedProjectId]);

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
    () => discoveredConfigurationTargets.filter((target) => managedHarnessIds.includes(target.id)),
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
    removeStoredConfiguration(target.id);
    setSelectedConfiguration((current) => (current === target.id ? undefined : current));
  }, []);

  const openConfiguration = useCallback((target: ConfigurationTarget) => {
    localStorage.setItem(lastOpenedConfigurationKey, target.id);
    setSelectedConfiguration(target.id);
    setScreen("configuration");
  }, []);

  const updateProjects = useCallback((next: ManagedProject[]) => {
    setProjects(next);
    localStorage.setItem(managedProjectsKey, JSON.stringify(next));
  }, []);

  const openProject = useCallback((project: ManagedProject) => {
    setSelectedProjectId(project.id);
    setScreen("projects");
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <aside className="sidebar flex h-full w-[264px] shrink-0 flex-col border-r bg-card px-3 py-4">
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

        <nav className="mt-7 min-h-0 flex-1 overflow-y-auto pb-5" aria-label="Primary navigation">
          <button
            aria-controls="managed-harnesses-navigation"
            aria-expanded={managedHarnessesOpen}
            className="sidebar-section-heading flex w-full items-center gap-2 px-2 text-left"
            onClick={() => {
              setManagedHarnessesOpen((current) => {
                const next = !current;
                localStorage.setItem("managed-harnesses-open", String(next));
                return next;
              });
            }}
            type="button"
          >
            <ChevronDown
              className={`size-3.5 transition-transform ${managedHarnessesOpen ? "" : "-rotate-90"}`}
            />
            <span className="flex-1">Harnesses</span>
            {savedConfigurationTargets.length > 0 && (
              <span className="sidebar-count">{savedConfigurationTargets.length}</span>
            )}
          </button>
          {managedHarnessesOpen && (
            <div id="managed-harnesses-navigation">
              <ConfigurationNavigation
                onOpen={openConfiguration}
                selectedId={screen === "configuration" ? selectedConfiguration : undefined}
                targets={savedConfigurationTargets}
              />
            </div>
          )}

          <div className="mt-6 border-t pt-5">
            <div className="flex items-center gap-1 px-2">
              <button
                aria-controls="projects-navigation"
                aria-expanded={projectsOpen}
                className="sidebar-section-heading flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => {
                  setProjectsOpen((current) => {
                    const next = !current;
                    localStorage.setItem("projects-open", String(next));
                    return next;
                  });
                }}
                type="button"
              >
                <ChevronDown
                  className={`size-3.5 shrink-0 transition-transform ${projectsOpen ? "" : "-rotate-90"}`}
                />
                <span className="min-w-0 flex-1">Projects</span>
                {projects.length > 0 && <span className="sidebar-count">{projects.length}</span>}
              </button>
              <button
                aria-label="Import project folder"
                className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => {
                  setScreen("projects");
                  setProjectImportRequest((current) => current + 1);
                }}
                title="Import project folder"
                type="button"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            {projectsOpen && (
              <div className="mt-2 space-y-0.5" id="projects-navigation">
                {projects.length > 0 ? (
                  projects.map((project) => (
                    <button
                      aria-current={
                        screen === "projects" && selectedProjectId === project.id
                          ? "page"
                          : undefined
                      }
                      className={`sidebar-project flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] font-normal transition-colors ${
                        screen === "projects" && selectedProjectId === project.id
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                      key={project.id}
                      onClick={() => openProject(project)}
                      title={project.path}
                      type="button"
                    >
                      <FolderTree className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    </button>
                  ))
                ) : (
                  <p className="px-2 text-xs leading-5 text-muted-foreground">
                    No projects imported.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="mt-6 border-t pt-3">
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
          </div>
        </nav>

        <div className="shrink-0 border-t pt-3">
          <button
            aria-current={screen === "settings" ? "page" : undefined}
            aria-label="Settings"
            className={`flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors ${
              screen === "settings"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            onClick={() => setScreen("settings")}
          >
            <Settings className="size-[17px]" />
            Settings
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
        {screen === "projects" && (
          <ProjectsPage
            importRequest={projectImportRequest}
            onSelectProject={setSelectedProjectId}
            projects={projects}
            selectedId={selectedProjectId}
            setProjects={updateProjects}
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
    <div className="mt-2 space-y-2">
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
        className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted"
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
        <div className="mt-0.5 ml-[18px] space-y-0.5 border-l border-border pl-3" id={contentId}>
          {targets.map((target) => (
            <ConfigurationNavItem
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
  onOpen,
  selected,
  target,
}: {
  onOpen: (target: ConfigurationTarget) => void;
  selected: boolean;
  target: ConfigurationTarget;
}) {
  return (
    <button
      aria-current={selected ? "page" : undefined}
      className={`sidebar-child flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors ${
        selected
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
      onClick={() => onOpen(target)}
      type="button"
    >
      <span className="min-w-0 flex-1 truncate">{target.name}</span>
    </button>
  );
}

function ProjectsPage({
  importRequest,
  onSelectProject,
  projects,
  selectedId,
  setProjects,
}: {
  importRequest: number;
  onSelectProject: (id?: string) => void;
  projects: ManagedProject[];
  selectedId?: string;
  setProjects: (projects: ManagedProject[]) => void;
}) {
  const [report, setReport] = useState<ProjectContextReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const selectedProject = projects.find((project) => project.id === selectedId) ?? projects[0];

  const scanProject = useCallback(
    async (project: ManagedProject) => {
      if (!("__TAURI_INTERNALS__" in window)) {
        setError("Open OmniHarness as a desktop app to inspect a local project.");
        return;
      }
      setLoading(true);
      setError(undefined);
      try {
        const next = await invoke<ProjectContextReport>("scan_project_context", {
          projectPath: project.path,
        });
        setReport(next);
        const current = projects.find((item) => item.id === project.id);
        if (
          current &&
          (current.path !== next.root || current.workspaceRoot !== next.workspaceRoot)
        ) {
          setProjects(
            projects.map((item) =>
              item.id === project.id
                ? { ...item, path: next.root, workspaceRoot: next.workspaceRoot }
                : item,
            ),
          );
        }
      } catch (reason) {
        setReport(undefined);
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoading(false);
      }
    },
    [projects, setProjects],
  );

  useEffect(() => {
    if (selectedProject) {
      void scanProject(selectedProject);
    } else {
      setReport(undefined);
    }
  }, [selectedProject?.id, scanProject]);

  const importProject = useCallback(async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      setError("Folder import is available in the OmniHarness desktop app.");
      return;
    }
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Import project folder",
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) {
        return;
      }
      setLoading(true);
      setError(undefined);
      const next = await invoke<ProjectContextReport>("scan_project_context", {
        projectPath: path,
      });
      const existing = projects.find((project) => project.path === next.root);
      const project =
        existing ??
        ({
          id: next.root,
          name: next.root.split(/[\\/]/).filter(Boolean).pop() ?? "Imported project",
          path: next.root,
          workspaceRoot: next.workspaceRoot,
        } satisfies ManagedProject);
      if (!existing) {
        setProjects([...projects, project]);
      }
      onSelectProject(project.id);
      setReport(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [onSelectProject, projects, setProjects]);

  useEffect(() => {
    if (importRequest > 0) {
      void importProject();
    }
  }, [importProject, importRequest]);

  const removeProject = useCallback(
    (project: ManagedProject) => {
      const next = projects.filter((item) => item.id !== project.id);
      setProjects(next);
      onSelectProject(next[0]?.id);
      setReport(undefined);
    },
    [onSelectProject, projects, setProjects],
  );

  return (
    <div className="mx-auto max-w-6xl px-8 py-8 sm:px-12">
      {projects.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <FolderCog className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-4 font-semibold">Import a folder to map its agent context</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            OmniHarness will inventory project files and the applicable user and system context
            without modifying them.
          </p>
        </div>
      ) : (
        <section className="min-w-0">
          {selectedProject && (
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground">
                  <FolderTree className="size-5" />
                </span>
                <h1 className="truncate text-2xl font-semibold tracking-[-0.035em]">
                  {selectedProject.name}
                </h1>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="inline-flex min-h-9 items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
                  disabled={loading}
                  onClick={() => void scanProject(selectedProject)}
                  type="button"
                >
                  <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
                  Rescan
                </button>
                <button
                  aria-label={`Remove ${selectedProject.name}`}
                  className="grid size-9 place-items-center rounded-md border border-red-500/30 text-red-500 hover:bg-red-500/10"
                  onClick={() => removeProject(selectedProject)}
                  title="Remove imported project"
                  type="button"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}
          {loading && !report && <ConfigurationSkeleton />}
          {report && (
            <ProjectContextInventory
              report={report}
              onRefresh={() => selectedProject && void scanProject(selectedProject)}
            />
          )}
        </section>
      )}
    </div>
  );
}

function ProjectContextInventory({
  report,
  onRefresh,
}: {
  report: ProjectContextReport;
  onRefresh: () => void;
}) {
  const [documentItem, setDocumentItem] = useState<ContextArtifact>();
  const scopeName = (item: ContextArtifact) => (item.scope === "Nested" ? "Project" : item.scope);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [expandedScopes, setExpandedScopes] = useState<Record<string, boolean>>({});
  const providers = [...new Set(report.artifacts.map((item) => item.provider))];
  const provider = providers.includes(selectedProvider) ? selectedProvider : providers[0];
  const providerArtifacts = report.artifacts.filter((item) => item.provider === provider);
  const visible = providerArtifacts.filter(
    (item) =>
      (kind === "all" || item.kind === kind) &&
      (status === "all" ||
        (status === "conditional" ? item.state === "conditional" : item.state !== "conditional")) &&
      `${contextItemName(item)} ${item.path} ${item.scope}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const scopes = [...new Set(visible.map(scopeName))];
  const providerFamilies: Record<string, string> = {
    Codex: "codex",
    "Claude Code": "claude",
    "Gemini CLI": "gemini-cli",
  };

  return (
    <div className="space-y-6">
      <div aria-label="Context providers" className="flex flex-wrap gap-2 border-b pb-5">
        {providers.map((name) => {
          const Icon = getFamilyPresentation(providerFamilies[name] ?? name, name).icon;
          const count = report.artifacts.filter((item) => item.provider === name).length;
          return (
            <button
              aria-pressed={provider === name}
              className={`inline-flex items-center gap-2.5 rounded-lg px-4 py-3 text-sm font-medium transition-colors ${provider === name ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
              key={name}
              onClick={() => setSelectedProvider(name)}
              type="button"
            >
              <Icon className="size-5" />
              {name}
              <span className="ml-1 text-xs tabular-nums opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div aria-label="Context type" className="flex flex-wrap gap-1">
          {[
            ["all", "All"],
            ["skill", "Skills"],
            ["instruction", "Instructions"],
            ["rule", "Rules"],
            ["command", "Commands"],
          ].map(([value, label]) => (
            <button
              aria-pressed={kind === value}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${kind === value ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              key={value}
              onClick={() => setKind(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <ContextStatusFilter value={status} onChange={setStatus} />
          <input
            aria-label="Search context"
            className="h-9 w-full rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring sm:w-60"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or path…"
            type="search"
            value={query}
          />
        </div>
      </div>

      {visible.length === 0 && (
        <p className="rounded-lg border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
          {report.artifacts.length === 0 ? "No context files found." : "No matching context files."}
        </p>
      )}

      {documentItem && (
        <ContextEditor
          key={documentItem.id}
          item={documentItem}
          root={report.root}
          onClose={() => setDocumentItem(undefined)}
          onRefresh={onRefresh}
        />
      )}
      {scopes.map((scope) => {
        const entries = visible.filter((item) => scopeName(item) === scope);
        const ScopeIcon =
          scope === "User" ? User : scope === "Project" || scope === "Local" ? FolderTree : Shield;
        return (
          <details className="group/scope" key={`${provider}:${scope}`} open>
            <summary className="flex items-center gap-2 py-2 text-sm font-medium text-muted-foreground list-none [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform group-open/scope:rotate-90" />
              <ScopeIcon className="size-4" />
              <span
                title={
                  scope === "User"
                    ? "Your personal context, shared across all projects."
                    : undefined
                }
              >
                {scope === "User" ? "Global · User" : scope}
              </span>
              <span className="text-xs tabular-nums opacity-60">{entries.length}</span>
            </summary>
            <div className="mt-2 overflow-hidden rounded-xl border bg-card">
              {(expandedScopes[provider + scope] ? entries : entries.slice(0, 5)).map((item) => (
                <div
                  className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
                  key={item.id}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">
                    {item.kind === "skill" ? (
                      <Code2 className="size-4" />
                    ) : (
                      <FileText className="size-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{contextItemName(item)}</span>
                      <span className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-2 py-0.5 text-xs capitalize text-blue-600 dark:text-blue-300">
                        <FileText className="size-3" />
                        {item.kind}
                      </span>
                      <span
                        title={item.activation}
                        className="inline-flex items-center gap-1 rounded bg-violet-500/10 px-2 py-0.5 text-xs text-violet-600 dark:text-violet-300"
                      >
                        <Clock className="size-3" />
                        {item.state === "shadowed"
                          ? "Shadowed"
                          : item.state === "conditional"
                            ? "On demand"
                            : item.kind === "skill" || item.kind === "command"
                              ? "Available"
                              : "At launch"}
                      </span>
                      {item.scope === "Nested" && (
                        <span className="text-xs text-muted-foreground">Subfolder</span>
                      )}
                      {item.external && (
                        <span className="text-xs text-muted-foreground">Outside project</span>
                      )}
                    </div>
                    <p
                      className="mt-1 truncate font-mono text-xs text-muted-foreground"
                      title={item.path}
                    >
                      {item.path.startsWith(report.root + "/")
                        ? item.path.slice(report.root.length + 1)
                        : item.path}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <ContextFileDate label="Created" timestamp={item.createdAt} />
                      <ContextFileDate label="Modified" timestamp={item.modifiedAt} />
                    </div>
                  </div>
                  <button
                    aria-label={`Preview and edit ${item.path}`}
                    title="Preview and edit"
                    onClick={() => setDocumentItem(item)}
                    className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                    type="button"
                  >
                    <Eye className="size-4" />
                  </button>
                </div>
              ))}
              {entries.length > 5 && (
                <button
                  type="button"
                  className="w-full border-t py-3 text-sm font-medium text-primary hover:bg-muted"
                  onClick={() =>
                    setExpandedScopes((current) => ({
                      ...current,
                      [provider + scope]: !current[provider + scope],
                    }))
                  }
                >
                  {expandedScopes[provider + scope] ? "Show less" : `Show all ${entries.length}`}
                </button>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function ContextStatusFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = [
    { value: "all", label: "All statuses" },
    { value: "conditional", label: "On demand" },
    { value: "other", label: "Not on demand" },
  ];
  useEffect(() => {
    if (!isOpen) return;
    const close = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [isOpen]);
  return (
    <div
      ref={container}
      className="relative shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setIsOpen(false);
          trigger.current?.focus();
        }
        if (isOpen && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const items = Array.from(
            container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
          );
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="Filter by activation"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-9 items-center gap-2 rounded-md border bg-card px-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Clock className="size-3.5 text-muted-foreground" />
        {options.find((option) => option.value === value)?.label}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>
      {isOpen && (
        <div
          role="menu"
          aria-label="Activation status"
          className="absolute right-0 top-full z-20 mt-2 w-48 rounded-lg border bg-card p-1 shadow-lg"
        >
          {options.map((option) => (
            <button
              autoFocus={option.value === value}
              key={option.value}
              role="menuitemradio"
              aria-checked={option.value === value}
              type="button"
              className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-muted focus:bg-muted ${option.value === value ? "bg-accent text-accent-foreground" : "text-foreground"}`}
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
                trigger.current?.focus();
              }}
            >
              {option.label}
              {option.value === value && <CheckCircle2 className="size-3.5" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ContextEditor({
  item,
  root,
  onClose,
  onRefresh,
}: {
  item: ContextArtifact;
  root: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [revision, setRevision] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      previousFocus?.focus();
    };
  }, [onClose]);
  useEffect(() => {
    let cancelled = false;
    invoke<{ content: string; revision: string }>("read_context_file", {
      projectPath: root,
      id: item.id,
    })
      .then((result) => {
        if (!cancelled) {
          setContent(result.content);
          setOriginalContent(result.content);
          setRevision(result.revision);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, item.id]);
  const mutate = async (remove: boolean) => {
    setBusy(true);
    setError("");
    try {
      await invoke(remove ? "delete_context_file" : "save_context_file", {
        projectPath: root,
        id: item.id,
        expectedRevision: revision,
        content,
      });
      onRefresh();
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Context file editor"
        className="flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border bg-card shadow-xl"
      >
        <header className="flex shrink-0 items-center gap-3 border-b p-4">
          <FileText className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">{contextItemName(item)}</h2>
            <p className="truncate text-xs text-muted-foreground" title={item.path}>
              {item.path}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close editor"
            autoFocus
            onClick={onClose}
            className="rounded p-2 hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        </header>
        {error && (
          <p role="alert" className="px-4 py-3 text-sm text-red-500">
            {error}
          </p>
        )}
        {editing ? (
          <textarea
            aria-label="File content"
            className="min-h-0 flex-1 resize-none overflow-auto bg-background p-5 font-mono text-sm leading-6 outline-none"
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-5 text-sm leading-6">
            {busy ? "Loading…" : content || "Empty file"}
          </pre>
        )}
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t p-4">
          <div className="flex items-center gap-2">
            <button
              disabled={busy || !revision}
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500 hover:bg-red-500/20 disabled:opacity-50"
            >
              <Trash2 className="size-4" />
              Delete
            </button>
            {confirmDelete && (
              <>
                <span className="text-xs text-muted-foreground">
                  Delete this file? A backup is kept beside it.
                </span>
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => void mutate(true)}
                  className="rounded bg-red-600 px-3 py-2 text-sm text-white"
                >
                  Confirm delete
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="text-sm">
                  Cancel
                </button>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
              onClick={() => {
                void invoke("open_context_file", { projectPath: root, id: item.id }).catch(
                  (reason) => setError(String(reason)),
                );
              }}
            >
              <ExternalLink className="size-4" />
              Open in text editor
            </button>
            {editing && (
              <button
                type="button"
                disabled={busy}
                className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
                onClick={() => {
                  setContent(originalContent);
                  setEditing(false);
                }}
              >
                Discard changes
              </button>
            )}
            <button
              disabled={busy || !revision}
              type="button"
              onClick={() => (editing ? void mutate(false) : setEditing(true))}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              <Pencil className="size-4" />
              {editing ? "Save changes" : "Edit"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function ContextFileDate({ label, timestamp }: { label: string; timestamp?: number | null }) {
  const date = timestamp == null ? undefined : new Date(timestamp * 1000);
  return (
    <span>
      {label}{" "}
      {date && !Number.isNaN(date.getTime()) ? (
        <time dateTime={date.toISOString()} title={date.toLocaleString()}>
          {date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
        </time>
      ) : (
        <span title="This timestamp is unavailable from the filesystem">Unavailable</span>
      )}
    </span>
  );
}

function contextItemName(item: ContextArtifact) {
  const segments = item.path.split(/[\\/]/).filter(Boolean);
  if (item.kind === "skill") return segments[segments.length - 2] ?? "Skill";
  return segments[segments.length - 1] ?? item.path;
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
  const [writeError, setWriteError] = useState<string>();
  const [savingId, setSavingId] = useState<string>();
  const [activeTab, setActiveTab] = useState<ConfigurationTabId>(() =>
    storedConfigurationTab(target?.id),
  );

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

  useEffect(() => {
    setActiveTab(storedConfigurationTab(target?.id));
    setWriteError(undefined);
  }, [target?.id]);

  const selectTab = useCallback(
    (tab: ConfigurationTabId) => {
      if (target) {
        storeConfigurationTab(target.id, tab);
      }
      setActiveTab(tab);
    },
    [target],
  );

  const saveCodexChange = useCallback(
    async (
      id: string,
      command: "update_codex_general_setting" | "update_codex_feature" | "update_codex_mcp_enabled",
      payload: Record<string, string | boolean>,
    ) => {
      const revision = configurationRevision(report);
      if (!revision) {
        setWriteError("This configuration has no revision. Reload it before making changes.");
        return false;
      }

      setSavingId(id);
      setWriteError(undefined);
      try {
        setReport(
          await invoke<ConfigurationReport>(command, {
            ...payload,
            expectedRevision: revision,
          }),
        );
        return true;
      } catch (reason) {
        setWriteError(reason instanceof Error ? reason.message : String(reason));
        return false;
      } finally {
        setSavingId(undefined);
      }
    },
    [report],
  );

  const saveStructuredChange = useCallback(
    async (id: string, storeId: string, path: string[], value: Json) => {
      const preview = report?.previews.find((item) => item.id === storeId);
      if (!preview?.revision) {
        setWriteError("This configuration has no revision. Reload it before making changes.");
        return false;
      }

      setSavingId(id);
      setWriteError(undefined);
      try {
        setReport(
          await invoke<ConfigurationReport>("update_configuration_value", {
            familyId: target?.familyId,
            runtimeId: target?.runtimeId,
            storeId,
            path,
            settingValue: value,
            expectedRevision: preview.revision,
          }),
        );
        return true;
      } catch (reason) {
        setWriteError(reason instanceof Error ? reason.message : String(reason));
        return false;
      } finally {
        setSavingId(undefined);
      }
    },
    [report, target?.familyId, target?.runtimeId],
  );

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
      <header className="pb-7">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.035em]">{target.name}</h1>
          {report && (
            <div
              className="mt-3 flex flex-wrap gap-2"
              aria-label={`${target.name} supported surfaces`}
            >
              {report.surfaces.map((surface) => (
                <SurfaceChip key={surface.id} surface={surface} />
              ))}
            </div>
          )}
        </div>
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

      {writeError && (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">The configuration could not be saved</p>
            <p className="mt-1 opacity-80">{writeError}</p>
          </div>
        </div>
      )}

      {report && (
        <ConfigurationDetails
          activeTab={activeTab}
          canEditCodex={report.id === "codex:codex-local"}
          onTabChange={selectTab}
          onUpdateMcp={(server, enabled) =>
            saveCodexChange(`mcp:${server}`, "update_codex_mcp_enabled", { server, enabled })
          }
          onUpdateStructured={saveStructuredChange}
          report={report}
          savingId={savingId}
        />
      )}
    </div>
  );
}

function ConfigurationDetails({
  activeTab,
  canEditCodex,
  onTabChange,
  onUpdateMcp,
  onUpdateStructured,
  report,
  savingId,
}: {
  activeTab: ConfigurationTabId;
  canEditCodex: boolean;
  onTabChange: (tab: ConfigurationTabId) => void;
  onUpdateMcp: (server: string, enabled: boolean) => Promise<boolean>;
  onUpdateStructured: (
    id: string,
    storeId: string,
    path: string[],
    value: Json,
  ) => Promise<boolean>;
  report: ConfigurationReport;
  savingId?: string;
}) {
  const mcpServers = useMemo(() => mcpServersFromPreviews(report.previews), [report.previews]);
  const updateMcp = (server: McpServerSummary, enabled: boolean) =>
    canEditCodex
      ? onUpdateMcp(server.name, enabled)
      : server.enabledPath
        ? onUpdateStructured(
            `mcp:${server.sourceId}:${server.name}`,
            server.sourceId,
            server.enabledPath,
            server.usesDisabledFlag ? !enabled : enabled,
          )
        : Promise.resolve(false);

  return (
    <div className="py-7">
      <div className="overflow-x-auto border-b">
        <div aria-label="Configuration details" className="flex min-w-max gap-5" role="tablist">
          {configurationTabs.map((tab) => (
            <ConfigurationTab
              active={activeTab === tab.id}
              id={tab.id}
              key={tab.id}
              label={tab.label}
              onSelect={onTabChange}
            />
          ))}
        </div>
      </div>

      {report.previews.length === 0 && (
        <p className="mt-4 rounded-lg border p-4 text-sm text-muted-foreground">
          Installation detection only. Configuration support for this tool has not been verified
          yet.
        </p>
      )}
      <ConfigurationValidation previews={report.previews} />
      {activeTab === "raw-config" && <RawConfigurationPreview previews={report.previews} />}
      {activeTab === "mcp-servers" && (
        <McpServers
          canEditCodex={canEditCodex}
          onUpdateEnabled={updateMcp}
          savingId={savingId}
          servers={mcpServers}
        />
      )}
      {activeTab === "plugins" && <PluginSettings previews={report.previews} />}
      {activeTab !== "raw-config" && (
        <ConfigurationExplorer
          key={report.id}
          previews={report.previews}
          tab={activeTab}
          family={report.id.split(":")[0] === "gemini-cli" ? "gemini" : report.id.split(":")[0]}
          saving={savingId !== undefined}
          onUpdate={onUpdateStructured}
        />
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        Edits are revision-checked, saved atomically and backed up. JSONC and YAML saves normalize
        formatting.
      </p>
    </div>
  );
}

function ConfigurationTab({
  active,
  id,
  label,
  onSelect,
}: {
  active: boolean;
  id: ConfigurationTabId;
  label: string;
  onSelect: (tab: ConfigurationTabId) => void;
}) {
  return (
    <button
      aria-controls={`${id}-panel`}
      aria-selected={active}
      className={`border-b-2 px-0.5 pb-3 text-sm font-medium transition-colors ${
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
      id={`${id}-tab`}
      onClick={() => onSelect(id)}
      role="tab"
      type="button"
    >
      {label}
    </button>
  );
}

function RawConfigurationPreview({ previews }: { previews: ConfigurationFilePreview[] }) {
  return (
    <section
      aria-labelledby="raw-config-tab"
      className="pt-5"
      id="raw-config-panel"
      role="tabpanel"
    >
      <div className="space-y-4">
        {previews.map((preview) => (
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
  );
}

function McpServers({
  canEditCodex,
  onUpdateEnabled,
  savingId,
  servers,
}: {
  canEditCodex: boolean;
  onUpdateEnabled: (server: McpServerSummary, enabled: boolean) => Promise<boolean>;
  savingId?: string;
  servers: McpServerSummary[];
}) {
  return (
    <section
      aria-labelledby="mcp-servers-tab"
      className="pt-5"
      id="mcp-servers-panel"
      role="tabpanel"
    >
      {servers.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No MCP servers are configured.
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((server) => (
            <article className="rounded-lg border bg-card p-4" key={server.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-medium">{server.name}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{server.transport}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                      server.enabled
                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "bg-secondary text-secondary-foreground"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`size-1.5 rounded-full ${server.enabled ? "bg-emerald-500" : "bg-muted-foreground"}`}
                    />
                    {server.enabled ? "Enabled" : "Disabled"}
                  </span>
                  {(canEditCodex || server.enabledPath) && (
                    <Switch
                      aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                      checked={server.enabled}
                      disabled={savingId !== undefined}
                      onCheckedChange={(enabled) => void onUpdateEnabled(server, enabled)}
                    />
                  )}
                </div>
              </div>
              <code className="mt-3 block break-all text-xs text-muted-foreground">
                {server.endpoint}
              </code>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function mcpServersFromPreviews(previews: ConfigurationFilePreview[]): McpServerSummary[] {
  return previews.flatMap((preview) => {
    if (!isRecord(preview.content)) {
      return [];
    }

    return mcpServerEntries(preview.content, preview.id).flatMap(({ name, path, value }) => {
      if (!isRecord(value)) {
        return [];
      }

      const url = firstString(value.url, value.httpUrl, value.uri);
      const commandValue = value.command ?? value.cmd;
      const commandParts = Array.isArray(commandValue)
        ? commandValue.filter((part): part is string => typeof part === "string")
        : [];
      const command = typeof commandValue === "string" ? commandValue : commandParts[0];
      const args = Array.isArray(value.args)
        ? value.args.filter((argument): argument is string => typeof argument === "string")
        : commandParts.slice(1);
      const endpoint = url ?? [command, ...args].filter(Boolean).join(" ");
      const usesDisabledFlag = typeof value.disabled === "boolean";
      const enabledPath =
        typeof value.enabled === "boolean"
          ? [...path, "enabled"]
          : usesDisabledFlag
            ? [...path, "disabled"]
            : undefined;

      return [
        {
          id: `${preview.path}:${name}`,
          sourceId: preview.id,
          name,
          transport:
            typeof value.type === "string"
              ? value.type
              : url
                ? value.httpUrl
                  ? "HTTP"
                  : "HTTP / SSE"
                : "stdio",
          endpoint: endpoint || "No endpoint or launch command configured",
          enabled: usesDisabledFlag ? value.disabled !== true : value.enabled !== false,
          enabledPath: sourceReadOnly(preview.id, preview.path) ? undefined : enabledPath,
          usesDisabledFlag,
        },
      ];
    });
  });
}

function mcpServerEntries(
  config: Record<string, unknown>,
  sourceId: string,
): {
  name: string;
  path: string[];
  value: unknown;
}[] {
  if (isRecord(config.mcp_servers)) {
    return Object.entries(config.mcp_servers).map(([name, value]) => ({
      name,
      path: ["mcp_servers", name],
      value,
    }));
  }
  if (isRecord(config.mcpServers)) {
    return Object.entries(config.mcpServers).map(([name, value]) => ({
      name,
      path: ["mcpServers", name],
      value,
    }));
  }
  if (Array.isArray(config.mcpServers)) {
    return config.mcpServers.flatMap((server, index) => {
      if (!isRecord(server)) {
        return [];
      }
      const name = typeof server.name === "string" ? server.name : `Server ${index + 1}`;
      return [{ name, path: ["mcpServers", String(index)], value: server }];
    });
  }

  if (sourceId.startsWith("opencode-") && isRecord(config.mcp)) {
    return Object.entries(config.mcp).map(([name, value]) => ({
      name,
      path: ["mcp", name],
      value,
    }));
  }
  if (sourceId.startsWith("goose-") && isRecord(config.extensions)) {
    return Object.entries(config.extensions)
      .filter(
        ([, value]) =>
          isRecord(value) && ["stdio", "sse", "streamable_http"].includes(String(value.type)),
      )
      .map(([name, value]) => ({ name, path: ["extensions", name], value }));
  }
  return [];
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationRevision(report?: ConfigurationReport) {
  return report?.previews.find((preview) => preview.format === "TOML")?.revision;
}

function ConfigurationPanel({
  children,
  tabId,
}: {
  children: ReactNode;
  tabId: ConfigurationTabId;
}) {
  return (
    <section
      aria-labelledby={`${tabId}-tab`}
      className="pt-5"
      id={`${tabId}-panel`}
      role="tabpanel"
    >
      {children}
    </section>
  );
}

function EmptyConfigurationState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

interface ProviderAddon {
  name: string;
  detail: string;
}

function PluginSettings({ previews }: { previews: ConfigurationFilePreview[] }) {
  const { marketplaces, plugins } = useMemo(() => providerAddonsFromPreviews(previews), [previews]);

  return (
    <ConfigurationPanel tabId="plugins">
      {plugins.length === 0 && marketplaces.length === 0 ? (
        <EmptyConfigurationState>
          No plugins or marketplaces are configured.
        </EmptyConfigurationState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <AddonCollection entries={plugins} label="Plugins" />
          <AddonCollection entries={marketplaces} label="Marketplaces" />
        </div>
      )}
    </ConfigurationPanel>
  );
}

function providerAddonsFromPreviews(previews: ConfigurationFilePreview[]) {
  const plugins = new Map<
    string,
    { configured: boolean; enabled?: boolean; installed: boolean; local: boolean }
  >();
  const marketplaces = new Map<string, "configured" | "registered">();

  const recordPlugin = (
    name: string,
    source: "configured" | "installed" | "local",
    enabled?: boolean,
  ) => {
    const plugin = plugins.get(name) ?? {
      configured: false,
      installed: false,
      local: false,
    };
    plugin[source] = true;
    if (enabled !== undefined) {
      plugin.enabled = enabled;
    }
    plugins.set(name, plugin);
  };

  previews.forEach((preview) => {
    if (!isRecord(preview.content)) {
      return;
    }

    const isClaudePluginRegistry = preview.id === "claude-code-plugins-installed";
    const isOpenCodePluginDirectory = preview.id === "opencode-global-plugins";
    if (
      preview.id.startsWith("gemini-cli-extension-") &&
      typeof preview.content.name === "string"
    ) {
      recordPlugin(preview.content.name, "installed");
    }
    pluginNames(preview.content.plugins).forEach(({ enabled, name }) =>
      recordPlugin(
        name,
        isClaudePluginRegistry ? "installed" : isOpenCodePluginDirectory ? "local" : "configured",
        enabled,
      ),
    );
    pluginNames(preview.content.plugin).forEach(({ enabled, name }) =>
      recordPlugin(name, "configured", enabled),
    );
    recordEntries(preview.content.enabledPlugins).forEach(([name, enabled]) =>
      recordPlugin(name, "configured", typeof enabled === "boolean" ? enabled : undefined),
    );

    const isClaudeMarketplaceRegistry = preview.id === "claude-code-plugin-marketplaces";
    if (isClaudeMarketplaceRegistry) {
      recordEntries(preview.content).forEach(([name]) => marketplaces.set(name, "registered"));
    }
    recordEntries(preview.content.marketplaces).forEach(([name]) =>
      marketplaces.set(name, "configured"),
    );
    recordEntries(preview.content.extraKnownMarketplaces).forEach(([name]) =>
      marketplaces.set(name, "configured"),
    );
  });

  return {
    plugins: [...plugins.entries()]
      .map(([name, plugin]) => ({
        name,
        detail: plugin.installed
          ? `Installed${plugin.enabled === undefined ? "" : plugin.enabled ? " · Enabled" : " · Disabled"}`
          : plugin.local
            ? "Local plugin"
            : `Configured${plugin.enabled === undefined ? "" : plugin.enabled ? " · Enabled" : " · Disabled"}`,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    marketplaces: [...marketplaces.entries()]
      .map(([name, source]) => ({
        name,
        detail: source === "registered" ? "Registered marketplace" : "Configured marketplace",
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function pluginNames(value: unknown): { enabled?: boolean; name: string }[] {
  if (isRecord(value)) {
    return Object.keys(value).map((name) => ({ name }));
  }
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((plugin, index) => {
    if (typeof plugin === "string") {
      return plugin.startsWith("-") ? { name: plugin.slice(1), enabled: false } : { name: plugin };
    }
    if (isRecord(plugin)) {
      const name = firstString(plugin.name, plugin.package);
      if (name) {
        return { name };
      }
    }
    return { name: `Plugin ${index + 1}` };
  });
}

function AddonCollection({ entries, label }: { entries: ProviderAddon[]; label: string }) {
  return (
    <article className="overflow-hidden rounded-lg border bg-card">
      <h2 className="border-b px-4 py-3 text-sm font-semibold">{label}</h2>
      {entries.length > 0 ? (
        <ul className="divide-y">
          {entries.map((entry) => (
            <li className="px-4 py-3" key={entry.name}>
              <p className="break-all text-sm font-medium">{entry.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{entry.detail}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-5 text-sm text-muted-foreground">None configured.</p>
      )}
    </article>
  );
}

function recordEntries(value: unknown): [string, unknown][] {
  return isRecord(value) ? Object.entries(value) : [];
}

function collectionSummary(value: unknown): string {
  if (Array.isArray(value)) {
    return `${value.length} ${value.length === 1 ? "entry" : "entries"}`;
  }
  if (isRecord(value)) {
    return `${Object.keys(value).length} ${Object.keys(value).length === 1 ? "setting" : "settings"}`;
  }
  return formatConfigValue(value);
}

function formatConfigValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "Enabled" : "Disabled";
  }
  if (value === null || value === undefined) {
    return "Not set";
  }
  if (isRecord(value) || Array.isArray(value)) {
    return collectionSummary(value);
  }
  return String(value);
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
      configurationTargetsFromScan(result).filter((target) =>
        managedHarnessIds.includes(target.id),
      ),
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

            <ManagedHarnesses onRemove={onRemoveConfiguration} targets={managedTargets} />

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
                      <p className="text-xs font-medium text-muted-foreground">
                        {presentation.label}
                      </p>
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

  return {
    id: `${family.id}:${runtime.id}`,
    familyId: family.id,
    runtimeId: runtime.id,
    familyName: familyPresentation.label,
    name: runtimePresentation.label,
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
