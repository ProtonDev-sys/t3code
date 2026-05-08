import {
  type EnvironmentId,
  type FilesystemBrowseEntry,
  type KeybindingCommand,
  type ThreadId,
} from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { type ReactNode } from "react";
import { sortThreads } from "../lib/threadSort";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { type Project, type SidebarThreadSummary, type Thread } from "../types";

export const RECENT_THREAD_LIMIT = 12;
export const COMMAND_PALETTE_SEARCH_RESULT_LIMIT = 60;
export const COMMAND_PALETTE_THREAD_PREWARM_LIMIT = 6;
export const ITEM_ICON_CLASS = "size-4 text-muted-foreground/80";
export const ADDON_ICON_CLASS = "size-4";
export type CommandPaletteAdornment = ReactNode | (() => ReactNode);

export interface CommandPaletteThreadPrewarmRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export interface CommandPaletteItem {
  readonly kind: "action" | "submenu";
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  readonly description?: string;
  readonly timestamp?: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  /** Optional content rendered inline before the title text. */
  readonly titleLeadingContent?: CommandPaletteAdornment;
  /** Optional content rendered inline after the title text (before the timestamp). */
  readonly titleTrailingContent?: CommandPaletteAdornment;
  readonly shortcutCommand?: KeybindingCommand;
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly kind: "action";
  readonly keepOpen?: boolean;
  readonly prewarmThreadRef?: CommandPaletteThreadPrewarmRef;
  readonly run: () => Promise<void>;
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItem {
  readonly kind: "submenu";
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
}

export interface CommandPaletteView {
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export type CommandPaletteMode = "root" | "root-browse" | "submenu" | "submenu-browse";

export function filterBrowseEntries(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  browseFilterQuery: string;
  highlightedItemValue: string | null;
}): {
  filteredEntries: FilesystemBrowseEntry[];
  highlightedEntry: FilesystemBrowseEntry | null;
  exactEntry: FilesystemBrowseEntry | null;
} {
  const lowerFilter = input.browseFilterQuery.toLowerCase();
  const showHidden = input.browseFilterQuery.startsWith(".");

  const filteredEntries = input.browseEntries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerFilter) &&
      (showHidden || !entry.name.startsWith(".")),
  );

  let highlightedEntry: FilesystemBrowseEntry | null = null;
  if (input.highlightedItemValue?.startsWith("browse:")) {
    const highlightedPath = input.highlightedItemValue.slice("browse:".length);
    highlightedEntry = filteredEntries.find((entry) => entry.fullPath === highlightedPath) ?? null;
  }

  const exactEntry =
    input.browseFilterQuery.length > 0
      ? (filteredEntries.find((entry) => entry.name === input.browseFilterQuery) ?? null)
      : null;

  return { filteredEntries, highlightedEntry, exactEntry };
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildProjectActionItems(input: {
  projects: ReadonlyArray<Project>;
  valuePrefix: string;
  icon: (project: Project) => ReactNode;
  runProject: (project: Project) => Promise<void>;
}): CommandPaletteActionItem[] {
  return input.projects.map((project) => ({
    kind: "action",
    value: `${input.valuePrefix}:${project.environmentId}:${project.id}`,
    searchTerms: [project.name, project.cwd],
    title: project.name,
    description: project.cwd,
    icon: input.icon(project),
    run: async () => {
      await input.runProject(project);
    },
  }));
}

export type BuildThreadActionItemsThread = Pick<
  SidebarThreadSummary,
  "archivedAt" | "branch" | "createdAt" | "environmentId" | "id" | "projectId" | "title"
> & {
  updatedAt?: string | undefined;
  latestUserMessageAt?: string | null;
};

export function buildThreadActionItems<TThread extends BuildThreadActionItemsThread>(input: {
  threads: ReadonlyArray<TThread>;
  activeThreadId?: Thread["id"];
  projectTitleById: ReadonlyMap<Project["id"], string>;
  sortOrder: SidebarThreadSortOrder;
  icon: ReactNode;
  /** Optional content rendered inline before the title text per-thread. */
  renderLeadingContent?: (thread: TThread) => ReactNode;
  /** Optional content rendered inline after the title text per-thread. */
  renderTrailingContent?: (thread: TThread) => ReactNode;
  runThread: (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) => Promise<void>;
  limit?: number;
}): CommandPaletteActionItem[] {
  const sortedThreads = sortThreads(
    input.threads.filter((thread) => thread.archivedAt === null),
    input.sortOrder,
  );
  const visibleThreads =
    input.limit === undefined ? sortedThreads : sortedThreads.slice(0, input.limit);

  return visibleThreads.map((thread) => {
    const projectTitle = input.projectTitleById.get(thread.projectId);
    const descriptionParts: string[] = [];

    if (projectTitle) {
      descriptionParts.push(projectTitle);
    }
    if (thread.branch) {
      descriptionParts.push(`#${thread.branch}`);
    }
    if (thread.id === input.activeThreadId) {
      descriptionParts.push("Current thread");
    }

    return Object.assign(
      {
        kind: "action" as const,
        value: `thread:${thread.id}`,
        searchTerms: [thread.title, projectTitle ?? ``, thread.branch ?? ``],
        title: thread.title,
        description: descriptionParts.join(` · `),
        timestamp: formatRelativeTimeLabel(
          thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
        ),
        icon: input.icon,
        prewarmThreadRef: {
          environmentId: thread.environmentId,
          threadId: thread.id,
        },
      },
      input.renderLeadingContent
        ? { titleLeadingContent: () => input.renderLeadingContent?.(thread) }
        : {},
      input.renderTrailingContent
        ? { titleTrailingContent: () => input.renderTrailingContent?.(thread) }
        : {},
      {
        run: async () => {
          await input.runThread(thread);
        },
      },
    );
  });
}

