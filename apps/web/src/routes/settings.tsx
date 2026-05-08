import { RotateCcwIcon } from "lucide-react";
import {
  Outlet,
  createFileRoute,
  redirect,
  useCanGoBack,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect, useState, type MouseEvent } from "react";

import { SettingsCenterNav } from "../components/settings/SettingsSidebarNav";
import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { Button } from "../components/ui/button";

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="size-3.5" />
      Restore defaults
    </Button>
  );
}

function SettingsContentLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const [restoreSignal, setRestoreSignal] = useState(0);
  const showRestoreDefaults =
    location.pathname === "/settings/general" ||
    location.pathname === "/settings/providers" ||
    location.pathname === "/settings/agents" ||
    location.pathname === "/settings/mcp" ||
    location.pathname === "/settings/advanced" ||
    location.pathname === "/settings/about";
  const handleRestored = () => setRestoreSignal((value) => value + 1);
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);
  const handleBackdropMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      navigateBackWithinApp();
    },
    [navigateBackWithinApp],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        navigateBackWithinApp();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigateBackWithinApp]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-2 text-foreground backdrop-blur-[2px] sm:p-4"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="flex h-[min(760px,calc(100dvh-1rem))] w-[min(1040px,calc(100vw-1rem))] min-w-0 flex-col overflow-hidden rounded-lg border border-border/80 bg-background/95 shadow-2xl sm:h-[min(760px,calc(100dvh-2rem))] sm:w-[min(1040px,calc(100vw-2rem))]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="shrink-0 border-b border-border px-3 py-2 sm:px-5">
          <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
            <span className="text-sm font-medium text-foreground">Settings</span>
            {showRestoreDefaults ? (
              <div className="ms-auto flex items-center gap-2">
                <RestoreDefaultsButton onRestored={handleRestored} />
              </div>
            ) : null}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="grid h-full w-full grid-cols-1 gap-3 p-3 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-4 md:p-4">
            <SettingsCenterNav
              pathname={location.pathname}
              className="max-h-64 md:max-h-none md:h-full"
            />
            <div key={restoreSignal} className="min-h-0 min-w-0 flex flex-col overflow-hidden">
              <Outlet />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsRouteLayout() {
  return <SettingsContentLayout />;
}

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }

    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
