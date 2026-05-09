#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";

const args = process.argv.slice(2);
const logPath = process.env.T3CODE_MOCK_CODEX_LOG;
const cwd = process.cwd();
const codexHome = process.env.CODEX_HOME || cwd;
const cliVersion = "0.0.0-mock";

if (!args.includes("app-server")) {
  console.log(`codex-cli ${cliVersion}`);
  process.exit(0);
}

let buffer = "";
let turnCounter = 0;
const providerThreadId = `mock-thread-${process.pid}`;
const createdAt = Math.floor(Date.now() / 1000);

function appendLog(entry) {
  if (!logPath) {
    return;
  }
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
  appendLog({
    direction: "outgoing",
    method: message.method ?? null,
    id: message.id ?? null,
    result: message.result,
    params: message.params,
  });
}

function respond(id, result) {
  write({ id, result });
}

function respondError(id, code, message) {
  write({
    id,
    error: {
      code,
      message,
    },
  });
}

function notify(method, params) {
  write({ method, params });
}

function modelEntry(model, displayName, isDefault = false) {
  return {
    id: model,
    model,
    displayName,
    description: `${displayName} mock model`,
    hidden: false,
    isDefault,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low" },
      { reasoningEffort: "medium", description: "Medium" },
      { reasoningEffort: "high", description: "High" },
      { reasoningEffort: "xhigh", description: "Extra High" },
    ],
    inputModalities: ["text", "image"],
    supportsPersonality: false,
  };
}

function threadResponse(model = "gpt-5.5") {
  return {
    cwd,
    model,
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      id: providerThreadId,
      cliVersion,
      createdAt,
      cwd,
      ephemeral: false,
      modelProvider: "openai",
      preview: "",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
      updatedAt: Math.floor(Date.now() / 1000),
    },
  };
}

function turnPayload(turnId, status, startedAt, completedAt = undefined) {
  return {
    id: turnId,
    items: [],
    startedAt,
    ...(completedAt !== undefined
      ? { completedAt, durationMs: (completedAt - startedAt) * 1000 }
      : {}),
    status,
  };
}

function scheduleTurnNotifications(params, turnId, responseText) {
  const threadId = params.threadId || providerThreadId;
  const startedAt = Math.floor(Date.now() / 1000);
  const itemId = `mock-item-${turnId}`;

  setTimeout(() => {
    notify("turn/started", {
      threadId,
      turn: turnPayload(turnId, "inProgress", startedAt),
    });
  }, 10);

  setTimeout(() => {
    notify("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId,
      delta: responseText,
    });
  }, 30);

  setTimeout(() => {
    notify("item/completed", {
      threadId,
      turnId,
      item: {
        id: itemId,
        type: "agentMessage",
        text: responseText,
      },
    });
  }, 50);

  setTimeout(() => {
    const completedAt = Math.floor(Date.now() / 1000);
    notify("turn/completed", {
      threadId,
      turn: turnPayload(turnId, "completed", startedAt, completedAt),
    });
  }, 80);
}

function handleRequest(message) {
  const { id, method, params } = message;
  appendLog({ direction: "incoming", id: id ?? null, method, params });

  if (id === undefined || id === null) {
    return;
  }

  switch (method) {
    case "initialize":
      respond(id, {
        codexHome,
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: os.platform(),
        userAgent: `codex-cli/${cliVersion} mock`,
      });
      return;
    case "account/read":
      respond(id, {
        account: {
          type: "chatgpt",
          email: "mock-codex@example.test",
          planType: "plus",
        },
        requiresOpenaiAuth: false,
      });
      return;
    case "account/rateLimits/read":
      respond(id, {
        rateLimits: {},
        rateLimitsByLimitId: {},
      });
      return;
    case "skills/list":
      respond(id, {
        data: (params?.cwds ?? [cwd]).map((entry) => ({
          cwd: entry,
          skills: [],
          errors: [],
        })),
      });
      return;
    case "model/list":
      respond(id, {
        data: [modelEntry("gpt-5.5", "GPT-5.5", true), modelEntry("gpt-5.4", "GPT-5.4")],
      });
      return;
    case "thread/start":
    case "thread/resume":
      respond(id, threadResponse(params?.model ?? "gpt-5.5"));
      return;
    case "thread/read":
      respond(id, threadResponse(params?.model ?? "gpt-5.5").thread);
      return;
    case "turn/start": {
      const turnId = `mock-turn-${++turnCounter}`;
      const responseText = `Mock GPT-5.5 response ${turnCounter}`;
      const startedAt = Math.floor(Date.now() / 1000);
      respond(id, {
        turn: turnPayload(turnId, "inProgress", startedAt),
      });
      scheduleTurnNotifications(params ?? {}, turnId, responseText);
      return;
    }
    case "turn/steer":
      respond(id, {
        turnId: params?.expectedTurnId ?? `mock-steer-${++turnCounter}`,
      });
      return;
    case "turn/interrupt":
    case "thread/name/set":
    case "thread/archive":
    case "thread/unarchive":
    case "thread/close":
      respond(id, {});
      return;
    default:
      respondError(id, -32601, `Mock Codex app-server does not implement ${method}`);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const raw = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!raw) {
      continue;
    }

    try {
      handleRequest(JSON.parse(raw));
    } catch (error) {
      appendLog({
        direction: "parse-error",
        raw,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
