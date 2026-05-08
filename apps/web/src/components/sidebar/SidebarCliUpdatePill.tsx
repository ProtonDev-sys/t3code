import { LoaderCircleIcon } from "lucide-react";

import { useCliUpdateUiStates } from "../../lib/cliUpdateUiState";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarCliUpdatePill() {
  const update = useCliUpdateUiStates().find((state) => state.status === "running");

  if (!update) return null;

  const label = update.displayName ?? "Codex CLI";
  const version =
    update.currentVersion && update.targetVersion
      ? `${update.currentVersion} -> ${update.targetVersion}`
      : (update.targetVersion ?? "latest");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex h-7 w-full items-center gap-2 rounded-lg bg-info/12 px-2 text-xs font-medium text-info">
            <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 truncate">{label} updating</span>
          </div>
        }
      />
      <TooltipPopup side="top">Updating {version} in the background</TooltipPopup>
    </Tooltip>
  );
}
