import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import { memo, useCallback, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { BotIcon, ChevronDownIcon, ZapIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { cn } from "~/lib/utils";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";
function useTraitsUpdate(
  provider: ProviderDriverKind,
  instanceId: ProviderInstanceId | null | undefined,
  model: string | null | undefined,
  persistence: TraitsPersistence,
) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  return useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      const threadTarget = persistence.threadRef ?? persistence.draftId;
      if (!threadTarget) {
        return;
      }
      setProviderModelOptions(threadTarget, provider, nextOptions, {
        ...(instanceId ? { instanceId } : {}),
        model,
        persistSticky: true,
      });
    },
    [instanceId, model, persistence, provider, setProviderModelOptions],
  );
}

function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : null;
}

function getSelectDescriptorTriggerLabel(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
): string {
  const currentValue = getProviderOptionCurrentValue(descriptor);
  const currentOption =
    typeof currentValue === "string"
      ? descriptor.options.find((option) => option.id === currentValue)
      : undefined;
  return currentOption?.isDefault
    ? descriptor.label
    : (currentOption?.label ?? getProviderOptionCurrentLabel(descriptor) ?? descriptor.label);
}

function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({
    caps,
    selections: modelOptions,
  });
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const primarySelectDescriptor =
    selectDescriptors.find(
      (descriptor) => descriptor.id !== "contextWindow" && descriptor.id !== "agent",
    ) ?? null;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;

  // Prompt-controlled effort (e.g. ultrathink in prompt text)
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  // Check if "ultrathink" appears in the body text (not just our prefix)
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  const effort =
    (ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(primarySelectDescriptor)) ?? null;
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const fastModeEnabled =
    typeof fastModeDescriptor?.currentValue === "boolean" ? fastModeDescriptor.currentValue : false;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);
  const selectedAgent = getDescriptorStringValue(agentDescriptor);
  const selectedAgentLabel = agentDescriptor
    ? getProviderOptionCurrentLabel(agentDescriptor)
    : null;

  return {
    caps,
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    fastModeEnabled,
    contextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    selectedAgent,
    selectedAgentLabel,
  };
}

function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.prompt,
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
  );

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null;
  const showContextWindow =
    selected.contextWindowDescriptor !== null &&
    selected.contextWindowDescriptor.options.length > 1;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls: showEffort || showThinking || showFastMode || showContextWindow || showAgent,
  };
}

export function shouldRenderTraitsControls(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

export interface ComposerTraitStatusItem {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly active: boolean;
}

function statusLabelForDescriptor(input: {
  descriptor: ProviderOptionDescriptor;
  primarySelectDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null;
  ultrathinkPromptControlled: boolean;
}): { label: string; active: boolean } | null {
  const { descriptor, primarySelectDescriptor, ultrathinkPromptControlled } = input;
  if (descriptor.type === "boolean") {
    if (descriptor.currentValue !== true) {
      return null;
    }
    if (descriptor.id === "fastMode") {
      return { label: "Fast", active: true };
    }
    return { label: descriptor.label, active: true };
  }

  if (ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id) {
    return { label: "Ultrathink", active: true };
  }
  const currentValue = getProviderOptionCurrentValue(descriptor);
  const currentOption = descriptor.options.find((option) => option.id === currentValue);
  if (currentOption?.isDefault) {
    return null;
  }
  const label = getProviderOptionCurrentLabel(descriptor);
  return label ? { label, active: false } : null;
}

export function getComposerTraitStatusItems(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  includePrimarySelect?: boolean;
}): ReadonlyArray<ComposerTraitStatusItem> {
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled } =
    getTraitsSectionVisibility(input);
  return descriptors.flatMap((descriptor) => {
    if (input.includePrimarySelect === false && descriptor.id === primarySelectDescriptor?.id) {
      return [];
    }
    const status = statusLabelForDescriptor({
      descriptor,
      primarySelectDescriptor,
      ultrathinkPromptControlled,
    });
    if (!status) {
      return [];
    }
    return [
      {
        id: descriptor.id,
        label: status.label,
        title: descriptor.label,
        active: status.active,
      },
    ];
  });
}

export function hasComposerFastModeControl(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}): boolean {
  return getTraitsSectionVisibility(input).fastModeDescriptor !== null;
}

