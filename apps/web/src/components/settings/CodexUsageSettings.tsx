import { GaugeIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
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
import { useProviderAccountUsageSnapshots } from "../../hooks/useCodexUsage";
import { type ProviderUsageSnapshot } from "../../lib/providerUsage";
import { SettingsPageContainer } from "./settingsLayout";

function UsageProgress({ window }: { window: CodexUsageWindowDescriptor }) {
  const remainingPercent = getCodexUsageRemainingPercent(window.usage);
  const width = `${remainingPercent ?? 0}%`;

  return (
    <div className="flex min-w-32 items-center justify-end gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="h-full rounded-full bg-foreground" style={{ width }} />
      </div>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatCodexUsageRemainingLabel(window.usage) ?? "-"}
      </span>
    </div>
  );
}

function CompactUsageSection({
  children,
  icon,
  title,
}: {
  children: ReactNode;
  icon: ReactNode;
  title: string;
}) {
  return (
    <section className="mx-auto w-full max-w-xl overflow-hidden rounded-lg border border-border/70 bg-card/45">
      <div className="flex items-center gap-2 border-border/60 border-b px-3 py-2">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        <h2 className="min-w-0 truncate font-medium text-foreground text-sm">{title}</h2>
      </div>
      <div className="divide-y divide-border/60">{children}</div>
    </section>
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
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground text-sm">{title}</div>
        <div className="mt-0.5 truncate text-muted-foreground text-xs">{description}</div>
      </div>
      {control}
    </div>
  );
}

function UsageLimitRows({ limit }: { limit: CodexUsageLimitSnapshot }) {
  const windows = getCodexUsageWindows(limit);
  const limitTitle = formatCodexUsageLimitTitle(limit);

  if (windows.length === 0) {
    return (
      <CompactUsageRow
        title={limitTitle}
        description="No active rate-limit windows reported."
        control={<span className="text-xs text-muted-foreground">Unavailable</span>}
      />
    );
  }

  return windows.map((window) => {
    const reset = formatCodexUsageReset(window.usage.resetsAt);
    return (
      <CompactUsageRow
        key={window.key}
        title={
          windows.length > 1
            ? `${limitTitle} - ${formatCodexUsageWindowLimitLabel(window)}`
            : limitTitle
        }
        description={
          reset
            ? `${formatCodexUsageWindowLimitLabel(window)}. Resets ${reset}`
            : formatCodexUsageWindowLimitLabel(window)
        }
        control={<UsageProgress window={window} />}
      />
    );
  });
}

function ProviderUsageSection({ snapshot }: { snapshot: ProviderUsageSnapshot }) {
  const limits = snapshot.accountUsage?.limits ?? [];

  return (
    <CompactUsageSection
      title={snapshot.entry.displayName}
      icon={
        <ProviderInstanceIcon
          driverKind={snapshot.entry.driverKind}
          displayName={snapshot.entry.displayName}
          accentColor={snapshot.entry.accentColor}
          showBadge={Boolean(snapshot.entry.accentColor)}
          className="size-3.5"
          iconClassName="size-3.5"
          badgeClassName="hidden"
        />
      }
    >
      {limits.length > 0 ? (
        limits.map((limit) => <UsageLimitRows key={limit.key} limit={limit} />)
      ) : (
        <CompactUsageRow
          title="No reported usage"
          description="This provider has not reported account limits in this app session."
          control={<span className="text-xs text-muted-foreground">Waiting</span>}
        />
      )}
    </CompactUsageSection>
  );
}

export function CodexUsageSettingsPanel() {
  const providerUsage = useProviderAccountUsageSnapshots();

  return (
    <SettingsPageContainer>
      {providerUsage.length > 0 ? (
        <>
          {providerUsage.map((snapshot) => (
            <ProviderUsageSection key={snapshot.entry.instanceId} snapshot={snapshot} />
          ))}
        </>
      ) : (
        <CompactUsageSection title="Usage" icon={<GaugeIcon className="size-3.5" />}>
          <CompactUsageRow
            title="No providers"
            description="No enabled providers are available."
            control={<span className="text-xs text-muted-foreground">Waiting</span>}
          />
        </CompactUsageSection>
      )}
    </SettingsPageContainer>
  );
}
