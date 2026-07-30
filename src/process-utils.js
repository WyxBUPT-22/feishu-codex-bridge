import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

export class ProcessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProcessError";
    this.details = details;
  }
}

export function spawnCommand(spec, args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: false,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  };
  if (options.signal != null) spawnOptions.signal = options.signal;
  return spawn(spec.command, [...spec.prefixArgs, ...args], spawnOptions);
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return true;
  let timeout;
  try {
    await Promise.race([
      once(child, "close"),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  return hasExited(child);
}

async function killWindowsProcessTree(child, spawnImpl) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const taskkill = spawnImpl(
    path.join(systemRoot, "System32", "taskkill.exe"),
    ["/PID", String(child.pid), "/T", "/F"],
    { windowsHide: true, shell: false, stdio: "ignore" },
  );
  await once(taskkill, "close");
}

export async function terminateProcessTree(
  child,
  { platform = process.platform, spawnImpl = spawn, timeoutMs = 10_000 } = {},
) {
  if (!child?.pid || hasExited(child)) return false;
  try {
    if (platform === "win32") {
      await killWindowsProcessTree(child, spawnImpl);
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    if (!hasExited(child)) child.kill();
  }
  if (await waitForExit(child, timeoutMs)) return true;
  if (!hasExited(child)) child.kill("SIGKILL");
  return waitForExit(child, timeoutMs);
}

export async function collectCommand(spec, args, options = {}) {
  const child = spawnCommand(spec, args, options);
  const stdout = [];
  const stderr = [];

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => stdout.push(chunk));
  child.stderr?.on("data", (chunk) => stderr.push(chunk));

  let timeout;
  if (options.timeoutMs) {
    timeout = setTimeout(() => child.kill(), options.timeoutMs);
    timeout.unref?.();
  }

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));

  const output = {
    ...result,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
  if (result.code !== 0 && !options.allowFailure) {
    throw new ProcessError(
      `${spec.displayName} exited with code ${result.code ?? "unknown"}`,
      output,
    );
  }
  return output;
}

export function readLines(stream, onLine) {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  lines.on("line", onLine);
  return lines;
}
