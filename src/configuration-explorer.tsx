import { useState } from "react";
import {
  type ConfigurationTabId,
  type Json,
  type Schema,
  schemas,
  references,
  resolveSchema,
  childSchema,
  isObject,
  sectionFor,
  sensitiveKey,
  containsSensitive,
  sourceReadOnly,
} from "./configuration-model";
import { Switch } from "./components/ui/switch";

export interface ConfigPreview {
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
export type UpdateSetting = (
  id: string,
  storeId: string,
  path: string[],
  value: Json,
) => Promise<boolean>;

export function ConfigurationExplorer({
  previews,
  tab,
  family,
  saving,
  onUpdate,
}: {
  previews: ConfigPreview[];
  tab: ConfigurationTabId;
  family: string;
  saving: boolean;
  onUpdate: UpdateSetting;
}) {
  const [search, setSearch] = useState("");
  const [showAvailable, setShowAvailable] = useState(false);
  const reference = references[family];
  let count = 0;
  return (
    <section className="space-y-5 pt-5" aria-label={`${tab} settings`}>
      <div className="flex flex-wrap items-center gap-4">
        <input
          aria-label="Search settings"
          placeholder="Search settings…"
          className="min-w-48 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={showAvailable} onCheckedChange={setShowAvailable} />
          Show available settings
        </label>
      </div>
      {reference && (
        <p className="text-xs text-muted-foreground">
          {reference.coverage} · Reviewed September 14, 2026 ·{" "}
          <a
            className="text-primary hover:underline"
            href={reference.url}
            target="_blank"
            rel="noreferrer"
          >
            Configuration reference ↗
          </a>
        </p>
      )}
      {previews.map((preview) => {
        const root = preview.schemaId ? (schemas[preview.schemaId] ?? {}) : {};
        const schema = resolveSchema(root, root);
        const content = isObject(preview.content) ? preview.content : {};
        const declared = isObject(schema.properties) ? schema.properties : {};
        const keys = [
          ...new Set([...Object.keys(content), ...(showAvailable ? Object.keys(declared) : [])]),
        ]
          .filter(
            (key) =>
              sectionFor(key) === tab &&
              (!search ||
                key.toLowerCase().includes(search.toLowerCase()) ||
                JSON.stringify(content[key] ?? declared[key])
                  .toLowerCase()
                  .includes(search.toLowerCase())),
          )
          .sort((a, b) => a.localeCompare(b));
        if (!keys.length) return null;
        count += keys.length;
        const readOnly =
          sourceReadOnly(preview.id, preview.path) ||
          !preview.revision ||
          preview.format === "Directory";
        return (
          <article key={preview.id} className="overflow-hidden rounded-lg border bg-card">
            <div className="border-b px-4 py-3">
              <p className="break-all text-xs text-muted-foreground">{preview.path}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {readOnly
                  ? "Read-only source"
                  : preview.schemaId
                    ? "Schema-checked edits"
                    : "Existing scalar edits · schema validation unavailable"}
              </p>
            </div>
            <div className="divide-y">
              {keys.map((key) => (
                <SettingNode
                  key={`${preview.id}:${key}`}
                  path={[key]}
                  value={content[key]}
                  schema={childSchema(schema, root, key)}
                  root={root}
                  available={showAvailable}
                  writable={!readOnly && (!preview.schemaId || key in declared)}
                  schemaChecked={Boolean(preview.schemaId)}
                  saving={saving}
                  onSave={(path, value) =>
                    onUpdate(`${preview.id}:${JSON.stringify(path)}`, preview.id, path, value)
                  }
                />
              ))}
            </div>
          </article>
        );
      })}
      {count === 0 && (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {search
            ? "No matching settings."
            : "No settings in this section. Turn on Show available settings to browse supported options."}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Files are shown separately. Project settings, managed policy and command-line overrides may
        change the effective configuration.
      </p>
    </section>
  );
}

function SettingNode({
  path,
  value,
  schema,
  root,
  available,
  writable,
  schemaChecked,
  saving,
  onSave,
}: {
  path: string[];
  value: unknown;
  schema: Schema;
  root: Schema;
  available: boolean;
  writable: boolean;
  schemaChecked: boolean;
  saving: boolean;
  onSave: (path: string[], value: Json) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [addingEntry, setAddingEntry] = useState(false);
  const [entryName, setEntryName] = useState("");
  const [entryValue, setEntryValue] = useState("{}");
  const name = path[path.length - 1];
  const missing = value === undefined;
  const resolved = resolveSchema(schema, root);
  const props = isObject(resolved.properties) ? resolved.properties : {};
  const collection =
    isObject(value) || Array.isArray(value) || (missing && Object.keys(props).length > 0);
  const secret = path.some(sensitiveKey) || value === "[redacted]";
  const options = Array.isArray(resolved.enum) ? resolved.enum : undefined;
  const kind =
    typeof resolved.type === "string"
      ? resolved.type
      : resolved.anyOf || resolved.oneOf || Array.isArray(resolved.type)
        ? "json"
        : typeof value;
  const canEdit =
    writable &&
    resolved.readOnly !== true &&
    !secret &&
    !containsSensitive(value) &&
    (schemaChecked || (!missing && ["string", "number", "boolean"].includes(typeof value))) &&
    !(path.some((p) => /^\d+$/.test(p)) && root === schemas.codex);
  const startEdit = () => {
    const initial = missing
      ? (resolved.default ??
        options?.[0] ??
        (kind === "string"
          ? ""
          : kind === "array"
            ? []
            : kind === "object" || collection
              ? {}
              : kind === "boolean"
                ? false
                : kind === "json"
                  ? null
                  : 0))
      : value;
    setDraft(
      typeof initial === "string" && kind === "string" ? initial : JSON.stringify(initial, null, 2),
    );
    setError("");
    setEditing(true);
  };
  const save = async () => {
    try {
      const next: Json = kind === "string" ? draft : JSON.parse(draft);
      if (await onSave(path, next)) setEditing(false);
    } catch {
      setError("Enter a valid value. Lists and objects use JSON syntax.");
    }
  };
  const children = collection
    ? [
        ...new Set([
          ...(isObject(value) || Array.isArray(value) ? Object.keys(value) : []),
          ...(available ? Object.keys(props) : []),
        ]),
      ]
    : [];
  const [expanded, setExpanded] = useState(path.length === 1 && children.length < 8);
  const canAddEntry =
    writable &&
    resolved.readOnly !== true &&
    schemaChecked &&
    !secret &&
    (isObject(resolved.additionalProperties) || resolved.additionalProperties === true) &&
    !Array.isArray(value);
  const addEntry = async () => {
    try {
      if (!entryName.trim() || (isObject(value) && entryName in value)) {
        setError("Choose a new, non-empty entry name.");
        return;
      }
      if (await onSave([...path, entryName], JSON.parse(entryValue))) {
        setAddingEntry(false);
        setEntryName("");
        setEntryValue("{}");
        setError("");
      }
    } catch {
      setError("Enter valid JSON for the entry value.");
    }
  };
  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="break-all text-sm font-medium">
            {name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}
          </p>
          <code className="text-xs text-muted-foreground">{path.join(".")}</code>
        </div>
        {canEdit &&
          !editing &&
          (typeof value === "boolean" ? (
            <Switch
              aria-label={`Toggle ${path.join(".")}`}
              checked={value}
              disabled={saving}
              onCheckedChange={(next) => void onSave(path, next)}
            />
          ) : (
            <button
              type="button"
              className="shrink-0 text-xs text-primary hover:underline"
              disabled={saving}
              onClick={startEdit}
            >
              {missing ? "Add" : "Edit"}
            </button>
          ))}
      </div>
      {canAddEntry && (
        <button
          type="button"
          className="mt-2 text-xs text-primary hover:underline"
          disabled={saving}
          onClick={() => {
            setAddingEntry(!addingEntry);
            setError("");
          }}
        >
          Add entry
        </button>
      )}
      {addingEntry && (
        <div className="mt-3 space-y-2">
          <input
            aria-label={`New entry name in ${path.join(".")}`}
            className="w-full rounded-md border bg-background p-2 text-sm"
            placeholder="Entry name"
            value={entryName}
            onChange={(event) => setEntryName(event.target.value)}
          />
          <textarea
            aria-label={`New entry value in ${path.join(".")}`}
            className="w-full rounded-md border bg-background p-2 font-mono text-sm"
            rows={5}
            value={entryValue}
            onChange={(event) => setEntryValue(event.target.value)}
          />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground"
            disabled={saving}
            onClick={() => void addEntry()}
          >
            Save entry
          </button>
        </div>
      )}
      {typeof resolved.description === "string" && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
          {resolved.description}
        </p>
      )}
      {editing ? (
        <div className="mt-3 space-y-2">
          {options ? (
            <select
              aria-label={`Value for ${path.join(".")}`}
              className="w-full rounded-md border bg-background p-2 text-sm"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            >
              {options.map((option) => (
                <option
                  key={JSON.stringify(option)}
                  value={
                    kind === "string" && typeof option === "string"
                      ? option
                      : JSON.stringify(option)
                  }
                >
                  {String(option)}
                </option>
              ))}
            </select>
          ) : (
            <textarea
              aria-label={`Value for ${path.join(".")}`}
              className="w-full rounded-md border bg-background p-2 font-mono text-sm"
              rows={collection || kind === "array" || kind === "object" ? 6 : 2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-3">
            <button
              className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground"
              type="button"
              disabled={saving}
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              type="button"
              className="text-xs"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : secret ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {isObject(value) ? `${Object.keys(value).join(", ")} · values hidden` : "Hidden"}
        </p>
      ) : collection ? (
        <details
          className="mt-2"
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {missing ? "Not set · " : ""}
            {children.length} fields{!children.length ? " · empty collection" : ""}
          </summary>
          <div className="mt-2 divide-y border-l">
            {expanded &&
              children.map((key) => (
                <SettingNode
                  key={key}
                  path={[...path, key]}
                  value={
                    isObject(value)
                      ? value[key]
                      : Array.isArray(value)
                        ? value[Number(key)]
                        : undefined
                  }
                  schema={childSchema(resolved, root, key)}
                  root={root}
                  available={available}
                  writable={writable && resolved.readOnly !== true}
                  schemaChecked={schemaChecked}
                  saving={saving}
                  onSave={onSave}
                />
              ))}
          </div>
        </details>
      ) : (
        <p className="mt-2 whitespace-pre-wrap break-all text-sm">
          {missing
            ? `Not set${resolved.default !== undefined ? ` · schema default: ${JSON.stringify(resolved.default)}` : ""}`
            : value === null
              ? "null"
              : String(value)}
        </p>
      )}
    </div>
  );
}

export function ConfigurationValidation({ previews }: { previews: ConfigPreview[] }) {
  const findings = previews.flatMap((preview) =>
    (preview.schemaIssues ?? []).map((issue) => ({
      source: preview.path,
      message: `${issue.path || "/"}: failed ${issue.rule} validation.`,
    })),
  );
  if (!findings.length) return null;
  return (
    <details className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">
        {findings.length} configuration findings
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        These settings do not match the configuration validation rules.
      </p>
      <ul className="mt-3 space-y-2">
        {findings.map((finding, index) => (
          <li className="text-xs" key={index}>
            <p className="break-all text-muted-foreground">{finding.source}</p>
            <p>{finding.message}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
