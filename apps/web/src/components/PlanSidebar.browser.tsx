import "../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import PlanSidebar from "./PlanSidebar";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function renderAgentSidebar() {
  const host = document.createElement("div");
  host.style.height = "720px";
  host.style.width = "360px";
  document.body.append(host);

  return render(
    <PlanSidebar
      activePlan={null}
      activeProposedPlan={null}
      activeTasks={{
        running: [
          {
            taskId: "task-agent-running",
            taskType: "agent",
            summary: "Duplicate generic task",
            detail: "This generic task should be hidden by the agent row.",
            status: "running",
            updatedAt: "2026-05-12T08:00:00.000Z",
          },
          {
            taskId: "task-regular-running",
            taskType: "shell",
            summary: "Run release smoke",
            detail: "bun run release:smoke",
            status: "running",
            updatedAt: "2026-05-12T08:01:00.000Z",
          },
        ],
        completed: [],
      }}
      agentActivity={{
        running: [
          {
            id: "agent-running",
            taskId: "task-agent-running",
            label: "Review release workflow",
            detail: "Checking nightly and stable GitHub assets.",
            status: "running",
            updatedAt: "2026-05-12T08:00:00.000Z",
            kindLabel: "agent",
          },
        ],
        recent: [
          {
            id: "agent-recent",
            taskId: "task-agent-recent",
            label: "Inspect upstream changes",
            detail: "Compared recent pingdotgg/t3code commits.",
            status: "completed",
            updatedAt: "2026-05-12T07:55:00.000Z",
            kindLabel: "agent",
          },
        ],
      }}
      label="Agents"
      environmentId={LOCAL_ENVIRONMENT_ID}
      markdownCwd={undefined}
      workspaceRoot={undefined}
      timestampFormat="24-hour"
      onClose={vi.fn()}
    />,
    { container: host },
  );
}

describe("PlanSidebar agent activity", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders agent activity separately from generic task rows", async () => {
    const screen = await renderAgentSidebar();

    try {
      await expect.element(page.getByText("Agents", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("Review release workflow")).toBeInTheDocument();
      await expect
        .element(page.getByText("Checking nightly and stable GitHub assets."))
        .toBeInTheDocument();
      await expect.element(page.getByText("Inspect upstream changes")).toBeInTheDocument();
      await expect.element(page.getByText("Run release smoke")).toBeInTheDocument();
      await expect.element(page.getByText("Duplicate generic task")).not.toBeInTheDocument();

      await expect
        .element(page.getByText("Compared recent pingdotgg/t3code commits."))
        .not.toBeInTheDocument();

      await page.getByRole("button", { name: "Inspect upstream changes agent Done" }).click();

      await expect
        .element(page.getByText("Compared recent pingdotgg/t3code commits."))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
