import type {
  OrchestrationThreadActivity,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import {
  parseCodexUsageAccountSnapshot,
  pickLatestCodexUsageAccountSnapshot,
  type CodexUsageAccountSnapshot,
} from "./codexUsage";
import { deriveLatestContextWindowSnapshot, type ContextWindowSnapshot } from "./contextWindow";

export interface ProviderUsageSnapshot {
  readonly entry: ProviderInstanceEntry;
  readonly accountUsage: CodexUsageAccountSnapshot | null;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly tokenUsage: ProviderTokenUsageSnapshot;
  readonly updatedAt: string | null;
}

export interface ProviderTokenUsageTotals {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
}

export interface ProviderModelTokenUsage {
  readonly model: string;
  readonly totals: ProviderTokenUsageTotals;
}

export interface ProviderTokenUsageSnapshot {
  readonly totals: ProviderTokenUsageTotals;
  readonly models: ReadonlyArray<ProviderModelTokenUsage>;
}

export function hasReportedProviderAccountUsage(snapshot: ProviderUsageSnapshot): boolean {
  return (snapshot.accountUsage?.limits.length ?? 0) > 0;
}

export function hasReportedProviderTokenUsage(snapshot: ProviderUsageSnapshot): boolean {
  return hasProviderTokenUsageTotals(snapshot.tokenUsage.totals);
}

interface UsageProviderRef {
  readonly provider: ProviderDriverKind | null;
  readonly providerInstanceId: ProviderInstanceId | null;
}

interface MutableProviderUsageSnapshot {
  accountUsage: CodexUsageAccountSnapshot | null;
  contextWindow: ContextWindowSnapshot | null;
  tokenUsageTotals: ProviderTokenUsageTotals;
  tokenUsageByModel: Map<string, ProviderTokenUsageTotals>;
}

export const EMPTY_PROVIDER_TOKEN_USAGE_TOTALS: ProviderTokenUsageTotals = {
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
};

interface ModelPricing {
  readonly inputUsdPerMillion: number;
  readonly cacheCreationInputUsdPerMillion?: number;
  readonly cachedInputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly largeContextThresholdInputTokens?: number;
  readonly largeContextPricing?: ModelPricing;
}

const OPENAI_MODEL_PRICING: ReadonlyArray<{
  readonly match: RegExp;
  readonly pricing: ModelPricing;
}> = [
  {
    match: /^(?:gpt-)?5\.5(?:$|[-.])/,
    pricing: {
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 30,
      largeContextThresholdInputTokens: 272_000,
      largeContextPricing: {
        inputUsdPerMillion: 10,
        cachedInputUsdPerMillion: 1,
        outputUsdPerMillion: 45,
      },
    },
  },
  {
    match: /^gpt-5\.4-mini(?:$|[-.])/,
    pricing: {
      inputUsdPerMillion: 0.75,
      cachedInputUsdPerMillion: 0.075,
      outputUsdPerMillion: 4.5,
    },
  },
  {
    match: /^gpt-5\.4(?:$|[-.])/,
    pricing: {
      inputUsdPerMillion: 2.5,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
      largeContextThresholdInputTokens: 272_000,
      largeContextPricing: {
        inputUsdPerMillion: 5,
        cachedInputUsdPerMillion: 0.5,
        outputUsdPerMillion: 22.5,
      },
    },
  },
  {
    match: /^gpt-5\.3(?:$|[-.])|^gpt-5\.2(?:$|[-.])/,
    pricing: {
      inputUsdPerMillion: 1.75,
      cachedInputUsdPerMillion: 0.175,
      outputUsdPerMillion: 14,
    },
  },
  {
    match: /^gpt-5\.1-codex-mini(?:$|[-.])|^gpt-5-mini(?:$|[-.])/,
    pricing: {
      inputUsdPerMillion: 0.25,
      cachedInputUsdPerMillion: 0.025,
      outputUsdPerMillion: 2,
    },
  },
  {
    match: /^codex-mini-latest(?:$|[-.])/,
    pricing: {
      inputUsdPerMillion: 1.5,
      cachedInputUsdPerMillion: 0.375,
      outputUsdPerMillion: 6,
    },
  },
  {
    match: /^gpt-5(?:$|[-.])|^gpt-5\.1(?:$|[-.])/,
    pricing: {
      inputUsdPerMillion: 1.25,
      cachedInputUsdPerMillion: 0.125,
      outputUsdPerMillion: 10,
    },
  },
];

const ANTHROPIC_MODEL_PRICING: ReadonlyArray<{
  readonly match: RegExp;
  readonly pricing: ModelPricing;
}> = [
  {
    match: /opus[-.]4[-.][56]/,
    pricing: {
      inputUsdPerMillion: 5,
      cacheCreationInputUsdPerMillion: 6.25,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 25,
    },
  },
  {
    match: /sonnet[-.]4[-.]6/,
    pricing: {
      inputUsdPerMillion: 3,
      cacheCreationInputUsdPerMillion: 3.75,
      cachedInputUsdPerMillion: 0.3,
      outputUsdPerMillion: 15,
    },
  },
  {
    match: /sonnet[-.]4[-.]5/,
    pricing: {
      inputUsdPerMillion: 3,
      cacheCreationInputUsdPerMillion: 3.75,
      cachedInputUsdPerMillion: 0.3,
      outputUsdPerMillion: 15,
      largeContextThresholdInputTokens: 200_000,
      largeContextPricing: {
        inputUsdPerMillion: 6,
        cacheCreationInputUsdPerMillion: 7.5,
        cachedInputUsdPerMillion: 0.6,
        outputUsdPerMillion: 22.5,
      },
    },
  },
  {
    match: /haiku[-.]4[-.]5/,
    pricing: {
      inputUsdPerMillion: 1,
      cacheCreationInputUsdPerMillion: 1.25,
      cachedInputUsdPerMillion: 0.1,
      outputUsdPerMillion: 5,
    },
  },
  {
    match: /opus[-.]4[-.]1|opus[-.]4(?:$|[-.])/,
    pricing: {
      inputUsdPerMillion: 15,
      cacheCreationInputUsdPerMillion: 18.75,
      cachedInputUsdPerMillion: 1.5,
      outputUsdPerMillion: 75,
    },
  },
  {
    match: /sonnet[-.]4(?:$|[-.])|sonnet[-.]3[-.][57]/,
    pricing: {
      inputUsdPerMillion: 3,
      cacheCreationInputUsdPerMillion: 3.75,
      cachedInputUsdPerMillion: 0.3,
      outputUsdPerMillion: 15,
    },
  },
  {
    match: /haiku[-.]3[-.]5/,
    pricing: {
      inputUsdPerMillion: 0.8,
      cacheCreationInputUsdPerMillion: 1,
      cachedInputUsdPerMillion: 0.08,
      outputUsdPerMillion: 4,
    },
  },
  {
    match: /haiku[-.]3(?:$|[-.])/,
    pricing: {
      inputUsdPerMillion: 0.25,
      cacheCreationInputUsdPerMillion: 0.3,
      cachedInputUsdPerMillion: 0.03,
      outputUsdPerMillion: 1.25,
    },
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumberRecordValue(
  record: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
) {
  for (const key of keys) {
    const value = readFiniteNumber(record?.[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function normalizeModelForPricing(model: string | null | undefined): string | null {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return normalized.includes("/") ? (normalized.split("/").at(-1) ?? normalized) : normalized;
}

function resolveModelPricing(model: string | null | undefined): ModelPricing | null {
  const normalized = normalizeModelForPricing(model);
  if (!normalized) {
    return null;
  }

  for (const candidate of [...OPENAI_MODEL_PRICING, ...ANTHROPIC_MODEL_PRICING]) {
    if (candidate.match.test(normalized)) {
      return candidate.pricing;
    }
  }
  return null;
}

export function estimateProviderTotalTokenCostUsd(
  model: string | null | undefined,
  totalTokens: number,
): number | null {
  const pricing = resolveModelPricing(model);
  if (!pricing || !Number.isFinite(totalTokens) || totalTokens <= 0) {
    return null;
  }
  return (totalTokens * pricing.inputUsdPerMillion) / 1_000_000;
}

function estimateUsageCostUsd(
  totals: Omit<ProviderTokenUsageTotals, "estimatedCostUsd">,
  model: string | null | undefined,
): number | null {
  const basePricing = resolveModelPricing(model);
  if (!basePricing) {
    return null;
  }
  const pricing =
    basePricing.largeContextThresholdInputTokens !== undefined &&
    totals.inputTokens > basePricing.largeContextThresholdInputTokens &&
    basePricing.largeContextPricing
      ? basePricing.largeContextPricing
      : basePricing;

  const cachedInputTokens = Math.max(0, totals.cachedInputTokens);
  const cacheCreationInputTokens = Math.max(0, totals.cacheCreationInputTokens);
  const standardInputTokens = Math.max(
    0,
    totals.inputTokens - cachedInputTokens - cacheCreationInputTokens,
  );
  const outputTokens = Math.max(0, totals.outputTokens + totals.reasoningOutputTokens);
  const cacheCreationInputUsdPerMillion =
    pricing.cacheCreationInputUsdPerMillion ?? pricing.inputUsdPerMillion;

  return (
    (standardInputTokens * pricing.inputUsdPerMillion +
      cacheCreationInputTokens * cacheCreationInputUsdPerMillion +
      cachedInputTokens * pricing.cachedInputUsdPerMillion +
      outputTokens * pricing.outputUsdPerMillion) /
    1_000_000
  );
}

function readUsageProviderRef(payload: unknown): UsageProviderRef {
  const record = asRecord(payload);
  return {
    provider: readString(record?.provider) as ProviderDriverKind | null,
    providerInstanceId: readString(record?.providerInstanceId) as ProviderInstanceId | null,
  };
}

function compareIsoDate(left: string | null, right: string | null): number {
  const leftTime = left ? Date.parse(left) : Number.NaN;
  const rightTime = right ? Date.parse(right) : Number.NaN;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (left && !right) return 1;
  if (!left && right) return -1;
  return 0;
}

function pickLatestContextWindow(
  left: ContextWindowSnapshot | null,
  right: ContextWindowSnapshot | null,
): ContextWindowSnapshot | null {
  if (!left) return right;
  if (!right) return left;
  return compareIsoDate(left.updatedAt, right.updatedAt) >= 0 ? left : right;
}

function resolveUsageEntry(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  entriesByInstanceId: ReadonlyMap<ProviderInstanceId, ProviderInstanceEntry>,
  ref: UsageProviderRef,
  fallbackProvider: ProviderDriverKind | null,
): ProviderInstanceEntry | null {
  if (ref.providerInstanceId) {
    return entriesByInstanceId.get(ref.providerInstanceId) ?? null;
  }

  const provider = ref.provider ?? fallbackProvider;
  if (!provider) {
    return null;
  }

  return entries.find((entry) => entry.driverKind === provider) ?? null;
}

function latestUpdatedAt(
  accountUsage: CodexUsageAccountSnapshot | null,
  contextWindow: ContextWindowSnapshot | null,
): string | null {
  const accountUpdatedAt = accountUsage?.updatedAt ?? null;
  const contextUpdatedAt = contextWindow?.updatedAt ?? null;
  return compareIsoDate(accountUpdatedAt, contextUpdatedAt) >= 0
    ? accountUpdatedAt
    : contextUpdatedAt;
}

function turnUsageKey(activity: OrchestrationThreadActivity): string | null {
  return activity.turnId ? `${activity.turnId}` : null;
}

export function addProviderTokenUsageTotals(
  left: ProviderTokenUsageTotals,
  right: ProviderTokenUsageTotals,
): ProviderTokenUsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedCostUsd: left.estimatedCostUsd + right.estimatedCostUsd,
  };
}

export function hasProviderTokenUsageTotals(totals: ProviderTokenUsageTotals): boolean {
  return (
    totals.inputTokens > 0 ||
    totals.cacheCreationInputTokens > 0 ||
    totals.cachedInputTokens > 0 ||
    totals.outputTokens > 0 ||
    totals.reasoningOutputTokens > 0 ||
    totals.totalTokens > 0 ||
    totals.estimatedCostUsd > 0
  );
}

function readUsageTotals(
  value: unknown,
  model: string | null = null,
): ProviderTokenUsageTotals | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const usage = asRecord(record.usage) ?? record;
  const cacheCreationInputTokens =
    readNumberRecordValue(usage, ["cacheCreationInputTokens", "cache_creation_input_tokens"]) ?? 0;
  const canonicalCachedInputTokens = readNumberRecordValue(usage, [
    "cachedInputTokens",
    "lastCachedInputTokens",
  ]);
  const providerCacheReadInputTokens =
    readNumberRecordValue(usage, ["cacheReadInputTokens", "cache_read_input_tokens"]) ?? 0;
  const cachedInputTokens = canonicalCachedInputTokens ?? providerCacheReadInputTokens;
  const canonicalInputTokens = readNumberRecordValue(usage, ["inputTokens", "lastInputTokens"]);
  const providerInputTokens = readNumberRecordValue(usage, ["input_tokens"]) ?? 0;
  const inputTokens =
    canonicalInputTokens ?? providerInputTokens + cacheCreationInputTokens + cachedInputTokens;
  const outputTokens =
    readNumberRecordValue(usage, ["outputTokens", "lastOutputTokens", "output_tokens"]) ?? 0;
  const reasoningOutputTokens =
    readNumberRecordValue(usage, [
      "reasoningOutputTokens",
      "lastReasoningOutputTokens",
      "reasoning_output_tokens",
    ]) ?? 0;
  const totalTokens =
    readNumberRecordValue(usage, [
      "totalTokens",
      "total_tokens",
      "totalProcessedTokens",
      "usedTokens",
      "lastUsedTokens",
    ]) ?? inputTokens + outputTokens + reasoningOutputTokens;
  const estimatedCostUsd =
    estimateUsageCostUsd(
      {
        inputTokens,
        cacheCreationInputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens,
      },
      model,
    ) ??
    readNumberRecordValue(record, ["totalCostUsd", "total_cost_usd", "costUsd", "cost_usd"]) ??
    0;
  const totals = {
    inputTokens,
    cacheCreationInputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    estimatedCostUsd,
  };
  return hasProviderTokenUsageTotals(totals) ? totals : null;
}

function readContextWindowDeltaTotals(
  payload: unknown,
  model: string | null,
): ProviderTokenUsageTotals | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const hasLastCounters =
    readFiniteNumber(record.lastInputTokens) !== null ||
    readFiniteNumber(record.lastCacheCreationInputTokens) !== null ||
    readFiniteNumber(record.lastCachedInputTokens) !== null ||
    readFiniteNumber(record.lastOutputTokens) !== null ||
    readFiniteNumber(record.lastReasoningOutputTokens) !== null ||
    readFiniteNumber(record.lastUsedTokens) !== null;
  if (!hasLastCounters) {
    return null;
  }
  return readUsageTotals(
    {
      inputTokens: record.lastInputTokens,
      cacheCreationInputTokens: record.lastCacheCreationInputTokens,
      cachedInputTokens: record.lastCachedInputTokens,
      outputTokens: record.lastOutputTokens,
      reasoningOutputTokens: record.lastReasoningOutputTokens,
      totalTokens: record.lastUsedTokens,
    },
    model,
  );
}

function readModelLabel(payload: unknown, fallback: string | null): string | null {
  const record = asRecord(payload);
  const directModel = readString(record?.model);
  if (directModel) {
    return directModel;
  }
  const modelSelection = asRecord(record?.modelSelection);
  const selectedModel = readString(modelSelection?.model);
  if (selectedModel) {
    return selectedModel;
  }
  const modelUsage = asRecord(record?.modelUsage);
  const modelUsageKeys = modelUsage ? Object.keys(modelUsage).filter((key) => key.trim()) : [];
  if (modelUsageKeys.length === 1 && modelUsageKeys[0]) {
    return modelUsageKeys[0];
  }
  return fallback;
}

function publishTokenTotals(
  snapshot: MutableProviderUsageSnapshot,
  model: string | null,
  totals: ProviderTokenUsageTotals,
) {
  snapshot.tokenUsageTotals = addProviderTokenUsageTotals(snapshot.tokenUsageTotals, totals);
  if (!model) {
    return;
  }
  snapshot.tokenUsageByModel.set(
    model,
    addProviderTokenUsageTotals(
      snapshot.tokenUsageByModel.get(model) ?? EMPTY_PROVIDER_TOKEN_USAGE_TOTALS,
      totals,
    ),
  );
}

function freezeTokenUsage(
  totals: ProviderTokenUsageTotals,
  usageByModel: ReadonlyMap<string, ProviderTokenUsageTotals>,
): ProviderTokenUsageSnapshot {
  const models = Array.from(usageByModel.entries())
    .map(([model, totals]) => ({ model, totals }))
    .toSorted((left, right) => right.totals.totalTokens - left.totals.totalTokens);
  return {
    totals,
    models,
  };
}

export function deriveProviderUsageSnapshots(
  providers: ReadonlyArray<ServerProvider>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<ProviderUsageSnapshot> {
  const entries = deriveProviderInstanceEntries(providers).filter(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const entriesByInstanceId = new Map(entries.map((entry) => [entry.instanceId, entry]));
  const usageByInstanceId = new Map<ProviderInstanceId, MutableProviderUsageSnapshot>();

  for (const entry of entries) {
    const usage = entry.snapshot.usage
      ? parseCodexUsageAccountSnapshot(
          entry.snapshot.usage.rateLimits,
          entry.snapshot.usage.checkedAt,
        )
      : null;
    usageByInstanceId.set(entry.instanceId, {
      accountUsage: usage,
      contextWindow: null,
      tokenUsageTotals: EMPTY_PROVIDER_TOKEN_USAGE_TOTALS,
      tokenUsageByModel: new Map(),
    });
  }

  const turnModelByTurnId = new Map<string, string>();
  const turnIdsWithCompletionUsage = new Set<string>();

  for (const activity of activities) {
    const key = turnUsageKey(activity);
    if (activity.kind === "usage.turn.started" && key) {
      const model = readModelLabel(activity.payload, null);
      if (model) {
        turnModelByTurnId.set(key, model);
      }
      continue;
    }
    if (activity.kind === "usage.turn.completed" && key && readUsageTotals(activity.payload)) {
      turnIdsWithCompletionUsage.add(key);
    }
  }

  for (const activity of activities) {
    if (activity.kind === "usage.turn.started") {
      continue;
    }

    if (activity.kind === "usage.turn.completed") {
      const ref = readUsageProviderRef(activity.payload);
      const entry = resolveUsageEntry(entries, entriesByInstanceId, ref, null);
      if (!entry) {
        continue;
      }
      const key = turnUsageKey(activity);
      const model = readModelLabel(
        activity.payload,
        key ? (turnModelByTurnId.get(key) ?? null) : null,
      );
      const totals = readUsageTotals(activity.payload, model);
      if (!totals) {
        continue;
      }
      const current = usageByInstanceId.get(entry.instanceId);
      if (!current) {
        continue;
      }
      publishTokenTotals(current, model, totals);
      continue;
    }

    if (activity.kind === "account.rate-limits.updated") {
      const ref = readUsageProviderRef(activity.payload);
      const entry = resolveUsageEntry(
        entries,
        entriesByInstanceId,
        ref,
        "codex" as ProviderDriverKind,
      );
      if (!entry) {
        continue;
      }
      const snapshot = parseCodexUsageAccountSnapshot(activity.payload, activity.createdAt);
      if (!snapshot) {
        continue;
      }
      const current = usageByInstanceId.get(entry.instanceId);
      if (!current) {
        continue;
      }
      current.accountUsage = pickLatestCodexUsageAccountSnapshot([current.accountUsage, snapshot]);
      continue;
    }

    if (activity.kind === "context-window.updated") {
      const ref = readUsageProviderRef(activity.payload);
      const entry = resolveUsageEntry(
        entries,
        entriesByInstanceId,
        ref,
        "codex" as ProviderDriverKind,
      );
      if (!entry) {
        continue;
      }
      const snapshot = deriveLatestContextWindowSnapshot([activity]);
      if (!snapshot) {
        continue;
      }
      const current = usageByInstanceId.get(entry.instanceId);
      if (!current) {
        continue;
      }
      current.contextWindow = pickLatestContextWindow(current.contextWindow, snapshot);

      const key = turnUsageKey(activity);
      if (key && turnIdsWithCompletionUsage.has(key)) {
        continue;
      }
      const model = readModelLabel(
        activity.payload,
        key ? (turnModelByTurnId.get(key) ?? null) : null,
      );
      const deltaTotals = readContextWindowDeltaTotals(activity.payload, model);
      if (deltaTotals) {
        publishTokenTotals(current, model, deltaTotals);
      }
    }
  }

  return entries.map((entry) => {
    const usage = usageByInstanceId.get(entry.instanceId) ?? {
      accountUsage: null,
      contextWindow: null,
      tokenUsageTotals: EMPTY_PROVIDER_TOKEN_USAGE_TOTALS,
      tokenUsageByModel: new Map<string, ProviderTokenUsageTotals>(),
    };
    return {
      entry,
      accountUsage: usage.accountUsage,
      contextWindow: usage.contextWindow,
      tokenUsage: freezeTokenUsage(usage.tokenUsageTotals, usage.tokenUsageByModel),
      updatedAt: latestUpdatedAt(usage.accountUsage, usage.contextWindow),
    } satisfies ProviderUsageSnapshot;
  });
}
