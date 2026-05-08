import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { cn } from "~/lib/utils";
import { setModelPickerOpen } from "../../modelPickerOpenState";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button, buttonVariants } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
  type ModelEsque,
} from "./providerIconUtils";

const MODEL_KEY_SEPARATOR = "\u0000";

function modelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${instanceId}${MODEL_KEY_SEPARATOR}${slug}`;
}

function splitModelKey(key: string): { instanceId: ProviderInstanceId; slug: string } | null {
  const separatorIndex = key.indexOf(MODEL_KEY_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }
  return {
    instanceId: key.slice(0, separatorIndex) as ProviderInstanceId,
    slug: key.slice(separatorIndex + MODEL_KEY_SEPARATOR.length),
  };
}

export const ComposerModelDropdown = memo(function ComposerModelDropdown(props: {
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const [selectedPickerInstanceId, setSelectedPickerInstanceId] =
    useState<ProviderInstanceId | null>(null);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;

  const activeEntry = useMemo(
    () =>
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null,
    [props.activeInstanceId, props.instanceEntries],
  );
  const selectedInstanceOptions = props.modelOptionsByInstance.get(props.activeInstanceId) ?? [];
  const selectedModel =
    selectedInstanceOptions.find((option) => option.slug === props.model) ??
    selectedInstanceOptions[0];
  const triggerTitle = selectedModel ? getTriggerDisplayModelName(selectedModel) : props.model;
  const triggerLabel = selectedModel ? getTriggerDisplayModelLabel(selectedModel) : props.model;
  const duplicateDriverCount = props.instanceEntries.filter(
    (entry) => activeEntry !== null && entry.driverKind === activeEntry.driverKind,
  ).length;
  const showInstanceBadge = Boolean(activeEntry?.accentColor) || duplicateDriverCount > 1;

  const visibleEntries = useMemo(
    () =>
      props.instanceEntries.filter((entry) => {
        if (!entry.enabled || !entry.isAvailable) return false;
        if (entry.status !== "ready") return false;
        if (props.lockedProvider === null) return true;
        if (entry.driverKind !== props.lockedProvider) return false;
        if (!props.lockedContinuationGroupKey) return true;
        return entry.continuationGroupKey === props.lockedContinuationGroupKey;
      }),
    [props.instanceEntries, props.lockedContinuationGroupKey, props.lockedProvider],
  );
  const visibleGroups = useMemo(
    () =>
      visibleEntries.flatMap((entry) => {
        const models = props.modelOptionsByInstance.get(entry.instanceId) ?? [];
        return models.length > 0 ? [{ entry, models }] : [];
      }),
    [props.modelOptionsByInstance, visibleEntries],
  );
  const selectedGroup = useMemo(
    () =>
      visibleGroups.find((group) => group.entry.instanceId === selectedPickerInstanceId) ??
      visibleGroups.find((group) => group.entry.instanceId === props.activeInstanceId) ??
      visibleGroups[0] ??
      null,
    [props.activeInstanceId, selectedPickerInstanceId, visibleGroups],
  );

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  useEffect(() => {
    setModelPickerOpen(isMenuOpen);
    return () => {
      setModelPickerOpen(false);
    };
  }, [isMenuOpen]);

  useEffect(() => {
    if (!isMenuOpen) return;
    setSelectedPickerInstanceId((current) => {
      if (current && visibleGroups.some((group) => group.entry.instanceId === current)) {
        return current;
      }
      const activeVisibleGroup = visibleGroups.find(
        (group) => group.entry.instanceId === props.activeInstanceId,
      );
      return activeVisibleGroup?.entry.instanceId ?? visibleGroups[0]?.entry.instanceId ?? null;
    });
  }, [isMenuOpen, props.activeInstanceId, visibleGroups]);

  const handleModelChange = (key: string) => {
    if (props.disabled) return;
    const parsed = splitModelKey(key);
    if (!parsed) return;
    const entry = props.instanceEntries.find(
      (candidate) => candidate.instanceId === parsed.instanceId,
    );
    const options = props.modelOptionsByInstance.get(parsed.instanceId);
    if (!entry || !options) return;
    const resolvedModel = resolveSelectableModel(entry.driverKind, parsed.slug, options);
    if (!resolvedModel) return;
    props.onInstanceModelChange(parsed.instanceId, resolvedModel);
    setIsMenuOpen(false);
  };

  const selectedKey = modelKey(props.activeInstanceId, props.model);

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "h-8 max-w-34 shrink-0 rounded-full px-2 text-[11px] font-medium text-muted-foreground/78 hover:text-foreground/80 sm:max-w-40 [&_svg]:mx-0",
              props.triggerClassName,
            )}
            title={triggerLabel}
            aria-label={`Model: ${triggerLabel}`}
            disabled={props.disabled}
          />
        }
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {activeEntry ? (
            <ProviderInstanceIcon
              driverKind={activeEntry.driverKind}
              displayName={activeEntry.displayName}
              accentColor={activeEntry.accentColor}
              showBadge={showInstanceBadge}
              className={showInstanceBadge ? "size-5 shrink-0" : "size-4 shrink-0"}
              iconClassName={cn("size-4", props.activeProviderIconClassName)}
              badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 text-[7px]"
            />
          ) : null}
          <span className="min-w-0 truncate">{triggerTitle}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup
        align="start"
        side="top"
        className="model-picker-list w-76 max-w-[calc(100vw-1rem)]"
      >
        {selectedGroup ? (
          <div
            data-testid="composer-model-dropdown-panel"
            className="flex h-56 w-full overflow-hidden"
          >
            {visibleGroups.length > 1 ? (
              <div
                role="tablist"
                aria-label="Provider"
                className="flex h-full w-10 shrink-0 flex-col gap-1 overflow-y-auto border-border/70 border-r pr-1"
              >
                {visibleGroups.map(({ entry }) => {
                  const selected = selectedGroup.entry.instanceId === entry.instanceId;
                  return (
                    <button
                      key={entry.instanceId}
                      type="button"
                      role="tab"
                      aria-label={entry.displayName}
                      aria-selected={selected}
                      className={cn(
                        "flex size-8 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                        selected && "bg-accent text-foreground",
                      )}
                      title={entry.displayName}
                      onPointerDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setSelectedPickerInstanceId(entry.instanceId);
                      }}
                    >
                      <ProviderInstanceIcon
                        driverKind={entry.driverKind}
                        displayName={entry.displayName}
                        accentColor={entry.accentColor}
                        showBadge={Boolean(entry.accentColor)}
                        className="size-5"
                        iconClassName="size-4"
                        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-2.5 min-w-2.5 text-[6px]"
                      />
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col pl-1">
              <div className="shrink-0 px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                {selectedGroup.entry.displayName}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
                <MenuRadioGroup value={selectedKey} onValueChange={handleModelChange}>
                  {selectedGroup.models.map((model) => (
                    <MenuRadioItem
                      key={modelKey(selectedGroup.entry.instanceId, model.slug)}
                      value={modelKey(selectedGroup.entry.instanceId, model.slug)}
                      className="w-full min-w-0 py-1.5"
                      title={getTriggerDisplayModelLabel(model)}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{getTriggerDisplayModelName(model)}</span>
                        {model.subProvider ? (
                          <span className="truncate text-muted-foreground text-xs">
                            {model.subProvider}
                          </span>
                        ) : null}
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </div>
            </div>
          </div>
        ) : (
          <div className="px-2 py-1.5 text-muted-foreground text-xs">No enabled providers</div>
        )}
      </MenuPopup>
    </Menu>
  );
});
