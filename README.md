# T3 Code

T3 Code is a minimal web GUI for coding agents.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, GitHub Copilot CLI, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Copilot: install [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) and run `copilot login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3
```

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/ProtonDev-sys/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)

Agent activity guide: [docs/agent-activity.md](./docs/agent-activity.md)

Release checklist: [docs/release.md](./docs/release.md)

Usage limits in Settings show account-level provider limits reported by Codex and GitHub Copilot CLI. The Statistics page only uses usage generated inside T3 Code; Codex local history is intentionally ignored because its cost estimate is not reliable enough for totals.

## If you REALLY want to contribute still.... read this first

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install .
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