interface SearchFieldIndex {
  readonly normalizedField: string;
  readonly wordField: string;
  readonly compactField: string;
  readonly initials: string;
}

interface SearchQueryIndex {
  readonly normalizedQuery: string;
  readonly wordQuery: string;
  readonly compactQuery: string;
}

const MAX_SEARCH_FIELD_INDEX_CACHE_ENTRIES = 5_000;
const searchFieldIndexCache = new Map<string, SearchFieldIndex>();

function getSearchFieldIndex(field: string): SearchFieldIndex {
  const cached = searchFieldIndexCache.get(field);
  if (cached) {
    return cached;
  }

  const index = {
    normalizedField: normalizeSearchText(field),
    wordField: normalizeSearchWords(field),
    compactField: compactSearchText(field),
    initials: getSearchInitials(field),
  };

  if (searchFieldIndexCache.size >= MAX_SEARCH_FIELD_INDEX_CACHE_ENTRIES) {
    const oldestKey = searchFieldIndexCache.keys().next().value;
    if (oldestKey !== undefined) {
      searchFieldIndexCache.delete(oldestKey);
    }
  }
  searchFieldIndexCache.set(field, index);
  return index;
}

function getSearchQueryIndex(normalizedQuery: string): SearchQueryIndex {
  return {
    normalizedQuery,
    wordQuery: normalizeSearchWords(normalizedQuery),
    compactQuery: compactSearchText(normalizedQuery),
  };
}

function rankSearchFieldMatch(field: string, query: SearchQueryIndex): number {
  const { compactField, initials, normalizedField, wordField } = getSearchFieldIndex(field);
  const { compactQuery, normalizedQuery, wordQuery } = query;

  if (
    normalizedField.length === 0 ||
    normalizedQuery.length === 0 ||
    wordQuery.length === 0 ||
    compactQuery.length === 0
  ) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalizedField === normalizedQuery || wordField === wordQuery) {
    return 60;
  }
  if (normalizedField.startsWith(normalizedQuery) || wordField.startsWith(wordQuery)) {
    return 50;
  }
  if (wordField.split(" ").some((word) => word.startsWith(wordQuery))) {
    return 42;
  }
  if (normalizedField.includes(normalizedQuery) || wordField.includes(wordQuery)) {
    return 36;
  }

  if (initials.startsWith(compactQuery)) {
    return 30;
  }
  if (isOrderedSubsequence(compactQuery, compactField)) {
    return 12;
  }

  return Number.NEGATIVE_INFINITY;
}

function normalizeSearchWords(value: string): string {
  return normalizeSearchText(value.replace(/[^\p{L}\p{N}]+/gu, " "));
}

function compactSearchText(value: string): string {
  return normalizeSearchWords(value).replace(/\s+/g, "");
}

function getSearchInitials(value: string): string {
  return normalizeSearchWords(value)
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0] ?? "")
    .join("");
}

function isOrderedSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) {
    return true;
  }

  let needleIndex = 0;
  for (const char of haystack) {
    if (char !== needle[needleIndex]) {
      continue;
    }
    needleIndex += 1;
    if (needleIndex === needle.length) {
      return true;
    }
  }

  return false;
}