export interface TraitsMenuContentProps {
  instanceId?: ProviderInstanceId | null | undefined;
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  instanceId,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const updateModelOptions = useTraitsUpdate(provider, instanceId, model, persistence);
  const {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    hasAnyControls,
  } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  });
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const handleSelectChange = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    if (!value) return;
    if (descriptor.promptInjectedValues?.includes(value)) {
      const nextPrompt =
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink");
      onPromptChange(nextPrompt);
      return;
    }
    if (ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id) return;
    if (ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id) {
      const stripped = prompt.replace(/^Ultrathink:\s*/i, "");
      onPromptChange(stripped);
    }
    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, value));
  };

  if (!hasAnyControls) {
    return null;
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
              {descriptor.label}
            </div>
            {ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this
                option.
              </div>
            ) : null}
            <MenuRadioGroup
              value={
                ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
                  ? "ultrathink"
                  : (getDescriptorStringValue(descriptor) ?? "")
              }
              onValueChange={(value) => handleSelectChange(descriptor, value)}
            >
              {descriptor.options.map((option) => (
                <MenuRadioItem
                  key={option.id}
                  value={option.id}
                  disabled={ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id}
                >
                  {option.label}
                  {option.isDefault ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ))}
      {booleanDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              {descriptor.label}
            </div>
            <MenuRadioGroup
              value={descriptor.currentValue === true ? "on" : "off"}
              onValueChange={(value) => {
                updateDescriptors(
                  replaceDescriptorCurrentValue(descriptors, descriptor.id, value === "on"),
                );
              }}
            >
              <MenuRadioItem value="on">On</MenuRadioItem>
              <MenuRadioItem value="off">Off</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ))}
    </>
  );
});

