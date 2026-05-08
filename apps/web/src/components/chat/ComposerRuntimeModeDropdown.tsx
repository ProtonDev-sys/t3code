import type { RuntimeMode } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { memo, useState } from "react";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { runtimeModeConfig, runtimeModeOptions } from "./composerRuntimeMode";

export const ComposerRuntimeModeDropdown = memo(function ComposerRuntimeModeDropdown(props: {
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 rounded-full px-2 text-[11px] font-medium text-muted-foreground/78 hover:text-foreground/80 [&_svg]:mx-0"
            title={`${runtimeModeOption.label}: ${runtimeModeOption.description}`}
            aria-label={`Access: ${runtimeModeOption.label}`}
            data-chat-composer-runtime-status={props.runtimeMode}
          />
        }
      >
        <span className="inline-flex min-w-0 items-center gap-1">
          <RuntimeModeIcon className="size-3.5 shrink-0" />
          <span>{runtimeModeOption.shortLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" side="top">
        <MenuGroup>
          <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Access</div>
          <MenuRadioGroup
            value={props.runtimeMode}
            onValueChange={(value) => {
              if (!value || value === props.runtimeMode) return;
              props.onRuntimeModeChange(value as RuntimeMode);
            }}
          >
            {runtimeModeOptions.map((mode) => {
              const option = runtimeModeConfig[mode];
              const OptionIcon = option.icon;
              return (
                <MenuRadioItem key={mode} value={mode} title={option.description}>
                  <span className="inline-flex items-center gap-2">
                    <OptionIcon className="size-4 shrink-0 text-muted-foreground" />
                    {option.label}
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
