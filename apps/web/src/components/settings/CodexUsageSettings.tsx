import type { ReactNode } from "react";

import {
  formatCodexUsageLimitTitle,
  formatCodexUsageRemainingLabel,
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
  readonly baseTitle: string;
  readonly title: string;
  readonly providerName: string;
  readonly windows: ReadonlyArray<CodexUsageWindowDescriptor>;
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

function UsageLimitRows({ windows }: { windows: ReadonlyArray<CodexUsageWindowDescriptor> }) {
  return windows.map((window) => {
    const reset = formatCodexUsageReset(window.usage.resetsAt);
    return (
      <CompactUsageRow
        key={window.key}
        title={formatCodexUsageWindowLimitLabel(window)}
        description={reset ? `Resets ${reset}` : "Reset time unavailable"}
        control={<UsageProgress window={window} />}
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
          <UsageLimitRows windows={section.windows} />
        </div>
      </div>
    </section>
  );
}

function buildUsageLimitSections(
  providerUsage: ReadonlyArray<ProviderUsageSnapshot>,
): ReadonlyArray<UsageLimitSectionDescriptor> {
  const candidates = providerUsage.flatMap((snapshot) =>
    (snapshot.accountUsage?.limits ?? []).flatMap((limit: CodexUsageLimitSnapshot) => {
      const windows = getCodexUsageWindows(limit);
      if (windows.length === 0) {
        return [];
      }

      const baseTitle = formatCodexUsageLimitTitle(limit);
      return [
        {
          key: `${snapshot.entry.instanceId}:${limit.key}`,
          baseTitle,
          providerName: snapshot.entry.displayName,
          windows,
        },
      ];
    }),
  );

  const titleCounts = new Map<string, number>();
  for (const section of candidates) {
    titleCounts.set(section.baseTitle, (titleCounts.get(section.baseTitle) ?? 0) + 1);
  }

  return candidates.map((section) => {
    const isDuplicateTitle = (titleCounts.get(section.baseTitle) ?? 0) > 1;
    return {
      key: section.key,
      baseTitle: section.baseTitle,
      title: isDuplicateTitle
        ? `${section.baseTitle} (${section.providerName})`
        : section.baseTitle,
      providerName: section.providerName,
      windows: section.windows,
    };
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