function rankCommandPaletteItemMatch(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
  normalizedQuery: string,
): number {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  if (terms.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const normalizedQueryIndex = getSearchQueryIndex(normalizedQuery);
  const queryWords = normalizedQueryIndex.wordQuery.split(" ").filter(Boolean);
  const queries =
    queryWords.length > 1
      ? [normalizedQueryIndex, ...queryWords.map((query) => getSearchQueryIndex(query))]
      : [normalizedQueryIndex];
  let score = 0;

  for (const query of queries) {
    let bestQueryScore = Number.NEGATIVE_INFINITY;
    for (const [index, field] of terms.entries()) {
      const fieldRank = rankSearchFieldMatch(field, query);
      if (fieldRank === Number.NEGATIVE_INFINITY) {
        continue;
      }
      bestQueryScore = Math.max(bestQueryScore, 1_000 - index * 100 + fieldRank);
    }

    if (bestQueryScore === Number.NEGATIVE_INFINITY) {
      return Number.NEGATIVE_INFINITY;
    }
    score += bestQueryScore;
  }

  return Math.round(score / queries.length);
}

export function getCommandPaletteThreadPrewarmRefs(input: {
  groups: ReadonlyArray<CommandPaletteGroup>;
  limit?: number;
}): CommandPaletteThreadPrewarmRef[] {
  const limit = input.limit ?? COMMAND_PALETTE_THREAD_PREWARM_LIMIT;
  if (limit <= 0) {
    return [];
  }

  const refs: CommandPaletteThreadPrewarmRef[] = [];
  const seenKeys = new Set<string>();

  for (const group of input.groups) {
    for (const item of group.items) {
      if (item.kind !== "action" || !item.prewarmThreadRef) {
        continue;
      }

      const key = `${item.prewarmThreadRef.environmentId}:${item.prewarmThreadRef.threadId}`;
      if (seenKeys.has(key)) {
        continue;
      }

      refs.push(item.prewarmThreadRef);
      seenKeys.add(key);
      if (refs.length >= limit) {
        return refs;
      }
    }
  }

  return refs;
}

export function filterCommandPaletteGroups(input: {
  activeGroups: ReadonlyArray<CommandPaletteGroup>;
  query: string;
  isInSubmenu: boolean;
  projectSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const isActionsFilter = input.query.startsWith(">");
  const searchQuery = isActionsFilter ? input.query.slice(1) : input.query;
  const normalizedQuery = normalizeSearchText(searchQuery);

  if (normalizedQuery.length === 0) {
    if (isActionsFilter) {
      return input.activeGroups.filter((group) => group.value === "actions");
    }
    return [...input.activeGroups];
  }

  let baseGroups = [...input.activeGroups];
  if (isActionsFilter) {
    baseGroups = baseGroups.filter((group) => group.value === "actions");
  } else if (!input.isInSubmenu) {
    baseGroups = baseGroups.filter((group) => group.value !== "recent-threads");
  }

  const searchableGroups = [...baseGroups];
  if (!input.isInSubmenu && !isActionsFilter) {
    if (input.projectSearchItems.length > 0) {
      searchableGroups.push({
        value: "projects-search",
        label: "Projects",
        items: input.projectSearchItems,
      });
    }
    if (input.threadSearchItems.length > 0) {
      searchableGroups.push({
        value: "threads-search",
        label: "Threads",
        items: input.threadSearchItems,
      });
    }
  }

  return searchableGroups.flatMap((group) => {
    const items = group.items
      .map((item, index) => {
        const rank = rankCommandPaletteItemMatch(item, normalizedQuery);
        if (rank === Number.NEGATIVE_INFINITY) {
          return null;
        }

        return {
          item,
          index,
          rank,
        };
      })
      .filter(
        (entry): entry is { item: (typeof group.items)[number]; index: number; rank: number } =>
          entry !== null,
      )
      .toSorted((left, right) => right.rank - left.rank || left.index - right.index)
      .slice(0, COMMAND_PALETTE_SEARCH_RESULT_LIMIT)
      .map((entry) => entry.item);

    if (items.length === 0) {
      return [];
    }

    return [{ value: group.value, label: group.label, items }];
  });
}

export function buildBrowseGroups(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  browseQuery: string;
  canBrowseUp: boolean;
  upIcon: ReactNode;
  directoryIcon: ReactNode;
  browseUp: () => void;
  browseTo: (name: string) => void;
}): CommandPaletteGroup[] {
  const items: CommandPaletteActionItem[] = [];

  if (input.canBrowseUp) {
    items.push({
      kind: "action",
      value: "browse:up",
      searchTerms: [input.browseQuery, ".."],
      title: "..",
      icon: input.upIcon,
      keepOpen: true,
      run: async () => {
        input.browseUp();
      },
    });
  }

  for (const entry of input.browseEntries) {
    items.push({
      kind: "action",
      value: `browse:${entry.fullPath}`,
      searchTerms: [input.browseQuery, entry.fullPath, entry.name],
      title: entry.name,
      icon: input.directoryIcon,
      keepOpen: true,
      run: async () => {
        input.browseTo(entry.name);
      },
    });
  }

  return [{ value: "directories", label: "Directories", items }];
}

export function getCommandPaletteMode(input: {
  currentView: CommandPaletteView | null;
  isBrowsing: boolean;
}): CommandPaletteMode {
  if (input.currentView) {
    return input.isBrowsing ? "submenu-browse" : "submenu";
  }
  return input.isBrowsing ? "root-browse" : "root";
}

export function buildRootGroups(input: {
  actionItems: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  recentThreadItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = [];
  if (input.actionItems.length > 0) {
    groups.push({ value: "actions", label: "Actions", items: input.actionItems });
  }
  if (input.recentThreadItems.length > 0) {
    groups.push({
      value: "recent-threads",
      label: "Recent Threads",
      items: input.recentThreadItems,
    });
  }
  return groups;
}

export function getCommandPaletteInputPlaceholder(mode: CommandPaletteMode): string {
  switch (mode) {
    case "root":
      return "Search commands, projects, and threads...";
    case "root-browse":
      return "Enter project path (e.g. ~/projects/my-app)";
    case "submenu":
      return "Search...";
    case "submenu-browse":
      return "Enter path (e.g. ~/projects/my-app)";
  }
}
