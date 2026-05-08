"use client";

import {
  ChevronDownIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ProviderCustomAgentId,
  isProviderDriverKind,
  type CodexAgentSummary,
  type ProviderCustomAgent,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DriverOption } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import {
  PROVIDER_STATUS_STYLES,
  getProviderSummary,
  getProviderVersionLabel,
  type ProviderStatusKey,
} from "./providerStatus";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const CUSTOM_AGENT_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

let environmentVariableDraftId = 0;
const nextEnvironmentVariableDraftId = () => `provider-env-${environmentVariableDraftId++}`;
let customAgentDraftId = 0;
const nextCustomAgentDraftId = () => `provider-agent-${customAgentDraftId++}`;

type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
};

type CustomAgentDraftRow = {
  readonly rowId: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly nicknameCandidates: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly sandboxMode: string;
  readonly enabled: boolean;
};

function makeEnvironmentDraftRow(
  variable: ProviderInstanceEnvironmentVariable,
  index: number,
): EnvironmentDraftRow {
  return {
    id: `${index}:${variable.name}`,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
  };
}

function makeCustomAgentDraftRow(agent: ProviderCustomAgent, index: number): CustomAgentDraftRow {
  return {
    rowId: `${index}:${agent.id}`,
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    instructions: agent.instructions,
    nicknameCandidates: (agent.nicknameCandidates ?? []).join(", "),
    model: agent.model ?? "",
    reasoningEffort: agent.reasoningEffort ?? "",
    sandboxMode: agent.sandboxMode ?? "",
    enabled: agent.enabled !== false,
  };
}

function slugifyCustomAgentName(value: string): string {
  const slug = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) {
    return "agent";
  }
  return /^[a-zA-Z]/.test(slug) ? slug : `agent-${slug}`;
}

/**
 * Read a string[] at `key` from the opaque config blob, filtering out
 * non-string entries. Used for `customModels`, which is always typed as
 * `string[]` by the concrete driver schemas but arrives here as
 * `Schema.Unknown`.
 */
function readConfigStringArray(config: unknown, key: string): ReadonlyArray<string> {
  if (config === null || typeof config !== "object") return [];
  const value = (config as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Set `key` to an arbitrary value on the opaque config blob. Unlike
 * provider settings field updates, does not drop empty-looking values — the
 * caller is responsible for deciding whether an empty array / empty
 * object should be stored explicitly (e.g. `customModels: []` is a
 * meaningful "user cleared their custom list" state distinct from
 * "driver default").
 */
function nextConfigBlobWithValue(
  config: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  base[key] = value;
  return base;
}

export function deriveProviderModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly customModels: ReadonlyArray<string>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    (input.liveModels ?? [])
      .filter((model) => model.isCustom)
      .map((model) => [model.slug, model] as const),
  );
  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];
  const customModels = input.customModels.map(
    (slug) =>
      liveCustomModelsBySlug.get(slug) ?? {
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      },
  );
  return [...serverModels, ...customModels];
}

function ProviderAuthEmail(props: {
  readonly email: string | undefined;
  readonly prefix?: string;
  readonly separator?: boolean;
}) {
  const trimmed = props.email?.trim();
  if (!trimmed) return null;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden">
      {props.separator ? (
        <span className="shrink-0" aria-hidden>
          ·
        </span>
      ) : null}
      {props.prefix ? (
        <span className="shrink-0 text-muted-foreground/80">{props.prefix}</span>
      ) : null}
      <RedactedSensitiveText
        value={trimmed}
        ariaLabel="Toggle account email visibility"
        revealTooltip="Click to reveal email"
        hideTooltip="Click to hide email"
        className="truncate"
      />
    </span>
  );
}

function ProviderAccentColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value ?? "");
  const [isEditing, setIsEditing] = useState(false);
  const draftColor = normalizeProviderAccentColor(draft);

  useEffect(() => {
    if (isEditing) return;
    setDraft(props.value ?? "");
  }, [isEditing, props.value]);

  const commitDraft = () => {
    setIsEditing(false);
    props.onCommit(draftColor ?? "");
  };

  const commitSwatch = (swatch: string) => {
    setIsEditing(false);
    setDraft(swatch);
    props.onCommit(swatch);
  };

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">Accent color</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          type="color"
          value={draftColor ?? PROVIDER_ACCENT_SWATCHES[0]}
          onFocus={() => setIsEditing(true)}
          onInput={(event) => {
            setIsEditing(true);
            setDraft(event.currentTarget.value);
          }}
          onChange={(event) => {
            setIsEditing(true);
            setDraft(event.currentTarget.value);
          }}
          onBlur={commitDraft}
          aria-label={`Accent color for ${props.displayName}`}
          className="h-8 w-10 cursor-pointer rounded border border-input bg-background p-0.5"
        />
        <div className="flex flex-wrap gap-1.5">
          {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
            const selected = draftColor?.toLowerCase() === swatch;
            return (
              <button
                key={swatch}
                type="button"
                className={cn(
                  "size-6 cursor-pointer rounded-full border transition",
                  selected
                    ? "border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                    : "border-black/10 hover:scale-105 dark:border-white/20",
                )}
                style={{ backgroundColor: swatch }}
                onClick={() => commitSwatch(swatch)}
                aria-label={`Use ${swatch} accent`}
              />
            );
          })}
        </div>
        {draftColor ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => {
              setIsEditing(false);
              setDraft("");
              props.onCommit("");
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
      <span className="text-xs text-muted-foreground">
        Used to distinguish this instance in picker rails and model lists.
      </span>
    </div>
  );
}

