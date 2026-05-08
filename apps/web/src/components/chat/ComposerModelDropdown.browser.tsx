import "../../index.css";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { ComposerModelDropdown } from "./ComposerModelDropdown";

function makeEntry(input: {
  driverKind: string;
  displayName: string;
  enabled?: boolean;
  status?: ProviderInstanceEntry["status"];
}): ProviderInstanceEntry {
  const driverKind = ProviderDriverKind.make(input.driverKind);
  const instanceId = ProviderInstanceId.make(input.driverKind);
  const enabled = input.enabled ?? true;
  const status = input.status ?? "ready";
  const snapshot = {
    instanceId,
    driver: driverKind,
    displayName: input.displayName,
    enabled,
    installed: true,
    version: "1.0.0",
    status,
    auth: { status: "authenticated" },
    checkedAt: "2026-05-05T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  } satisfies ServerProvider;

  return {
    instanceId,
    driverKind,
    displayName: input.displayName,
    enabled,
    installed: true,
    status,
    isDefault: true,
    isAvailable: true,
    snapshot,
    models: [],
  } satisfies ProviderInstanceEntry;
}

describe("ComposerModelDropdown", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("switches provider model lists through the compact icon rail", async () => {
    const codexEntry = makeEntry({ driverKind: "codex", displayName: "Codex" });
    const claudeEntry = makeEntry({ driverKind: "claudeAgent", displayName: "Claude" });
    const disabledOpenCodeEntry = makeEntry({
      driverKind: "opencode",
      displayName: "OpenCode",
      enabled: false,
      status: "disabled",
    });
    const onInstanceModelChange = vi.fn();

    const mounted = await render(
      <ComposerModelDropdown
        activeInstanceId={codexEntry.instanceId}
        model="gpt-5.5"
        lockedProvider={null}
        instanceEntries={[codexEntry, claudeEntry, disabledOpenCodeEntry]}
        modelOptionsByInstance={
          new Map([
            [codexEntry.instanceId, [{ slug: "gpt-5.5", name: "GPT-5.5" }]],
            [claudeEntry.instanceId, [{ slug: "sonnet-4.5", name: "Claude Sonnet" }]],
            [disabledOpenCodeEntry.instanceId, [{ slug: "opencode-local", name: "OpenCode" }]],
          ])
        }
        onInstanceModelChange={onInstanceModelChange}
      />,
    );

    try {
      await page.getByRole("button", { name: "Model: GPT-5.5" }).click();

      await expect.element(page.getByRole("tab", { name: "Codex" })).toBeInTheDocument();
      await expect.element(page.getByRole("tab", { name: "Claude" })).toBeInTheDocument();
      await expect.element(page.getByRole("tab", { name: "OpenCode" })).not.toBeInTheDocument();

      await page.getByRole("tab", { name: "Claude" }).click();
      await page.getByRole("menuitemradio", { name: "Claude Sonnet" }).click();

      expect(onInstanceModelChange).toHaveBeenCalledWith(claudeEntry.instanceId, "sonnet-4.5");
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the provider model picker size stable when switching provider rails", async () => {
    const codexEntry = makeEntry({ driverKind: "codex", displayName: "Codex" });
    const claudeEntry = makeEntry({ driverKind: "claudeAgent", displayName: "Claude" });
    const onInstanceModelChange = vi.fn();

    const mounted = await render(
      <ComposerModelDropdown
        activeInstanceId={codexEntry.instanceId}
        model="gpt-5.5"
        lockedProvider={null}
        instanceEntries={[codexEntry, claudeEntry]}
        modelOptionsByInstance={
          new Map([
            [codexEntry.instanceId, [{ slug: "gpt-5.5", name: "GPT-5.5" }]],
            [
              claudeEntry.instanceId,
              [
                { slug: "sonnet-4.5", name: "Claude Sonnet" },
                { slug: "opus-4.5", name: "Claude Opus" },
                { slug: "haiku-4.5", name: "Claude Haiku" },
                { slug: "sonnet-fast", name: "Claude Sonnet", subProvider: "Fast" },
                { slug: "sonnet-safe", name: "Claude Sonnet", subProvider: "Safe" },
                { slug: "opus-large-context", name: "Claude Opus Large Context" },
                { slug: "opus-reasoning", name: "Claude Opus Reasoning" },
              ],
            ],
          ])
        }
        onInstanceModelChange={onInstanceModelChange}
      />,
    );

    try {
      await page.getByRole("button", { name: "Model: GPT-5.5" }).click();

      const panel = document.querySelector<HTMLElement>(
        '[data-testid="composer-model-dropdown-panel"]',
      );
      expect(panel).not.toBeNull();
      const codexRect = panel!.getBoundingClientRect();

      await page.getByRole("tab", { name: "Claude" }).click();

      const claudeRect = panel!.getBoundingClientRect();
      expect(Math.round(claudeRect.width)).toBe(Math.round(codexRect.width));
      expect(Math.round(claudeRect.height)).toBe(Math.round(codexRect.height));
      await expect.element(page.getByRole("menuitemradio", { name: "Claude Haiku" })).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });
});
