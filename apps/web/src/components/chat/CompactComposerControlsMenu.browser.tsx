import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createModelCapabilities, createModelSelection } from "@t3tools/shared/model";

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerAgentDropdown, ComposerFastModeMenuCheckboxItem } from "./TraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  const defaultId = options.find((option) => option.isDefault)?.id;
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(defaultId ? { currentValue: defaultId } : {}),
  };
}

async function mountMenu(props?: {
  canAddImage?: boolean;
  fastMode?: boolean;
  interactionMode?: "default" | "plan";
  showInteractionModeToggle?: boolean;
}) {
  const threadId = ThreadId.make("thread-compact-menu");
  const threadRef = scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId);
  const threadKey = scopedThreadKey(threadRef);
  const provider = ProviderDriverKind.make("claudeAgent");
  const instanceId = ProviderInstanceId.make(provider);
  const model = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
  const onAddImage = vi.fn();
  const onInteractionModeChange = vi.fn();
  const onTogglePlanSidebar = vi.fn();

  useComposerDraftStore.setState({
    draftsByThreadKey: {
      [threadKey]: {
        prompt: "",
        images: [],
        nonPersistedImageIds: [],
        persistedAttachments: [],
        terminalContexts: [],
        modelSelectionByProvider: {
          [instanceId]: createModelSelection(instanceId, model),
        },
        activeProvider: instanceId,
        runtimeMode: null,
        interactionMode: null,
      },
    },
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const models = [
    {
      slug: model,
      name: model,
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [booleanDescriptor("fastMode", "Fast Mode")],
      }),
    },
  ];
  const screen = await render(
    <CompactComposerControlsMenu
      activePlan={false}
      canAddImage={props?.canAddImage ?? true}
      fastModeControl={
        props?.fastMode ? (
          <ComposerFastModeMenuCheckboxItem
            provider={provider}
            threadRef={threadRef}
            model={model}
            models={models}
            modelOptions={undefined}
            prompt=""
          />
        ) : null
      }
      interactionMode={props?.interactionMode ?? "default"}
      planSidebarLabel="Plan"
      planSidebarOpen={false}
      showInteractionModeToggle={props?.showInteractionModeToggle ?? true}
      onAddImage={onAddImage}
      onInteractionModeChange={onInteractionModeChange}
      onTogglePlanSidebar={onTogglePlanSidebar}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    onAddImage,
    onInteractionModeChange,
    instanceId,
    threadRef,
  };
}

describe("CompactComposerControlsMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("opens image and mode actions from the plus trigger", async () => {
    await using mounted = await mountMenu();

    await page.getByLabelText("Composer actions").click();
    await page.getByText("Add image").click();

    expect(mounted.onAddImage).toHaveBeenCalledTimes(1);
  });

  it("toggles plan mode directly", async () => {
    await using mounted = await mountMenu();

    await page.getByLabelText("Composer actions").click();
    await page.getByText("Plan mode").click();

    expect(mounted.onInteractionModeChange).toHaveBeenCalledWith("plan");
  });

  it("can hide the plan mode toggle", async () => {
    await using _ = await mountMenu({ showInteractionModeToggle: false });

    await page.getByLabelText("Composer actions").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Add image");
      expect(text).not.toContain("Plan mode");
    });
  });

  it("shows fast mode as a switch when the provider exposes it", async () => {
    await using mounted = await mountMenu({ fastMode: true });

    await page.getByLabelText("Composer actions").click();
    await page.getByText("Fast mode").click();

    await vi.waitFor(() => {
      const draft = useComposerDraftStore.getState().getComposerDraft(mounted.threadRef);
      expect(draft?.modelSelectionByProvider[mounted.instanceId]?.options).toEqual([
        { id: "fastMode", value: true },
      ]);
    });
  });

  it("stores agent selections from the composer agent dropdown", async () => {
    const threadId = ThreadId.make("thread-agent-dropdown");
    const threadRef = scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId);
    const threadKey = scopedThreadKey(threadRef);
    const provider = ProviderDriverKind.make("codex");
    const instanceId = ProviderInstanceId.make("codex_work");
    const model = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
    const host = document.createElement("div");
    document.body.append(host);

    useComposerDraftStore.setState({
      draftsByThreadKey: {
        [threadKey]: {
          prompt: "",
          images: [],
          nonPersistedImageIds: [],
          persistedAttachments: [],
          terminalContexts: [],
          modelSelectionByProvider: {
            [instanceId]: createModelSelection(instanceId, model),
          },
          activeProvider: instanceId,
          runtimeMode: null,
          interactionMode: null,
        },
      },
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });

    const models = [
      {
        slug: model,
        name: model,
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("agent", "Agent", [
              { id: "__default_agent", label: "Default", isDefault: true },
              { id: "reviewer", label: "Reviewer" },
            ]),
          ],
        }),
      },
    ];
    const screen = await render(
      <ComposerAgentDropdown
        instanceId={instanceId}
        provider={provider}
        threadRef={threadRef}
        model={model}
        models={models}
        modelOptions={undefined}
        prompt=""
      />,
      { container: host },
    );

    try {
      await page.getByLabelText("Agent: Agent").click();
      await page.getByText("Reviewer").click();

      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
        expect(draft?.modelSelectionByProvider[instanceId]?.options).toEqual([
          { id: "agent", value: "reviewer" },
        ]);
        expect(useComposerDraftStore.getState().stickyActiveProvider).toBe(instanceId);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
