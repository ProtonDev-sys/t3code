import type {
  ModelSelection,
  ProviderCustomAgent,
  ProviderOptionSelection,
} from "@t3tools/contracts";

export const PROVIDER_AGENT_OPTION_ID = "agent";
export const DEFAULT_PROVIDER_AGENT_OPTION_VALUE = "__t3_default_agent";
const CUSTOM_AGENT_OPTION_PREFIX = "custom:";

export function customAgentOptionValue(agentId: string): string {
  return `${CUSTOM_AGENT_OPTION_PREFIX}${agentId}`;
}

export function customAgentIdFromOptionValue(value: string | null | undefined): string | null {
  if (!value?.startsWith(CUSTOM_AGENT_OPTION_PREFIX)) {
    return null;
  }
  const id = value.slice(CUSTOM_AGENT_OPTION_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

function activeCustomAgents(
  customAgents: ReadonlyArray<ProviderCustomAgent> | null | undefined,
): ReadonlyArray<ProviderCustomAgent> {
  return (customAgents ?? []).filter(
    (agent) =>
      agent.enabled !== false &&
      agent.id.trim().length > 0 &&
      agent.name.trim().length > 0 &&
      agent.instructions.trim().length > 0,
  );
}

export function getSelectedCustomAgent(input: {
  readonly modelSelection: ModelSelection | null | undefined;
  readonly customAgents: ReadonlyArray<ProviderCustomAgent> | null | undefined;
}): ProviderCustomAgent | null {
  const selectedAgentValue = input.modelSelection?.options?.find(
    (option) => option.id === PROVIDER_AGENT_OPTION_ID && typeof option.value === "string",
  )?.value;
  if (typeof selectedAgentValue !== "string") {
    return null;
  }
  const selectedAgentId = customAgentIdFromOptionValue(selectedAgentValue);
  if (!selectedAgentId) {
    return null;
  }
  return (
    activeCustomAgents(input.customAgents).find((agent) => agent.id === selectedAgentId) ?? null
  );
}

export function stripCustomAgentSelection(
  modelSelection: ModelSelection | null | undefined,
): ModelSelection | undefined {
  if (!modelSelection) {
    return undefined;
  }
  const nextOptions = (modelSelection.options ?? []).filter((option) => {
    if (option.id !== PROVIDER_AGENT_OPTION_ID) {
      return true;
    }
    if (typeof option.value !== "string") {
      return true;
    }
    return (
      option.value !== DEFAULT_PROVIDER_AGENT_OPTION_VALUE &&
      customAgentIdFromOptionValue(option.value) === null
    );
  });
  const { options: _options, ...selectionWithoutOptions } = modelSelection;
  return {
    ...selectionWithoutOptions,
    ...(nextOptions.length > 0
      ? { options: nextOptions as ReadonlyArray<ProviderOptionSelection> }
      : {}),
  };
}

export function applyCustomAgentPrompt(input: {
  readonly prompt: string | undefined;
  readonly modelSelection: ModelSelection | null | undefined;
  readonly customAgents: ReadonlyArray<ProviderCustomAgent> | null | undefined;
}): string | undefined {
  const selectedAgent = getSelectedCustomAgent({
    modelSelection: input.modelSelection,
    customAgents: input.customAgents,
  });
  if (!selectedAgent) {
    return input.prompt;
  }

  const prompt = input.prompt?.trim();
  const userRequest = prompt && prompt.length > 0 ? prompt : "Use the attached context.";
  const description = selectedAgent.description?.trim();
  const descriptionBlock = description ? `\nDescription:\n${description}\n` : "";
  return `Custom agent: ${selectedAgent.name.trim()}${descriptionBlock}\nInstructions:\n${selectedAgent.instructions.trim()}\n\nUser request:\n${userRequest}`;
}

export function applyCodexNativeCustomAgentPrompt(input: {
  readonly prompt: string | undefined;
  readonly modelSelection: ModelSelection | null | undefined;
  readonly customAgents: ReadonlyArray<ProviderCustomAgent> | null | undefined;
}): string | undefined {
  const selectedAgent = getSelectedCustomAgent({
    modelSelection: input.modelSelection,
    customAgents: input.customAgents,
  });
  if (!selectedAgent) {
    return input.prompt;
  }

  const prompt = input.prompt?.trim();
  const userRequest = prompt && prompt.length > 0 ? prompt : "Use the attached context.";
  return `Use the Codex custom agent named "${selectedAgent.name.trim()}" from ${selectedAgent.id}.toml for this task.\n\nUser request:\n${userRequest}`;
}
