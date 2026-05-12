#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;

const logs = [];
let pairingUrl = null;

function log(line) {
  logs.push(line);
  if (logs.length > 300) {
    logs.shift();
  }
  const matches = line.matchAll(/pairingUrl:\s*(http:\/\/[^\s]+)/g);
  for (const match of matches) {
    if (match[1]) {
      pairingUrl = match[1];
    }
  }
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findPortOffset() {
  for (let offset = 1_200; offset < 2_000; offset += 1) {
    const serverPort = BASE_SERVER_PORT + offset;
    const webPort = BASE_WEB_PORT + offset;
    if ((await canListen(serverPort)) && (await canListen(webPort))) {
      return offset;
    }
  }
  throw new Error("No free local port pair found for the GPT-5.5 e2e smoke test.");
}

async function waitForHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "no response"}`);
}

async function waitForPairingUrl(timeoutMs = 90_000, stableMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let observedUrl = null;
  let observedAt = 0;
  while (Date.now() < deadline) {
    if (pairingUrl) {
      if (pairingUrl !== observedUrl) {
        observedUrl = pairingUrl;
        observedAt = Date.now();
      } else if (Date.now() - observedAt >= stableMs) {
        return pairingUrl;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the server pairing URL.");
}

async function waitForEnabled(locator, timeoutMs = 30_000) {
  const handle = await locator.elementHandle({ timeout: timeoutMs });
  if (!handle) {
    throw new Error("Expected locator to resolve to an element.");
  }
  await handle.waitForElementState("enabled", { timeout: timeoutMs });
}

async function safeText(locator, timeoutMs = 500) {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return ((await locator.textContent({ timeout: timeoutMs })) ?? "").trim();
  } catch {
    return "";
  }
}

async function safeAllText(locator) {
  try {
    return (await locator.allTextContents()).map((text) => text.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function safeMockLog(mockLog) {
  try {
    return await fs.readFile(mockLog, "utf8");
  } catch {
    return "";
  }
}

async function removeTempRoot(tmpRoot) {
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  console.warn(
    `Verified GPT-5.5 app multi-turn, but could not remove temporary test root ${tmpRoot}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function selectGpt55Model(page) {
  const modelButton = page.getByRole("button", { name: /Model:/ });
  await modelButton.waitFor({ state: "visible", timeout: 30_000 });

  const deadline = Date.now() + 90_000;
  let lastPanelText = "";
  let lastMenuItems = [];
  let lastButtonLabel =
    (await modelButton.getAttribute("aria-label")) ?? (await modelButton.textContent()) ?? "";

  while (Date.now() < deadline) {
    lastButtonLabel =
      (await modelButton.getAttribute("aria-label")) ?? (await modelButton.textContent()) ?? "";
    if (/GPT-5\.5/.test(lastButtonLabel)) {
      return;
    }

    await modelButton.click();
    const panel = page.getByTestId("composer-model-dropdown-panel");
    lastPanelText = await safeText(panel, 2_000);
    lastMenuItems = await safeAllText(page.getByRole("menuitemradio"));

    const gpt55Option = page.getByRole("menuitemradio", { name: /GPT-5\.5/ }).first();
    if ((await gpt55Option.count()) > 0) {
      await gpt55Option.click();
      await page.getByRole("button", { name: /Model: .*GPT-5\.5/ }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      return;
    }

    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(1_000);
  }

  throw new Error(
    [
      "Timed out waiting for GPT-5.5 in the model dropdown.",
      `Last model button label: ${JSON.stringify(lastButtonLabel)}`,
      `Last dropdown panel text: ${JSON.stringify(lastPanelText)}`,
      `Last menu items: ${JSON.stringify(lastMenuItems)}`,
    ].join("\n"),
  );
}

async function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(done, 10_000);
      killer.once("exit", done);
      killer.once("error", done);
    });
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (child.exitCode === null) {
      child.kill();
      child.unref();
    }
    return;
  }

  child.kill("SIGTERM");
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (child.exitCode === null) {
    child.unref();
  }
}

