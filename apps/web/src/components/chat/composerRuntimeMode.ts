import type { RuntimeMode } from "@t3tools/contracts";
import { LockIcon, MousePointerClickIcon, PenLineIcon, type LucideIcon } from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; shortLabel: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    shortLabel: "Safe",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    shortLabel: "Auto",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  "full-access": {
    label: "Full access",
    shortLabel: "Full",
    description: "Allow commands and edits without prompts.",
    icon: MousePointerClickIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