export const ComposerReasoningDropdown = memo(function ComposerReasoningDropdown({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  instanceId,
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const updateModelOptions = useTraitsUpdate(provider, instanceId, model, persistence);
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled, ultrathinkInBodyText } =
    getTraitsSectionVisibility({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
    });

  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const handleSelectChange = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    if (!value) return;
    if (descriptor.promptInjectedValues?.includes(value)) {
      const nextPrompt =
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink");
      onPromptChange(nextPrompt);
      return;
    }
    if (ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id) return;
    if (ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id) {
      const stripped = prompt.replace(/^Ultrathink:\s*/i, "");
      onPromptChange(stripped);
    }
    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, value));
  };

  if (!primarySelectDescriptor) {
    return null;
  }

  const triggerLabel = ultrathinkPromptControlled
    ? "Ultrathink"
    : getSelectDescriptorTriggerLabel(primarySelectDescriptor);

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={triggerVariant ?? "ghost"}
            className={cn(
              "h-8 shrink-0 rounded-full px-2 text-[11px] font-medium text-muted-foreground/78 hover:text-foreground/80 [&_svg]:mx-0",
              triggerClassName,
            )}
            aria-label={`${primarySelectDescriptor.label}: ${triggerLabel}`}
            data-chat-composer-reasoning-trigger="true"
          />
        }
      >
        <span className="inline-flex min-w-0 items-center gap-1">
          <span className="truncate">{triggerLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" side="top">
        <MenuGroup>
          <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
            {primarySelectDescriptor.label}
          </div>
          {ultrathinkInBodyText ? (
            <div className="max-w-64 px-2 pb-1.5 text-muted-foreground/80 text-xs">
              Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this
              option.
            </div>
          ) : null}
          <MenuRadioGroup
            value={
              ultrathinkPromptControlled
                ? "ultrathink"
                : (getDescriptorStringValue(primarySelectDescriptor) ?? "")
            }
            onValueChange={(value) => handleSelectChange(primarySelectDescriptor, value)}
          >
            {primarySelectDescriptor.options.map((option) => (
              <MenuRadioItem key={option.id} value={option.id} disabled={ultrathinkInBodyText}>
                {option.label}
                {option.isDefault ? " (default)" : ""}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

export const ComposerContextWindowDropdown = memo(function ComposerContextWindowDropdown({
  provider,
  models,
  model,
  prompt,
  modelOptions,
  allowPromptInjectedEffort = true,
  instanceId,
  triggerVariant,
  triggerClassName,
  ...persistence
}: Omit<TraitsMenuContentProps, "onPromptChange"> & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const updateModelOptions = useTraitsUpdate(provider, instanceId, model, persistence);
  const { descriptors, contextWindowDescriptor } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  });

  if (!contextWindowDescriptor) {
    return null;
  }

  const triggerLabel = getSelectDescriptorTriggerLabel(contextWindowDescriptor);

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={triggerVariant ?? "ghost"}
            className={cn(
              "h-8 shrink-0 rounded-full px-2 text-[11px] font-medium text-muted-foreground/78 hover:text-foreground/80 [&_svg]:mx-0",
              triggerClassName,
            )}
            aria-label={`Context window: ${triggerLabel}`}
            data-chat-composer-context-window-trigger="true"
          />
        }
      >
        <span className="inline-flex min-w-0 items-center gap-1">
          <span className="truncate">{triggerLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" side="top">
        <MenuGroup>
          <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
            {contextWindowDescriptor.label}
          </div>
          <MenuRadioGroup
            value={getDescriptorStringValue(contextWindowDescriptor) ?? ""}
            onValueChange={(value) => {
              if (!value) return;
              updateModelOptions(
                buildProviderOptionSelectionsFromDescriptors(
                  replaceDescriptorCurrentValue(descriptors, contextWindowDescriptor.id, value),
                ),
              );
            }}
          >
            {contextWindowDescriptor.options.map((option) => (
              <MenuRadioItem key={option.id} value={option.id}>
                {option.label}
                {option.isDefault ? " (default)" : ""}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

export const ComposerAgentDropdown = memo(function ComposerAgentDropdown({
  provider,
  models,
  model,
  prompt,
  modelOptions,
  allowPromptInjectedEffort = true,
  instanceId,
  triggerVariant,
  triggerClassName,
  ...persistence
}: Omit<TraitsMenuContentProps, "onPromptChange"> & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const updateModelOptions = useTraitsUpdate(provider, instanceId, model, persistence);
  const { descriptors, agentDescriptor } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  });

  if (!agentDescriptor) {
    return null;
  }

  const triggerLabel = getSelectDescriptorTriggerLabel(agentDescriptor);

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={triggerVariant ?? "ghost"}
            className={cn(
              "h-8 shrink-0 rounded-full px-2 text-[11px] font-medium text-muted-foreground/78 hover:text-foreground/80 [&_svg]:mx-0",
              triggerClassName,
            )}
            aria-label={`Agent: ${triggerLabel}`}
            data-chat-composer-agent-trigger="true"
          />
        }
      >
        <span className="inline-flex min-w-0 items-center gap-1">
          <BotIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate">{triggerLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" side="top">
        <MenuGroup>
          <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
            {agentDescriptor.label}
          </div>
          <MenuRadioGroup
            value={getDescriptorStringValue(agentDescriptor) ?? ""}
            onValueChange={(value) => {
              if (!value) return;
              updateModelOptions(
                buildProviderOptionSelectionsFromDescriptors(
                  replaceDescriptorCurrentValue(descriptors, agentDescriptor.id, value),
                ),
              );
            }}
          >
            {agentDescriptor.options.map((option) => (
              <MenuRadioItem key={option.id} value={option.id}>
                {option.label}
                {option.isDefault ? " (default)" : ""}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

export const ComposerFastModeMenuCheckboxItem = memo(function ComposerFastModeMenuCheckboxItem({
  provider,
  models,
  model,
  prompt,
  modelOptions,
  allowPromptInjectedEffort = true,
  instanceId,
  ...persistence
}: Omit<TraitsMenuContentProps, "onPromptChange" | "triggerVariant" | "triggerClassName"> &
  TraitsPersistence) {
  const updateModelOptions = useTraitsUpdate(provider, instanceId, model, persistence);
  const { descriptors, fastModeDescriptor } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  });

  if (!fastModeDescriptor) {
    return null;
  }

  return (
    <MenuCheckboxItem
      checked={fastModeDescriptor.currentValue === true}
      variant="switch"
      data-chat-composer-fast-mode-toggle="true"
      onCheckedChange={(checked) => {
        updateModelOptions(
          buildProviderOptionSelectionsFromDescriptors(
            replaceDescriptorCurrentValue(descriptors, fastModeDescriptor.id, checked === true),
          ),
        );
      }}
    >
      <span className="inline-flex items-center gap-2">
        <ZapIcon className="size-4 shrink-0 text-muted-foreground" />
        Fast mode
      </span>
    </MenuCheckboxItem>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  instanceId,
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled } =
    getTraitsSectionVisibility({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
    });
  if (
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
    })
  ) {
    return null;
  }

  const triggerLabel =
    descriptors
      .map((descriptor) => {
        if (ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id) {
          return "Ultrathink";
        }
        if (descriptor.type === "boolean") {
          if (descriptor.id === "fastMode") {
            return descriptor.currentValue === true ? "Fast" : "Normal";
          }
          return `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`;
        }
        return getSelectDescriptorTriggerLabel(descriptor);
      })
      .filter((label): label is string => typeof label === "string" && label.length > 0)
      .join(" · ") || "";

  const isCodexStyle = provider === "codex";

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={triggerVariant ?? "ghost"}
            className={cn(
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3 [&_svg]:mx-0"
                : "shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3",
              triggerClassName,
            )}
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
            {triggerLabel}
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
          </span>
        ) : (
          <>
            <span>{triggerLabel}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          models={models}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          instanceId={instanceId}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
