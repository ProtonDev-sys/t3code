import type { ReactNode } from "react";

import {
  formatCodexUsageLimitTitle,
  formatCodexUsageRemainingLabel,
  formatCodexUsageRunoutEstimate,
  formatCodexUsageReset,
  formatCodexUsageWindowLimitLabel,
  getCodexUsageRemainingPercent,
  getCodexUsageWindows,
  type CodexUsageLimitSnapshot,
  type CodexUsageWindowDescriptor,
} from "../../lib/codexUsage";
import { useProviderUsageSnapshots } from "../../hooks/useCodexUsage";
import { type ProviderUsageSnapshot } from "../../lib/providerUsage";
import { SettingsPageContainer } from "./settingsLayout";

interface UsageLimitSectionDescriptor {
  readonly key: string;
  readonly title: string;
  readonly rows: ReadonlyArray<UsageLimitRowDescriptor>;
}

interface UsageLimitRowDescriptor {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly runoutEstimate: string | null;
  readonly window: CodexUsageWindowDescriptor;
}

function UsageProgress({ window }: { window: CodexUsageWindowDescriptor }) {
  const remainingPercent = getCodexUsageRemainingPercent(window.usage);
  const width = `${remainingPercent ?? 0}%`;

  return (
    <div className="flex min-w-36 items-center justify-end gap-3">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="h-full rounded-full bg-foreground" style={{ width }} />
      </div>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatCodexUsageRemainingLabel(window.usage) ?? "-"}
      </span>
    </div>
  );
}

function CompactUsageRow({
  control,
  description,
  title,
}: {
  control: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 py-3">
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground text-sm">{title}</div>
        <div className="mt-0.5 truncate text-muted-foreground text-xs">{description}</div>
      </div>
      {control}
    </div>
  );
}

function UsageLimitRows({ rows }: { rows: ReadonlyArray<UsageLimitRowDescriptor> }) {
  return rows.map((row) => {
    const description = [
      row.description,
      row.runoutEstimate ? `depletes ${row.runoutEstimate}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <CompactUsageRow
        key={row.key}
        title={row.title}
        description={description}
        control={<UsageProgress window={row.window} />}
      />
    );
  });
}

function UsageLimitSection({ section }: { section: UsageLimitSectionDescriptor }) {
  return (
    <section className="space-y-3">
      <h2 className="px-0 font-semibold text-foreground text-sm">{section.title}</h2>
      <div className="overflow-hidden rounded-lg border border-border/70 bg-card/45">
        <div className="divide-y divide-border/60">
          <UsageLimitRows rows={section.rows} />
        </div>
      </div>
    </section>
  );
}

function formatProviderScopedLimitTitle(
  limit: CodexUsageLimitSnapshot,
  providerName: string,
): string {
  const suffix = " usage limits";
  const title = formatCodexUsageLimitTitle(limit);
  const baseTitle = title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
  const providerPrefix = `${providerName} `;
  const scopedTitle = baseTitle.toLowerCase().startsWith(providerPrefix.toLowerCase())
    ? baseTitle.slice(providerPrefix.length)
    : baseTitle;
  return scopedTitle.charAt(0).toUpperCase() + scopedTitle.slice(1);
}

function formatUsageLimitRow(input: {
  readonly limit: CodexUsageLimitSnapshot;
  readonly providerName: string;
  readonly window: CodexUsageWindowDescriptor;
  readonly windowCount: number;
  readonly limitUpdatedAt: string | null;
}): Omit<UsageLimitRowDescriptor, "key" | "window"> {
  const baseTitle = formatProviderScopedLimitTitle(input.limit, input.providerName);
  const windowTitle = formatCodexUsageWindowLimitLabel(input.window);
  const reset = formatCodexUsageReset(input.window.usage.resetsAt);
  const runoutEstimate = formatCodexUsageRunoutEstimate(input.window.usage, input.limitUpdatedAt);
  return {
    title: input.windowCount > 1 ? `${baseTitle} - ${windowTitle}` : baseTitle,
    description: reset ? `${windowTitle} - Resets ${reset}` : windowTitle,
    runoutEstimate,
  };
}

function buildUsageLimitSections(
  providerUsage: ReadonlyArray<ProviderUsageSnapshot>,
): ReadonlyArray<UsageLimitSectionDescriptor> {
  return providerUsage.flatMap((snapshot) => {
    const rows = (snapshot.accountUsage?.limits ?? []).flatMap((limit: CodexUsageLimitSnapshot) => {
      const windows = getCodexUsageWindows(limit);
      return windows.map((window) => {
        const row = formatUsageLimitRow({
          limit,
          providerName: snapshot.entry.displayName,
          window,
          windowCount: windows.length,
          limitUpdatedAt: snapshot.updatedAt,
        });
        return {
          key: `${limit.key}:${window.key}`,
          title: row.title,
          description: row.description,
          runoutEstimate: row.runoutEstimate,
          window,
        };
      });
    });

    return rows.length > 0
      ? [
          {
            key: snapshot.entry.instanceId,
            title: snapshot.entry.displayName,
            rows,
          },
        ]
      : [];
  });
}

function NoUsageLimits({ providerUsage }: { providerUsage: ReadonlyArray<ProviderUsageSnapshot> }) {
  const hasProviders = providerUsage.length > 0;
  const hasOnlyCopilotProviders =
    hasProviders &&
    providerUsage.every((snapshot) => String(snapshot.entry.driverKind) === "copilot");
  const title = hasProviders ? "No account-limit data" : "No providers";
  const description = hasOnlyCopilotProviders
    ? "Copilot has not reported account usage-limit windows yet."
    : hasProviders
      ? "No enabled provider has reported remaining account usage limits."
      : "No enabled providers are available.";

  return (
    <section className="space-y-3">
      <h2 className="font-semibold text-foreground text-sm">Usage limits</h2>
      <div className="overflow-hidden rounded-lg border border-border/70 bg-card/45">
        <CompactUsageRow
          title={title}
          description={description}
          control={<span className="text-xs text-muted-foreground">Unavailable</span>}
        />
      </div>
    </section>
  );
}

export function CodexUsageSettingsPanel() {
  const providerUsage = useProviderUsageSnapshots();
  const usageLimitSections = buildUsageLimitSections(providerUsage);

  return (
    <SettingsPageContainer>
      <header className="space-y-1">
        <h1 className="font-semibold text-foreground text-xl tracking-tight">Usage</h1>
      </header>
      {usageLimitSections.length > 0 ? (
        <>
          {usageLimitSections.map((section) => (
            <UsageLimitSection key={section.key} section={section} />
          ))}
        </>
      ) : (
        <NoUsageLimits providerUsage={providerUsage} />
      )}
    </SettingsPageContainer>
  );
}
