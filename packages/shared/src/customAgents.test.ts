import {
  ProviderCustomAgentId,
  ProviderInstanceId,
  type ProviderCustomAgent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { createModelSelection } from "./model.ts";
import {
  applyCodexNativeCustomAgentPrompt,
  applyCustomAgentPrompt,
  customAgentOptionValue,
  DEFAULT_PROVIDER_AGENT_OPTION_VALUE,
  PROVIDER_AGENT_OPTION_ID,
  stripCustomAgentSelection,
} from "./customAgents.ts";

const providerInstanceId = ProviderInstanceId.make("codex");

const reviewerAgent: ProviderCustomAgent = {
  id: ProviderCustomAgentId.make("reviewer"),
  name: "Reviewer",
  description: "Looks for regressions",
  instructions: "Focus on bugs, risks, and missing tests.",
  enabled: true,
};

describe("customAgents", () => {
  it("injects selected custom agent instructions into the prompt", () => {
    const selection = createModelSelection(providerInstanceId, "gpt-5.4", [
      { id: PROVIDER_AGENT_OPTION_ID, value: customAgentOptionValue("reviewer") },
    ]);

    expect(
      applyCustomAgentPrompt({
        prompt: "Review this change.",
        modelSelection: selection,
        customAgents: [reviewerAgent],
      }),
    ).toBe(
      "Custom agent: Reviewer\nDescription:\nLooks for regressions\n\nInstructions:\nFocus on bugs, risks, and missing tests.\n\nUser request:\nReview this change.",
    );
  });

  it("asks Codex to use the materialized native custom agent", () => {
    const selection = createModelSelection(providerInstanceId, "gpt-5.4", [
      { id: PROVIDER_AGENT_OPTION_ID, value: customAgentOptionValue("reviewer") },
    ]);

    expect(
      applyCodexNativeCustomAgentPrompt({
        prompt: "Review this change.",
        modelSelection: selection,
        customAgents: [reviewerAgent],
      }),
    ).toBe(
      'Use the Codex custom agent named "Reviewer" from reviewer.toml for this task.\n\nUser request:\nReview this change.',
    );
  });

  it("strips T3 custom-agent choices before sending model selection to native adapters", () => {
    const selection = createModelSelection(providerInstanceId, "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: PROVIDER_AGENT_OPTION_ID, value: customAgentOptionValue("reviewer") },
    ]);

    expect(stripCustomAgentSelection(selection)).toEqual({
      instanceId: providerInstanceId,
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("removes the synthetic default agent option entirely when it is the only option", () => {
    const selection = createModelSelection(providerInstanceId, "gpt-5.4", [
      { id: PROVIDER_AGENT_OPTION_ID, value: DEFAULT_PROVIDER_AGENT_OPTION_VALUE },
    ]);

    expect(stripCustomAgentSelection(selection)).toEqual({
      instanceId: providerInstanceId,
      model: "gpt-5.4",
    });
  });
});