function ProviderEnvironmentSection(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<EnvironmentDraftRow>>(() =>
    props.environment.map(makeEnvironmentDraftRow),
  );

  useEffect(() => {
    setRows(props.environment.map(makeEnvironmentDraftRow));
  }, [props.environment]);

  const publishRows = (nextRows: ReadonlyArray<EnvironmentDraftRow>) => {
    const published: ProviderInstanceEnvironmentVariable[] = [];
    for (const row of nextRows) {
      const name = row.name.trim();
      if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
        if (
          name.length > 0 ||
          row.value.length > 0 ||
          row.sensitive !== true ||
          row.valueRedacted !== undefined
        ) {
          return;
        }
        continue;
      }
      const { id: _id, ...rest } = row;
      published.push({ ...rest, name });
    }
    props.onChange(published);
  };

  const updateVariable = (id: string, patch: Partial<Omit<EnvironmentDraftRow, "id">>) => {
    const nextRows = rows.map((row) =>
      row.id === id
        ? {
            ...row,
            ...patch,
            ...(patch.value !== undefined ? { valueRedacted: false } : {}),
          }
        : row,
    );
    setRows(nextRows);
    publishRows(nextRows);
  };

  const removeVariable = (id: string) => {
    const nextRows = rows.filter((row) => row.id !== id);
    setRows(nextRows);
    publishRows(nextRows);
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">Environment variables</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() =>
            setRows([
              ...rows,
              {
                id: nextEnvironmentVariableDraftId(),
                name: "",
                value: "",
                sensitive: true,
              },
            ])
          }
        >
          <PlusIcon className="size-3" />
          Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Add variables to pass API keys, base URLs, or other per-instance CLI settings.
        </p>
      ) : (
        <div className="grid gap-2">
          {rows.map((variable, index) => (
            <div
              key={variable.id}
              className="grid gap-2 rounded-md border border-border/70 bg-muted/20 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] sm:items-center"
            >
              <DraftInput
                value={variable.name}
                onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
                placeholder="VARIABLE_NAME"
                spellCheck={false}
                aria-label={`Environment variable name ${index + 1}`}
              />
              <DraftInput
                value={variable.valueRedacted ? "" : variable.value}
                onCommit={(value) => updateVariable(variable.id, { value })}
                type={variable.sensitive ? "password" : undefined}
                autoComplete="off"
                placeholder={
                  variable.valueRedacted ? "Stored secret - enter a new value to replace" : "Value"
                }
                spellCheck={false}
                aria-label={`Environment variable value ${index + 1}`}
              />
              <label className="inline-flex h-8 items-center gap-2 text-xs text-muted-foreground">
                <Switch
                  checked={variable.sensitive}
                  onCheckedChange={(checked) => {
                    const sensitive = Boolean(checked);
                    updateVariable(variable.id, {
                      sensitive,
                      ...(sensitive && variable.valueRedacted === undefined
                        ? {}
                        : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                    });
                  }}
                  aria-label={`Mark environment variable ${variable.name || index + 1} as sensitive`}
                />
                Sensitive
              </label>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="size-8 justify-self-start text-muted-foreground hover:text-destructive sm:justify-self-end"
                onClick={() => removeVariable(variable.id)}
                aria-label={`Remove environment variable ${variable.name || index + 1}`}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <span className="text-xs text-muted-foreground">
        Sensitive values are stored separately and are not returned to the app after saving.
      </span>
    </div>
  );
}

function ProviderMcpSection(props: {
  readonly enabled: boolean;
  readonly onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <span className="text-xs font-medium text-foreground">MCP servers</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          Allows this provider instance to use configured MCP servers for new sessions.
        </span>
      </div>
      <Switch
        checked={props.enabled}
        onCheckedChange={(checked) => props.onChange(Boolean(checked))}
        aria-label="Toggle MCP servers for this provider"
      />
    </div>
  );
}

function ProviderCustomAgentsSection(props: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly customAgents: ReadonlyArray<ProviderCustomAgent>;
  readonly driverKind: ProviderDriverKind | null;
  readonly onChange: (customAgents: ReadonlyArray<ProviderCustomAgent>) => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<CustomAgentDraftRow>>(() =>
    props.customAgents.map(makeCustomAgentDraftRow),
  );
  const rowsRef = useRef(rows);
  const [nativeAgents, setNativeAgents] = useState<ReadonlyArray<CodexAgentSummary>>([]);
  const [nativeAgentsPath, setNativeAgentsPath] = useState<string | null>(null);
  const [nativeAgentsError, setNativeAgentsError] = useState<string | null>(null);
  const [isLoadingNativeAgents, setIsLoadingNativeAgents] = useState(false);
  const [editorDraft, setEditorDraft] = useState<CustomAgentDraftRow | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const isCodex = props.driverKind === ProviderDriverKind.make("codex");

  useEffect(() => {
    const nextRows = props.customAgents.map(makeCustomAgentDraftRow);
    rowsRef.current = nextRows;
    setRows(nextRows);
  }, [props.customAgents]);

  const loadNativeAgents = useCallback(() => {
    if (!isCodex) {
      setNativeAgents([]);
      setNativeAgentsPath(null);
      return;
    }
    setIsLoadingNativeAgents(true);
    setNativeAgentsError(null);
    void ensureLocalApi()
      .server.codexAgents.list({ providerInstanceId: props.providerInstanceId })
      .then((result) => {
        setNativeAgents(result.agents);
        setNativeAgentsPath(result.agentsPath);
      })
      .catch((error: unknown) => {
        setNativeAgentsError(
          error instanceof Error ? error.message : "Failed to load Codex agents.",
        );
      })
      .finally(() => setIsLoadingNativeAgents(false));
  }, [isCodex, props.providerInstanceId]);

  useEffect(() => {
    loadNativeAgents();
  }, [loadNativeAgents]);

  const publishRows = (nextRows: ReadonlyArray<CustomAgentDraftRow>) => {
    const published: ProviderCustomAgent[] = [];
    for (const row of nextRows) {
      const id = row.id.trim();
      const name = row.name.trim();
      const instructions = row.instructions.trim();
      if (!CUSTOM_AGENT_ID_PATTERN.test(id)) {
        if (id.length > 0 || name.length > 0 || instructions.length > 0) {
          return;
        }
        continue;
      }
      if (!name || !instructions) {
        continue;
      }
      published.push({
        id: ProviderCustomAgentId.make(id),
        name,
        instructions,
        enabled: row.enabled,
        ...(row.description.trim() ? { description: row.description.trim() } : {}),
        ...(row.nicknameCandidates.trim()
          ? {
              nicknameCandidates: row.nicknameCandidates
                .split(",")
                .map((candidate) => candidate.trim())
                .filter((candidate) => candidate.length > 0),
            }
          : {}),
        ...(row.model.trim() ? { model: row.model.trim() } : {}),
        ...(row.reasoningEffort.trim() ? { reasoningEffort: row.reasoningEffort.trim() } : {}),
        ...(row.sandboxMode.trim() ? { sandboxMode: row.sandboxMode.trim() } : {}),
      });
    }
    props.onChange(published);
  };

  const updateAgent = (
    rowId: string,
    patch: Partial<Omit<CustomAgentDraftRow, "rowId">>,
    options?: { readonly publish?: boolean },
  ) => {
    const nextRows = rows.map((row) => {
      if (row.rowId !== rowId) {
        return row;
      }
      const next = { ...row, ...patch };
      if (patch.name !== undefined && row.id.trim().length === 0) {
        return { ...next, id: slugifyCustomAgentName(patch.name) };
      }
      return next;
    });
    rowsRef.current = nextRows;
    setRows(nextRows);
    if (options?.publish !== false) {
      publishRows(nextRows);
    }
  };

  const addAgent = () => {
    setEditorDraft({
      rowId: nextCustomAgentDraftId(),
      id: "",
      name: "",
      description: "",
      instructions: "",
      nicknameCandidates: "",
      model: "",
      reasoningEffort: "",
      sandboxMode: "",
      enabled: true,
    });
    setIsEditorOpen(true);
  };

  const saveAgentDraft = () => {
    if (!editorDraft) return;
    const nextRows = rows.some((row) => row.rowId === editorDraft.rowId)
      ? rows.map((row) => (row.rowId === editorDraft.rowId ? editorDraft : row))
      : [...rows, editorDraft];
    rowsRef.current = nextRows;
    setRows(nextRows);
    publishRows(nextRows);
    setIsEditorOpen(false);
  };

  const removeAgent = (rowId: string) => {
    const nextRows = rows.filter((row) => row.rowId !== rowId);
    rowsRef.current = nextRows;
    setRows(nextRows);
    publishRows(nextRows);
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-xs font-medium text-foreground">Agents</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Agents appear in chat model controls. Native Codex agents are loaded automatically.
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={addAgent}
        >
          <PlusIcon className="size-3" />
          Add agent
        </Button>
      </div>
      {isCodex ? (
        <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 p-2">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">Codex native agents</div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">
                {nativeAgentsPath ?? "Resolving agents directory..."}
              </div>
            </div>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="size-7 text-muted-foreground"
              onClick={loadNativeAgents}
              disabled={isLoadingNativeAgents}
              aria-label="Refresh Codex agents"
            >
              {isLoadingNativeAgents ? (
                <RefreshCwIcon className="size-3.5 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
            </Button>
          </div>
          {nativeAgentsError ? (
            <div className="text-xs text-destructive">{nativeAgentsError}</div>
          ) : nativeAgents.length === 0 && !isLoadingNativeAgents ? (
            <div className="text-xs text-muted-foreground">
              No native Codex agent TOML files were found.
            </div>
          ) : (
            <div className="grid gap-1">
              {nativeAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="grid gap-2 rounded border border-border/60 bg-background/55 px-2 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs font-medium text-foreground">
                        {agent.name}
                      </span>
                      <Badge variant={agent.managed ? "info" : "outline"} size="sm">
                        {agent.managed ? "T3" : "Codex"}
                      </Badge>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">
                      {agent.id}
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    size="sm"
                    className="justify-self-start sm:justify-self-end"
                  >
                    Automatic
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Add reusable agent profiles for review, planning, frontend work, or provider-specific
          workflows.
        </p>
      ) : (
        <div className="grid gap-2">
          {rows.map((agent, index) => (
            <div
              key={agent.rowId}
              className="grid gap-2 rounded-md border border-border/70 bg-muted/20 p-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {agent.name || "Untitled agent"}
                  </span>
                  <Badge variant={agent.enabled ? "success" : "warning"} size="sm">
                    {agent.enabled ? "enabled" : "disabled"}
                  </Badge>
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">
                  {agent.id || `agent-${index + 1}`}
                </div>
                {agent.description ? (
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {agent.description}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={agent.enabled}
                  onCheckedChange={(checked) =>
                    updateAgent(agent.rowId, { enabled: Boolean(checked) })
                  }
                  aria-label={`Toggle custom agent ${agent.name || index + 1}`}
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="size-8 text-muted-foreground"
                  onClick={() => {
                    setEditorDraft(agent);
                    setIsEditorOpen(true);
                  }}
                  aria-label={`Edit custom agent ${agent.name || index + 1}`}
                >
                  <PencilIcon className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  onClick={() => removeAgent(agent.rowId)}
                  aria-label={`Remove custom agent ${agent.name || index + 1}`}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog
        open={isEditorOpen}
        onOpenChange={setIsEditorOpen}
        onOpenChangeComplete={(open) => {
          if (!open) {
            setEditorDraft(null);
          }
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editorDraft?.id ? "Edit Agent" : "Add Agent"}</DialogTitle>
            <DialogDescription>
              Define the native Codex fields once. T3 writes enabled Codex agents to TOML.
            </DialogDescription>
          </DialogHeader>
          {editorDraft ? (
            <DialogPanel className="grid gap-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <DraftInput
                  value={editorDraft.name}
                  onCommit={(name) =>
                    setEditorDraft((current) =>
                      current
                        ? {
                            ...current,
                            name,
                            id: current.id.trim() ? current.id : slugifyCustomAgentName(name),
                          }
                        : current,
                    )
                  }
                  placeholder="Code reviewer"
                  spellCheck={false}
                  aria-label="Agent name"
                />
                <DraftInput
                  value={editorDraft.id}
                  onCommit={(id) =>
                    setEditorDraft((current) => (current ? { ...current, id: id.trim() } : current))
                  }
                  placeholder="code-reviewer"
                  spellCheck={false}
                  aria-label="Agent id"
                />
              </div>
              <DraftInput
                value={editorDraft.description}
                onCommit={(description) =>
                  setEditorDraft((current) => (current ? { ...current, description } : current))
                }
                placeholder="Optional short description"
                spellCheck={false}
                aria-label="Agent description"
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <DraftInput
                  value={editorDraft.nicknameCandidates}
                  onCommit={(nicknameCandidates) =>
                    setEditorDraft((current) =>
                      current ? { ...current, nicknameCandidates } : current,
                    )
                  }
                  placeholder="Nicknames, comma-separated"
                  spellCheck={false}
                  aria-label="Agent nicknames"
                />
                <DraftInput
                  value={editorDraft.model}
                  onCommit={(model) =>
                    setEditorDraft((current) => (current ? { ...current, model } : current))
                  }
                  placeholder="Optional model override"
                  spellCheck={false}
                  aria-label="Agent model override"
                />
                <DraftInput
                  value={editorDraft.reasoningEffort}
                  onCommit={(reasoningEffort) =>
                    setEditorDraft((current) =>
                      current ? { ...current, reasoningEffort } : current,
                    )
                  }
                  placeholder="Reasoning effort"
                  spellCheck={false}
                  aria-label="Agent reasoning effort"
                />
                <DraftInput
                  value={editorDraft.sandboxMode}
                  onCommit={(sandboxMode) =>
                    setEditorDraft((current) => (current ? { ...current, sandboxMode } : current))
                  }
                  placeholder="Sandbox mode"
                  spellCheck={false}
                  aria-label="Agent sandbox mode"
                />
              </div>
              <label className="inline-flex h-8 items-center gap-2 text-xs text-muted-foreground">
                <Switch
                  checked={editorDraft.enabled}
                  onCheckedChange={(checked) =>
                    setEditorDraft((current) =>
                      current ? { ...current, enabled: Boolean(checked) } : current,
                    )
                  }
                  aria-label="Toggle agent"
                />
                Enabled
              </label>
              <Textarea
                value={editorDraft.instructions}
                onChange={(event) =>
                  setEditorDraft((current) =>
                    current ? { ...current, instructions: event.currentTarget.value } : current,
                  )
                }
                placeholder="Developer instructions for this agent"
                spellCheck={false}
                aria-label="Agent instructions"
                className="min-h-36"
              />
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsEditorOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={saveAgentDraft}
              disabled={
                !editorDraft?.id.trim() ||
                !editorDraft.name.trim() ||
                !editorDraft.instructions.trim()
              }
            >
              Save agent
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

interface ProviderInstanceCardProps {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driverOption: DriverOption | undefined;
  readonly liveProvider: ServerProvider | undefined;
  readonly isExpanded: boolean;
  readonly onExpandedChange: (open: boolean) => void;
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => void;
  /**
   * Pass `undefined` to hide the delete button entirely. Built-in default
   * instance slots use `undefined` — they can't be deleted without losing
   * the slot, and their "reset to defaults" affordance lives on an outer
   * reset button instead. Explicit `| undefined` in the type accommodates
   * `exactOptionalPropertyTypes: true`, where an absent key and
   * `{ onDelete: undefined }` are treated as distinct shapes.
   */
  readonly onDelete?: (() => void) | undefined;
  /**
   * Optional outer reset button rendered next to the driver icon. Built-in
   * default slots supply a reset-to-factory control here; custom instances
   * omit it.
   */
  readonly headerAction?: ReactNode | undefined;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly detailMode?: "all" | "agents" | "mcp";
}

/**
 * A single configured provider-instance row in the Providers settings
 * section. Used for every row — both the built-in default instance for a
 * driver (rendered with `onDelete` omitted) and user-authored custom
 * instances (`onDelete` supplied). The only UI difference between the two
 * is whether the trash button is visible; every other field (display
 * name, config fields, models) behaves identically.
 *
 * Behavior notes:
 *   - `liveProvider` is matched by the caller via `instanceId`; when no
 *     match is available (e.g. the server hasn't probed yet, or the
 *     driver is not shipped by the current build) the card still renders
 *     with a neutral "checking" summary.
 *   - Unknown drivers (`driverOption === undefined`) get a read-only
 *     notice instead of editable fields, so fork instances round-trip
 *     without accidentally destroying their config.
 *   - The enabled button writes to the envelope's `instance.enabled`
 *     field; the server's registry consults this at `entry.enabled ?? true`
 *     before materializing the instance, and the probe also checks its
 *     driver-specific `config.enabled`. We treat the envelope flag as the
 *     single source of truth from the UI — built-in cards used to write
 *     the inner flag, but on the promotion-to-instance path every edit
 *     flows through the envelope.
 */
export function ProviderInstanceCard({
  instanceId,
  instance,
  driverOption,
  liveProvider,
  isExpanded,
  onExpandedChange,
  onUpdate,
  onDelete,
  headerAction,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
  detailMode = "all",
}: ProviderInstanceCardProps) {
  const enabled = instance.enabled ?? true;
  const mcpEnabled = instance.mcpEnabled ?? true;
  const customAgentCount = (instance.customAgents ?? []).length;
  const enabledCustomAgentCount = (instance.customAgents ?? []).filter(
    (agent) => agent.enabled !== false,
  ).length;
  // Keep the card status treatment tied to probe health, not the local
  // enable control, so toggling an instance does not resize or visually
  // reclassify the whole provider row.
  const statusKey: ProviderStatusKey =
    liveProvider?.status === "disabled"
      ? "warning"
      : ((liveProvider?.status as ProviderStatusKey | undefined) ?? "warning");
  const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
  const summary = getProviderSummary(liveProvider ? { ...liveProvider, enabled: true } : undefined);
  const authEmail = liveProvider?.auth.email;
  const hasAuthenticatedEmail =
    liveProvider?.auth.status === "authenticated" && Boolean(authEmail?.trim());
  const authenticatedDetail = hasAuthenticatedEmail
    ? (liveProvider?.auth.label ?? liveProvider?.auth.type ?? null)
    : null;
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const FallbackIconComponent = driverOption?.icon;
  const displayName =
    instance.displayName?.trim() || driverOption?.label || String(instance.driver);
  const accentColor = normalizeProviderAccentColor(instance.accentColor);

  // Narrow `instance.driver` for callers that key on the closed
  // `ProviderDriverKind` union (e.g. `normalizeModelSlug`'s alias table). Custom
  // fork drivers pass through as `null` and those callers fall back to
  // verbatim behaviour.
  const driverKind: ProviderDriverKind | null = isProviderDriverKind(instance.driver)
    ? instance.driver
    : null;

  const customModels = readConfigStringArray(instance.config, "customModels");
  // Server-returned models may lag behind settings writes. Treat probe
  // models as the source for built-ins only; custom rows come directly
  // from the current instance config so add/remove reflects immediately.
  const modelsForDisplay = deriveProviderModelsForDisplay({
    liveModels: liveProvider?.models,
    customModels,
  });

  const updateDisplayName = (value: string) => {
    const trimmed = value.trim();
    const { displayName: _omit, ...rest } = instance;
    onUpdate(
      trimmed.length > 0
        ? ({ ...rest, displayName: trimmed } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateEnabled = (value: boolean) => {
    onUpdate({ ...instance, enabled: value });
  };

  const updateMcpEnabled = (value: boolean) => {
    const { mcpEnabled: _omit, ...rest } = instance;
    onUpdate(
      value
        ? (rest as ProviderInstanceConfig)
        : ({ ...rest, mcpEnabled: false } as ProviderInstanceConfig),
    );
  };

  const updateAccentColor = (value: string) => {
    const normalized = normalizeProviderAccentColor(value);
    const { accentColor: _omit, ...rest } = instance;
    onUpdate(
      normalized
        ? ({ ...rest, accentColor: normalized } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateConfig = (nextConfig: Record<string, unknown> | undefined) => {
    const { config: _omit, ...rest } = instance;
    onUpdate(
      nextConfig !== undefined
        ? ({ ...rest, config: nextConfig } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateCustomModels = (next: ReadonlyArray<string>) => {
    const nextConfig = nextConfigBlobWithValue(instance.config, "customModels", [...next]);
    const { config: _omit, ...rest } = instance;
    onUpdate({ ...rest, config: nextConfig } as ProviderInstanceConfig);
  };

  const updateEnvironment = (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => {
    const cleaned = environment.filter((variable) => variable.name.trim().length > 0);
    const { environment: _omit, ...rest } = instance;
    onUpdate(
      cleaned.length > 0
        ? ({ ...rest, environment: cleaned } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateCustomAgents = (customAgents: ReadonlyArray<ProviderCustomAgent>) => {
    const { customAgents: _omit, ...rest } = instance;
    onUpdate(
      customAgents.length > 0
        ? ({ ...rest, customAgents: [...customAgents] } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  return (
    <div
      className="border-t border-border first:border-t-0"
      data-provider-instance-card={instanceId}
    >
      <div className="px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-h-5 items-center gap-1.5">
              {driverKind ? (
                <ProviderInstanceIcon
                  driverKind={driverKind}
                  displayName={displayName}
                  accentColor={accentColor}
                  showBadge={Boolean(accentColor)}
                  statusDotClassName={statusStyle.dot}
                  className="size-5"
                  iconClassName="size-4 text-foreground/80"
                  badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 text-[7px]"
                />
              ) : FallbackIconComponent ? (
                <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                  <FallbackIconComponent className="size-4 text-foreground/80" aria-hidden />
                  <span
                    className={cn(
                      "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
                      statusStyle.dot,
                    )}
                    aria-hidden
                  />
                </span>
              ) : (
                <span className={cn("size-2 shrink-0 rounded-full", statusStyle.dot)} />
              )}
              <h3 className="truncate text-sm font-medium text-foreground">{displayName}</h3>
              {String(instanceId) !== String(instance.driver) ? (
                // Hide the id chip on a default slot whose id === the
                // driver slug — it's redundant with the driver icon +
                // label. Custom instances (and any instance the user has
                // since renamed) keep the chip so their slug stays
                // visible for copy/paste + disambiguation.
                <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
                  {instanceId}
                </code>
              ) : null}
              {driverOption?.badgeLabel ? (
                <Badge variant="warning" size="sm" className="shrink-0">
                  {driverOption.badgeLabel}
                </Badge>
              ) : null}
              {versionLabel ? (
                <code className="text-xs text-muted-foreground">{versionLabel}</code>
              ) : null}
              {headerAction ? (
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                  {headerAction}
                </span>
              ) : null}
              {onDelete ? (
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="size-5 rounded-sm p-0 text-muted-foreground hover:text-destructive"
                          onClick={onDelete}
                          aria-label={`Delete provider instance ${instanceId}`}
                        >
                          <Trash2Icon className="size-3" />
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">Delete instance</TooltipPopup>
                  </Tooltip>
                </span>
              ) : null}
            </div>
            <p
              className="flex h-4 min-w-0 max-w-full items-center gap-x-1 overflow-hidden whitespace-nowrap text-xs leading-4 text-muted-foreground"
              data-provider-instance-status-line
            >
              {hasAuthenticatedEmail ? (
                <>
                  <span className="shrink-0">Authenticated as</span>
                  <ProviderAuthEmail email={authEmail} />
                  {authenticatedDetail ? (
                    <span className="min-w-0 truncate">· {authenticatedDetail}</span>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="shrink-0">{summary.headline}</span>
                  <ProviderAuthEmail email={authEmail} separator prefix="Email" />
                </>
              )}
              {summary.detail ? <span className="min-w-0 truncate">- {summary.detail}</span> : null}
            </p>
            <div
              className="flex min-w-0 flex-wrap items-center gap-1.5 pt-0.5"
              data-provider-instance-capabilities
            >
              <Badge variant={mcpEnabled ? "success" : "warning"} size="sm">
                MCP servers {mcpEnabled ? "on" : "off"}
              </Badge>
              <Badge variant={customAgentCount > 0 ? "info" : "outline"} size="sm">
                Custom agents{" "}
                {customAgentCount > 0 ? `${enabledCustomAgentCount}/${customAgentCount}` : "none"}
              </Badge>
            </div>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onExpandedChange(!isExpanded)}
              aria-label={`Toggle ${displayName} details`}
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
              />
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Switch
                    checked={enabled}
                    onCheckedChange={(checked) => updateEnabled(Boolean(checked))}
                    aria-label={`Toggle ${displayName}`}
                  />
                }
              />
              <TooltipPopup side="top">Toggle provider</TooltipPopup>
            </Tooltip>
          </div>
        </div>
      </div>

      <Collapsible open={isExpanded} onOpenChange={onExpandedChange}>
        <CollapsibleContent>
          <div className="space-y-0">
            {detailMode === "all" ? (
              <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                <label htmlFor={`provider-instance-${instanceId}-display-name`} className="block">
                  <span className="text-xs font-medium text-foreground">Display name</span>
                  <DraftInput
                    id={`provider-instance-${instanceId}-display-name`}
                    className="mt-1.5"
                    value={instance.displayName ?? ""}
                    onCommit={updateDisplayName}
                    placeholder={driverOption?.label ?? "Instance label"}
                    spellCheck={false}
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Optional label shown in the provider list.
                  </span>
                </label>
              </div>
            ) : null}

            {detailMode === "all" ? (
              <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                <ProviderAccentColorPicker
                  displayName={displayName}
                  value={accentColor}
                  onCommit={updateAccentColor}
                />
              </div>
            ) : null}

            {detailMode === "all" || detailMode === "mcp" ? (
              <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                <ProviderMcpSection enabled={mcpEnabled} onChange={updateMcpEnabled} />
              </div>
            ) : null}

            {detailMode === "all" ? (
              <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                <ProviderEnvironmentSection
                  environment={instance.environment ?? []}
                  onChange={updateEnvironment}
                />
              </div>
            ) : null}

            {detailMode === "all" || detailMode === "agents" ? (
              <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                <ProviderCustomAgentsSection
                  providerInstanceId={instanceId}
                  customAgents={instance.customAgents ?? []}
                  driverKind={driverKind}
                  onChange={updateCustomAgents}
                />
              </div>
            ) : null}

            {detailMode === "all" && driverOption ? (
              <ProviderSettingsForm
                definition={driverOption}
                value={instance.config}
                idPrefix={`provider-instance-${instanceId}`}
                variant="card"
                onChange={updateConfig}
              />
            ) : null}

            {detailMode === "all" && driverOption !== undefined ? (
              <ProviderModelsSection
                instanceId={instanceId}
                driverKind={driverKind}
                models={modelsForDisplay}
                customModels={customModels}
                hiddenModels={hiddenModels}
                favoriteModels={favoriteModels}
                modelOrder={modelOrder}
                onChange={updateCustomModels}
                onHiddenModelsChange={onHiddenModelsChange}
                onFavoriteModelsChange={onFavoriteModelsChange}
                onModelOrderChange={onModelOrderChange}
              />
            ) : detailMode === "all" ? (
              <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                <p className="text-xs text-muted-foreground">
                  This instance uses a driver (
                  <code className="text-foreground">{String(instance.driver)}</code>) that is not
                  shipped with the current build. Configuration values are preserved but cannot be
                  edited from this surface.
                </p>
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
