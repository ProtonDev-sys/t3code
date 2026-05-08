import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

interface ConfirmRequest {
  readonly id: number;
  readonly title: string;
  readonly description: string;
  readonly destructive: boolean;
  readonly resolve: (confirmed: boolean) => void;
}

const listeners = new Set<() => void>();
const queue: ConfirmRequest[] = [];
let nextConfirmId = 1;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ConfirmRequest | null {
  return queue[0] ?? null;
}

function isDestructiveConfirmMessage(message: string): boolean {
  return /\b(delete|remove|clear|discard|reset|restore)\b/i.test(message);
}

function parseConfirmMessage(message: string): {
  readonly title: string;
  readonly description: string;
  readonly destructive: boolean;
} {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    title: lines[0] ?? "Confirm action",
    description: lines.slice(1).join("\n"),
    destructive: isDestructiveConfirmMessage(message),
  };
}

export function confirmInApp(message: string): Promise<boolean> {
  const copy = parseConfirmMessage(message);
  return new Promise<boolean>((resolve) => {
    queue.push({
      id: nextConfirmId++,
      title: copy.title,
      description: copy.description,
      destructive: copy.destructive,
      resolve,
    });
    emit();
  });
}

function resolveRequest(request: ConfirmRequest | null, confirmed: boolean) {
  if (!request) return;
  const index = queue.findIndex((entry) => entry.id === request.id);
  if (index !== -1) {
    queue.splice(index, 1);
  }
  request.resolve(confirmed);
  emit();
}

export function AppConfirmDialog() {
  const request = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [visibleRequest, setVisibleRequest] = useState<ConfirmRequest | null>(request);
  const open = request !== null;
  const displayedRequest = request ?? visibleRequest;

  useEffect(() => {
    if (request) {
      setVisibleRequest(request);
    }
  }, [request]);

  const handleConfirm = useCallback(() => {
    resolveRequest(displayedRequest, true);
  }, [displayedRequest]);

  const handleCancel = useCallback(() => {
    resolveRequest(displayedRequest, false);
  }, [displayedRequest]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.defaultPrevented) return;
      event.preventDefault();
      handleConfirm();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [handleConfirm, open]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => !nextOpen && handleCancel()}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          setVisibleRequest(null);
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{displayedRequest?.title ?? "Confirm action"}</AlertDialogTitle>
          {displayedRequest?.description ? (
            <AlertDialogDescription className="whitespace-pre-line">
              {displayedRequest.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            render={
              <Button type="button" variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
            }
          />
          <Button
            type="button"
            variant={displayedRequest?.destructive ? "destructive" : "default"}
            onClick={handleConfirm}
          >
            Confirm
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