function parseMockLog(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "t3-gpt55-e2e-"));
  const mockBin = path.join(tmpRoot, "bin");
  const t3Home = path.join(tmpRoot, "home");
  const codexHome = path.join(tmpRoot, "codex-home");
  const mockLog = path.join(tmpRoot, "mock-codex.ndjson");
  const settingsDir = path.join(t3Home, "dev");
  const settingsPath = path.join(settingsDir, "settings.json");
  await fs.mkdir(mockBin, { recursive: true });
  await fs.mkdir(t3Home, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(settingsDir, { recursive: true });

  const mockCliPath = path.join(SCRIPT_DIR, "mock-codex-cli.mjs");
  const codexCmdPath = path.join(mockBin, "codex.cmd");
  await fs.writeFile(
    codexCmdPath,
    `@echo off\r\n"${process.execPath}" "${mockCliPath}" %*\r\n`,
    "utf8",
  );
  await fs.writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        textGenerationModelSelection: { instanceId: "codex", model: "gpt-5.5" },
        providers: {
          codex: {
            enabled: true,
            binaryPath: codexCmdPath,
            homePath: codexHome,
            shadowHomePath: "",
            customModels: [],
          },
          claudeAgent: {
            enabled: false,
            binaryPath: "claude",
            homePath: "",
            customModels: [],
            launchArgs: "",
          },
          cursor: {
            enabled: false,
            binaryPath: "agent",
            apiEndpoint: "",
            customModels: [],
          },
          copilot: {
            enabled: false,
            binaryPath: "copilot",
            homePath: "",
            customModels: [],
          },
          opencode: {
            enabled: false,
            binaryPath: "opencode",
            serverUrl: "",
            serverPassword: "",
            customModels: [],
          },
        },
        providerInstances: {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const offset = await findPortOffset();
  const serverPort = BASE_SERVER_PORT + offset;
  const webPort = BASE_WEB_PORT + offset;
  const webUrl = `http://localhost:${webPort}`;
  const env = {
    ...process.env,
    PATH: `${mockBin}${path.delimiter}${process.env.PATH ?? ""}`,
    Path: `${mockBin}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}`,
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    T3CODE_HOME: t3Home,
    T3CODE_PORT: String(serverPort),
    T3CODE_PORT_OFFSET: String(offset),
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "1",
    T3CODE_NO_BROWSER: "1",
    T3CODE_MOCK_CODEX_LOG: mockLog,
    T3CODE_TELEMETRY_ENABLED: "false",
  };

  const child = spawn(
    process.execPath,
    [
      "scripts/dev-runner.ts",
      "dev",
      "--no-browser",
      "--auto-bootstrap-project-from-cwd",
      "--",
      "--env-mode=loose",
    ],
    {
      cwd: REPO_ROOT,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => log(chunk.trimEnd()));
  child.stderr.on("data", (chunk) => log(chunk.trimEnd()));

  const playwrightModulePath = path.join(
    REPO_ROOT,
    "apps",
    "web",
    "node_modules",
    "playwright",
    "index.mjs",
  );
  const { chromium } = await import(pathToFileURL(playwrightModulePath).href);
  let browser;
  let failed = false;
  try {
    await waitForHttp(webUrl);
    await waitForPairingUrl();
    await waitForHttp(`${webUrl}/.well-known/t3/environment`, 30_000);
    const authenticatedUrl = await waitForPairingUrl(30_000, 500);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("console", (message) => {
      if (message.type() === "error") {
        log(`[browser console] ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      log(`[browser pageerror] ${error.message}`);
    });

    await page.goto(authenticatedUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("composer-editor").waitFor({ state: "visible", timeout: 60_000 });

    await selectGpt55Model(page);

    async function sendPrompt(prompt, expectedResponse) {
      const editor = page.getByTestId("composer-editor");
      await editor.fill(prompt);
      const sendButton = page.getByRole("button", { name: "Send message" });
      await sendButton.waitFor({ state: "visible", timeout: 30_000 });
      await waitForEnabled(sendButton);
      await sendButton.click();
      await page.getByText(expectedResponse).waitFor({ state: "visible", timeout: 60_000 });
      const nextSendButton = page.getByRole("button", { name: "Send message" });
      await nextSendButton.waitFor({ state: "visible", timeout: 60_000 });
      await page.getByRole("button", { name: "Stop generation" }).waitFor({
        state: "detached",
        timeout: 60_000,
      });
    }

    await sendPrompt("first GPT-5.5 smoke message", "Mock GPT-5.5 response 1");
    await sendPrompt("second GPT-5.5 smoke message", "Mock GPT-5.5 response 2");

    const mockLogRaw = await fs.readFile(mockLog, "utf8");
    const entries = parseMockLog(mockLogRaw);
    const turnStarts = entries.filter(
      (entry) => entry.direction === "incoming" && entry.method === "turn/start",
    );
    const steers = entries.filter(
      (entry) => entry.direction === "incoming" && entry.method === "turn/steer",
    );

    if (turnStarts.length !== 2) {
      throw new Error(`Expected exactly 2 turn/start calls, saw ${turnStarts.length}.`);
    }
    for (const [index, entry] of turnStarts.entries()) {
      if (entry.params?.model !== "gpt-5.5") {
        throw new Error(
          `Expected turn/start #${index + 1} to use gpt-5.5, saw ${JSON.stringify(entry.params?.model)}.`,
        );
      }
    }
    if (steers.length !== 0) {
      throw new Error(`Expected no turn/steer calls after completion, saw ${steers.length}.`);
    }

    console.log(
      `Verified GPT-5.5 app multi-turn at ${webUrl}: two UI sends produced two turn/start calls and zero turn/steer calls.`,
    );
  } catch (error) {
    failed = true;
    console.error("GPT-5.5 app multi-turn smoke failed.");
    console.error(error instanceof Error ? error.stack : error);
    const mockLogRaw = await safeMockLog(mockLog);
    if (mockLogRaw) {
      console.error("Mock Codex RPC log:");
      console.error(mockLogRaw);
    }
    console.error(`Temporary test root retained for inspection: ${tmpRoot}`);
    console.error("Recent app logs:");
    console.error(logs.join("\n"));
    throw error;
  } finally {
    if (browser) {
      await Promise.race([
        browser.close(),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]).catch(() => {});
    }
    await terminateProcessTree(child);
    if (!failed) {
      await removeTempRoot(tmpRoot);
    }
  }
}

main().catch(() => {
  process.exitCode = 1;
});
