import { describe, expect, it } from "vitest";
import {
  ProviderCustomAgentId,
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderCustomAgent,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import {
  customAgentOptionValue,
  DEFAULT_PROVIDER_AGENT_OPTION_VALUE,
  PROVIDER_AGENT_OPTION_ID,
} from "@t3tools/shared/customAgents";

import { providerModelsFromSettings, providerModelsWithCustomAgents } from "./providerSnapshot.ts";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      ProviderDriverKind.make("opencode"),
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });
});

describe("providerModelsWithCustomAgents", () => {
  it("adds active custom agents to each model's agent option descriptor", () => {
    const reviewerAgent: ProviderCustomAgent = {
      id: ProviderCustomAgentId.make("reviewer"),
      name: "Reviewer",
      description: "Checks correctness and regressions",
      instructions: "Review for bugs and missing tests.",
      enabled: true,
    };
    const disabledAgent: ProviderCustomAgent = {
      id: ProviderCustomAgentId.make("disabled"),
      name: "Disabled",
      instructions: "Should not be offered.",
      enabled: false,
    };

    const models = providerModelsWithCustomAgents({
      customAgents: [reviewerAgent, disabledAgent],
      models: [
        {
          slug: "gpt-5.5",
          name: "GPT-5.5",
          isCustom: false,
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        },
      ],
    });

    expect(models[0]?.capabilities?.optionDescriptors).toEqual([
      {
        id: PROVIDER_AGENT_OPTION_ID,
        label: "Agent",
        type: "select",
        currentValue: DEFAULT_PROVIDER_AGENT_OPTION_VALUE,
        options: [
          {
            id: DEFAULT_PROVIDER_AGENT_OPTION_VALUE,
            label: "Default",
            isDefault: true,
          },
          {
            id: customAgentOptionValue("reviewer"),
            label: "Reviewer",
            description: "Checks correctness and regressions",
          },
        ],
      },
    ]);
  });

  it("preserves native provider agent options while appending custom agents", () => {
    const reviewerAgent: ProviderCustomAgent = {
      id: ProviderCustomAgentId.make("reviewer"),
      name: "Reviewer",
      instructions: "Review for bugs and missing tests.",
      enabled: true,
    };

    const models = providerModelsWithCustomAgents({
      customAgents: [reviewerAgent],
      models: [
        {
          slug: "opencode/build",
          name: "OpenCode Build",
          isCustom: false,
          capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
        },
      ],
    });

    const agentDescriptor = models[0]?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === PROVIDER_AGENT_OPTION_ID,
    );
    expect(agentDescriptor).toMatchObject({
      id: PROVIDER_AGENT_OPTION_ID,
      options: [
        { id: "build", label: "Build", isDefault: true },
        { id: customAgentOptionValue("reviewer"), label: "Reviewer" },
      ],
    });
  });
});
