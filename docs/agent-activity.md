# Agent Activity

The chat sidebar can show live agent activity for providers that emit structured task or
collaboration-agent tool events.

## What appears

- Running subagent task progress from `task.started`, `task.progress`, and `task.completed`.
- Collaboration agent tool calls from tool lifecycle events where `itemType` is
  `collab_agent_tool_call`.
- The latest summary/detail for each activity, including reasoning progress when the provider
  supplies it.

## UI behavior

- The composer footer shows an `Agents` sidebar toggle when agent activity exists.
- The sidebar auto-opens for running agent activity when `autoOpenPlanSidebar` is enabled.
- Agent task rows are hidden from the generic task list in the same sidebar to avoid duplicate
  entries.

Providers that do not emit structured subagent/task events will not populate this view.
