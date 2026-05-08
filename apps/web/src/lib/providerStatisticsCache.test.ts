import { describe, expect, it } from "vitest";

import { mergeCodexUsageHistoryThreads } from "./providerStatisticsCache";

describe("providerStatisticsCache", () => {
  it("keeps the newest cached Codex history row for each thread", () => {
    const merged = mergeCodexUsageHistoryThreads(
      [
        {
          threadId: "thread-a",
          sourceKind: "cli",
          sourceLabel: "Codex CLI",
          tokensUsed: 100,
          createdAt: "2026-05-07T00:00:00.000Z",
          updatedAt: "2026-05-07T00:00:00.000Z",
          model: "gpt-5.4",
        },
      ],
      [
        {
          threadId: "thread-a",
          sourceKind: "cli",
          sourceLabel: "Codex CLI",
          tokensUsed: 250,
          createdAt: "2026-05-07T00:00:00.000Z",
          updatedAt: "2026-05-08T00:00:00.000Z",
          model: "gpt-5.5",
        },
        {
          threadId: "thread-b",
          sourceKind: "vscode",
          sourceLabel: "Codex VS Code",
          tokensUsed: 50,
          createdAt: "2026-05-08T00:00:00.000Z",
          updatedAt: "2026-05-08T00:00:00.000Z",
        },
      ],
    );

    expect(merged).toEqual([
      expect.objectContaining({ threadId: "thread-a", tokensUsed: 250, model: "gpt-5.5" }),
      expect.objectContaining({ threadId: "thread-b", tokensUsed: 50 }),
    ]);
  });
});
