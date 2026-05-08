import { useSyncExternalStore } from "react";
import type { CliUpdateState } from "@t3tools/contracts";

const listeners = new Set<() => void>();
const statesByKey = new Map<string, CliUpdateState>();
let snapshotCache: ReadonlyArray<CliUpdateState> = [];

function stateKey(state: Pick<CliUpdateState, "providerInstanceId" | "targetVersion">): string {
  return `${state.providerInstanceId}:${state.targetVersion ?? "latest"}`;
}

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

function getSnapshot(): ReadonlyArray<CliUpdateState> {
  return snapshotCache;
}

export function setCliUpdateUiState(state: CliUpdateState): void {
  statesByKey.set(stateKey(state), state);
  snapshotCache = Array.from(statesByKey.values()).toSorted((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  );
  emit();
}

export function useCliUpdateUiStates(): ReadonlyArray<CliUpdateState> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
