import { type ChildProcess as ChildProcessHandle, spawn, spawnSync } from "node:child_process";

export interface ProcessRunOptions {
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  allowNonZeroExit?: boolean | undefined;
  maxBufferBytes?: number | undefined;
  outputMode?: "error" | "truncate" | undefined;
  shell?: boolean | string | undefined;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated?: boolean | undefined;
  stderrTruncated?: boolean | undefined;
}

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function normalizeSpawnError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to run ${commandLabel(command, args)}.`);
  }

  const maybeCode = (error as NodeJS.ErrnoException).code;
  if (maybeCode === "ENOENT") {
    return new Error(`Command not found: ${command}`);
  }

  return new Error(`Failed to run ${commandLabel(command, args)}: ${error.message}`);
}

const WINDOWS_COMMAND_NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /n.o . reconhecido como um comando interno/i,
  /non . riconosciuto come comando interno o esterno/i,
  /n.est pas reconnu en tant que commande interne/i,
  /no se reconoce como un comando interno o externo/i,
  /wird nicht als interner oder externer befehl/i,
] as const;

function hasWindowsCommandNotFoundMessage(output: string): boolean {
  return WINDOWS_COMMAND_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(output));
}

export function isWindowsCommandNotFound(code: number | null, stderr: string): boolean {
  if (process.platform !== "win32") return false;
  if (code === 9009) return true;
  return hasWindowsCommandNotFoundMessage(stderr);
}

function normalizeExitError(
  command: string,
  args: readonly string[],
  result: ProcessRunResult,
): Error {
  if (isWindowsCommandNotFound(result.code, result.stderr)) {
    return new Error(`Command not found: ${command}`);
  }

  const reason = result.timedOut
    ? "timed out"
    : `failed (code=${result.code ?? "null"}, signal=${result.signal ?? "null"})`;
  const stderr = result.stderr.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(`${commandLabel(command, args)} ${reason}.${detail}`);
}

function normalizeStdinError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to write stdin for ${commandLabel(command, args)}.`);
  }
  return new Error(`Failed to write stdin for ${commandLabel(command, args)}: ${error.message}`);
}

function normalizeBufferError(
  command: string,
  args: readonly string[],
  stream: "stdout" | "stderr",
  maxBufferBytes: number,
): Error {
  return new Error(
    `${commandLabel(command, args)} exceeded ${stream} buffer limit (${maxBufferBytes} bytes).`,
  );
}

const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
function killChild(child: ChildProcessHandle, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fallback to direct kill
    }
  }
  child.kill(signal);
}

interface OutputBufferState {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function appendChunkWithinLimit(
  state: OutputBufferState,
  chunk: Buffer,
  maxBytes: number,
): {
  truncated: boolean;
} {
  const remaining = maxBytes - state.bytes;
  if (remaining <= 0) {
    return { truncated: true };
  }

  if (chunk.length <= remaining) {
    state.chunks.push(chunk);
    state.bytes += chunk.length;
    return { truncated: false };
  }

  state.chunks.push(chunk.subarray(0, remaining));
  state.bytes += remaining;
  return { truncated: true };
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const outputMode = options.outputMode ?? "error";

  return new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      shell: options.shell ?? false,
    });

    const stdoutState: OutputBufferState = { chunks: [], bytes: 0, truncated: false };
    const stderrState: OutputBufferState = { chunks: [], bytes: 0, truncated: false };
    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChild(child, "SIGKILL");
      }, 1_000);
    }, timeoutMs);

    const finalize = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      callback();
    };

    const fail = (error: Error): void => {
      killChild(child, "SIGTERM");
      finalize(() => {
        reject(error);
      });
    };

    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer | string): Error | null => {
      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const state = stream === "stdout" ? stdoutState : stderrState;

      if (outputMode === "truncate") {
        const appended = appendChunkWithinLimit(state, chunkBuffer, maxBufferBytes);
        state.truncated = state.truncated || appended.truncated;
        return null;
      }

      if (state.bytes + chunkBuffer.length > maxBufferBytes) {
        return normalizeBufferError(command, args, stream, maxBufferBytes);
      }
      state.chunks.push(chunkBuffer);
      state.bytes += chunkBuffer.length;
      return null;
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const error = appendOutput("stdout", chunk);
      if (error) {
        fail(error);
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const error = appendOutput("stderr", chunk);
      if (error) {
        fail(error);
      }
    });

    child.once("error", (error) => {
      finalize(() => {
        reject(normalizeSpawnError(command, args, error));
      });
    });

    child.once("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutState.chunks, stdoutState.bytes).toString();
      const stderr = Buffer.concat(stderrState.chunks, stderrState.bytes).toString();
      const result: ProcessRunResult = {
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        stdoutTruncated: stdoutState.truncated,
        stderrTruncated: stderrState.truncated,
      };

      finalize(() => {
        if (!options.allowNonZeroExit && (timedOut || (code !== null && code !== 0))) {
          reject(normalizeExitError(command, args, result));
          return;
        }
        resolve(result);
      });
    });

    child.stdin.once("error", (error) => {
      fail(normalizeStdinError(command, args, error));
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin, (error) => {
        if (error) {
          fail(normalizeStdinError(command, args, error));
          return;
        }
        child.stdin.end();
      });
      return;
    }
    child.stdin.end();
  });
}
