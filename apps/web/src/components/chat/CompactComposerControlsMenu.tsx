import { ProviderInteractionMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { ImageIcon, ListTodoIcon, PlusIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  canAddImage: boolean;
  fastModeControl?: ReactNode;
  interactionMode: ProviderInteractionMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  showInteractionModeToggle: boolean;
  onAddImage: () => void;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  onTogglePlanSidebar: () => void;
}) {
  const hasModeControls = props.showInteractionModeToggle || Boolean(props.fastModeControl);

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-8 shrink-0 rounded-full text-muted-foreground/70 hover:text-foreground/80"
            aria-label="Composer actions"
            data-chat-composer-actions-menu="true"
          />
        }
      >
        <PlusIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start" side="top">
        <MenuItem disabled={!props.canAddImage} onClick={props.onAddImage}>
          <ImageIcon className="size-4 shrink-0" />
          Add image
        </MenuItem>
        {hasModeControls ? <MenuDivider /> : null}
        {props.showInteractionModeToggle ? (
          <MenuCheckboxItem
            checked={props.interactionMode === "plan"}
            variant="switch"
            data-chat-composer-plan-mode-toggle="true"
            onCheckedChange={(checked) => {
              props.onInteractionModeChange(checked === true ? "plan" : "default");
            }}
          >
            <span className="inline-flex items-center gap-2">
              <ListTodoIcon className="size-4 shrink-0 text-muted-foreground" />
              Plan mode
            </span>
          </MenuCheckboxItem>
        ) : null}
        {props.fastModeControl}
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
