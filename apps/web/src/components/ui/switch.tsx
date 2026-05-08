"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { CheckIcon } from "lucide-react";

import { cn } from "~/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative inline-flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-[.25rem] border border-input bg-background not-dark:bg-clip-padding shadow-xs/5 outline-none ring-ring transition-[background-color,border-color,box-shadow] duration-150 before:pointer-events-none before:absolute before:inset-0 before:rounded-[3px] not-data-disabled:not-data-checked:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:border-primary data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-64 data-checked:shadow-none sm:size-4 dark:not-data-checked:bg-input/32 dark:not-data-disabled:not-data-checked:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none -inset-px absolute flex items-center justify-center rounded-[.25rem] bg-primary text-primary-foreground opacity-0 transition-opacity duration-150 data-checked:opacity-100",
        )}
        data-slot="switch-thumb"
      >
        <CheckIcon className="size-3.5 stroke-3 sm:size-3" />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
}

export { Switch };
