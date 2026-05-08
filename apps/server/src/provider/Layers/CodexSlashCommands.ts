import type { ServerProviderSlashCommand } from "@t3tools/contracts";

export const CODEX_SLASH_COMMANDS = [
  {
    name: "model",
    description: "Choose what model and reasoning effort to use",
  },
  {
    name: "fast",
    description: "Toggle Fast mode to enable fastest inference with increased plan usage",
    input: { hint: "on | off | status" },
  },
  {
    name: "approvals",
    description: "Choose what Codex is allowed to do",
  },
  {
    name: "permissions",
    description: "Choose what Codex is allowed to do",
  },
  {
    name: "keymap",
    description: "Remap TUI shortcuts",
  },
  {
    name: "setup-default-sandbox",
    description: "Set up elevated agent sandbox",
  },
  {
    name: "sandbox-add-read-dir",
    description: "Let sandbox read a directory",
    input: { hint: "absolute_path" },
  },
  {
    name: "experimental",
    description: "Toggle experimental features",
  },
  {
    name: "autoreview",
    description: "Approve one retry of a recent auto-review denial",
  },
  {
    name: "memories",
    description: "Configure memory use and generation",
  },
  {
    name: "skills",
    description: "Use skills to improve how Codex performs specific tasks",
  },
  {
    name: "review",
    description: "Review current changes and find issues",
    input: { hint: "optional review instructions" },
  },
  {
    name: "rename",
    description: "Rename the current thread",
    input: { hint: "thread name" },
  },
  {
    name: "new",
    description: "Start a new chat during a conversation",
  },
  {
    name: "resume",
    description: "Resume a saved chat",
    input: { hint: "session id or name" },
  },
  {
    name: "fork",
    description: "Fork the current chat",
  },
  {
    name: "init",
    description: "Create an AGENTS.md file with instructions for Codex",
  },
  {
    name: "compact",
    description: "Summarize conversation to prevent hitting the context limit",
  },
  {
    name: "plan",
    description: "Switch to Plan mode",
    input: { hint: "optional prompt" },
  },
  {
    name: "goal",
    description: "Set or view the goal for a long-running task",
    input: { hint: "objective | clear | pause | resume" },
  },
  {
    name: "collab",
    description: "Change collaboration mode",
  },
  {
    name: "agent",
    description: "Switch the active agent thread",
  },
  {
    name: "side",
    description: "Start a side conversation in an ephemeral fork",
    input: { hint: "prompt" },
  },
  {
    name: "copy",
    description: "Copy last response as markdown",
  },
  {
    name: "diff",
    description: "Show git diff, including untracked files",
  },
  {
    name: "mention",
    description: "Mention a file",
  },
  {
    name: "status",
    description: "Show current session configuration and token usage",
  },
  {
    name: "debug-config",
    description: "Show config layers and requirement sources for debugging",
  },
  {
    name: "title",
    description: "Configure which items appear in the terminal title",
  },
  {
    name: "statusline",
    description: "Configure which items appear in the status line",
  },
  {
    name: "theme",
    description: "Choose a syntax highlighting theme",
  },
  {
    name: "mcp",
    description: "List configured MCP tools",
    input: { hint: "verbose" },
  },
  {
    name: "apps",
    description: "Manage apps",
  },
  {
    name: "plugins",
    description: "Browse plugins",
  },
  {
    name: "logout",
    description: "Log out of Codex",
  },
  {
    name: "quit",
    description: "Exit Codex",
  },
  {
    name: "exit",
    description: "Exit Codex",
  },
  {
    name: "feedback",
    description: "Send logs to maintainers",
  },
  {
    name: "rollout",
    description: "Print the rollout file path",
  },
  {
    name: "ps",
    description: "List background terminals",
  },
  {
    name: "stop",
    description: "Stop all background terminals",
  },
  {
    name: "clear",
    description: "Clear the terminal and start a new chat",
  },
  {
    name: "personality",
    description: "Choose a communication style for Codex",
  },
  {
    name: "realtime",
    description: "Toggle realtime voice mode",
  },
  {
    name: "settings",
    description: "Configure realtime microphone/speaker",
  },
  {
    name: "test-approval",
    description: "Test approval requests",
  },
  {
    name: "subagents",
    description: "Switch the active agent thread",
  },
  {
    name: "debug-m-drop",
    description: "DO NOT USE",
  },
  {
    name: "debug-m-update",
    description: "DO NOT USE",
  },
] as const satisfies ReadonlyArray<ServerProviderSlashCommand>;

export type CodexProviderSlashCommandName = (typeof CODEX_SLASH_COMMANDS)[number]["name"];

export type CodexProviderSlashCommand = {
  readonly command: CodexProviderSlashCommandName;
  readonly args: string;
};

const CODEX_PROVIDER_SLASH_COMMAND_NAMES = new Set<string>(
  CODEX_SLASH_COMMANDS.map((command) => command.name),
);

export function parseCodexProviderSlashCommand(
  input: string | undefined,
): CodexProviderSlashCommand | null {
  const trimmed = input?.trim();
  if (!trimmed?.startsWith("/")) {
    return null;
  }
  const match = /^\/([a-zA-Z][a-zA-Z0-9-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const command = match[1]?.toLowerCase();
  const args = (match[2] ?? "").trim();
  if (!command || !CODEX_PROVIDER_SLASH_COMMAND_NAMES.has(command)) {
    return null;
  }
  return { command: command as CodexProviderSlashCommandName, args };
}
