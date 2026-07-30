import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./app-server-client.js";
import {
  assertIsolatedHookList,
  assertIsolatedConfig,
  isolationArgs,
} from "./app-server-isolation.js";
import { requireSupportedCodexVersion } from "./codex-version.js";
import { HOOK_COMMAND_TIMEOUT_SECONDS } from "./hook-approval-server.js";

const HOOK_SOURCE_PATH = fileURLToPath(new URL("./pre-tool-approval-hook.mjs", import.meta.url));
const HOOK_SUPPORT_SOURCE_PATH = fileURLToPath(new URL("./hook-approval-server.js", import.meta.url));
const ownedHookDirectories = new Set();

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function syncFile(source, destination) {
  if (await exists(source)) {
    await copyFile(source, destination);
  } else if (await exists(destination)) {
    await unlink(destination);
  }
}

async function replaceControlledFile(source, destination) {
  if (await exists(destination)) {
    const stat = await lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Isolated Codex controlled path is not a regular file: ${destination}`);
    }
  }
  await copyFile(source, destination);
}

async function ensureControlledDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Isolated Codex controlled path is not a directory: ${directory}`);
  }
}

export async function resetIsolatedConfig(isolatedHome) {
  await ensureControlledDirectory(isolatedHome);
  const configPath = path.join(isolatedHome, "config.toml");
  if (await exists(configPath)) {
    const stat = await lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Isolated Codex config path is not a regular file: ${configPath}`);
    }
  }
  await writeFile(configPath, "# Managed by feishu-codex-bridge.\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function createIsolatedHookDirectory(isolatedHome) {
  const hookRoot = path.join(isolatedHome, "bridge-hooks");
  await ensureControlledDirectory(hookRoot);
  const hookDirectory = await mkdtemp(path.join(hookRoot, `instance-${process.pid}-`));
  const stat = await lstat(hookDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    await rm(hookDirectory, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Isolated Codex hook path is not a directory: ${hookDirectory}`);
  }
  ownedHookDirectories.add(hookDirectory);
  return hookDirectory;
}

async function removeIsolatedHookDirectory(hookDirectory) {
  if (!ownedHookDirectories.has(hookDirectory)) {
    throw new Error(`Refusing to remove an unowned isolated hook directory: ${hookDirectory}`);
  }
  await rm(hookDirectory, { recursive: true, force: true });
  ownedHookDirectories.delete(hookDirectory);
}

export function attachHookDirectoryCleanup(client, hookDirectory) {
  const originalStop = client.stop.bind(client);
  let cleanupPromise = null;
  const cleanup = () => {
    cleanupPromise ??= removeIsolatedHookDirectory(hookDirectory);
    return cleanupPromise;
  };
  const onClose = () => {
    void cleanup().catch((error) => {
      client.emit?.("warning", `Failed to remove isolated hook directory: ${error.message}`);
    });
  };
  client.on?.("close", onClose);
  client.stop = async (...args) => {
    let result;
    let stopError = null;
    try {
      result = await originalStop(...args);
    } catch (error) {
      stopError = error;
    }
    client.off?.("close", onClose);
    let cleanupError = null;
    try {
      await cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (stopError) {
      if (stopError instanceof Error && stopError.cause === undefined && cleanupError) {
        stopError.cause = cleanupError;
      }
      throw stopError;
    }
    if (cleanupError) throw cleanupError;
    return result;
  };
  return client;
}

export function startupShutdownError(reason) {
  const error = new Error("Bridge startup was interrupted by shutdown");
  error.name = "AbortError";
  error.code = "STARTUP_SHUTDOWN";
  if (reason instanceof Error) error.cause = reason;
  return error;
}

export function awaitStartupOperation(client, operation, signal) {
  if (!signal) return Promise.resolve(operation);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      const error = startupShutdownError(signal.reason);
      Promise.resolve()
        .then(() => client?.stop())
        .catch((stopError) => {
          if (error.cause === undefined) error.cause = stopError;
        })
        .finally(() => reject(error));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function throwIfStartupAborted(signal) {
  if (signal?.aborted) throw startupShutdownError(signal.reason);
}

function withoutCommandMetacharacters(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0"]/.test(value)) {
    throw new Error(`Unsafe ${label} for approval hook launcher`);
  }
  return value;
}

function batchQuote(value, label) {
  return `"${withoutCommandMetacharacters(value, label).replaceAll("%", "%%")}"`;
}

function shellQuote(value, label) {
  return `'${withoutCommandMetacharacters(value, label).replaceAll("'", `'"'"'`)}'`;
}

async function writeHookLauncher(hookDirectory, hookScriptPath, endpoint) {
  if (process.platform === "win32") {
    const launcherPath = path.join(hookDirectory, "pre-tool-approval-launcher.cmd");
    if (await exists(launcherPath)) {
      const stat = await lstat(launcherPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Isolated Codex hook launcher is not a regular file: ${launcherPath}`);
      }
    }
    const content = [
      "@echo off",
      "setlocal DisableDelayedExpansion",
      `${batchQuote(process.execPath, "Node executable")} ${batchQuote(hookScriptPath, "hook script")} ${batchQuote(endpoint, "hook endpoint")}`,
      "if errorlevel 1 (",
      "  >&2 echo PreToolUse approval hook failed closed",
      "  exit /b 2",
      ")",
      "exit /b 0",
      "",
    ].join("\r\n");
    await writeFile(launcherPath, content, "utf8");
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const cmdPath = path.join(systemRoot, "System32", "cmd.exe");
    if (/\s/.test(cmdPath)) throw new Error("Unsafe Windows command processor path");
    const command = `${cmdPath} /d /s /c call ${batchQuote(launcherPath, "hook launcher")}`;
    return { hookCommand: command, hookCommandWindows: command };
  }

  const launcherPath = path.join(hookDirectory, "pre-tool-approval-launcher.sh");
  if (await exists(launcherPath)) {
    const stat = await lstat(launcherPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Isolated Codex hook launcher is not a regular file: ${launcherPath}`);
    }
  }
  const content = [
    "#!/bin/sh",
    `if ${shellQuote(process.execPath, "Node executable")} ${shellQuote(hookScriptPath, "hook script")} ${shellQuote(endpoint, "hook endpoint")}; then`,
    "  exit 0",
    "fi",
    "echo 'PreToolUse approval hook failed closed' >&2",
    "exit 2",
    "",
  ].join("\n");
  await writeFile(launcherPath, content, { encoding: "utf8", mode: 0o700 });
  await chmod(launcherPath, 0o700);
  return { hookCommand: `/bin/sh ${shellQuote(launcherPath, "hook launcher")}`, hookCommandWindows: null };
}

async function ensureDirectoryLink(source, destination) {
  if (!(await exists(source))) return;
  if (await exists(destination)) {
    const stat = await lstat(destination);
    if (!stat.isSymbolicLink()) {
      throw new Error(`Isolated Codex path is not a directory link: ${destination}`);
    }
    const target = path.resolve(path.dirname(destination), await readlink(destination));
    if (path.resolve(source) !== target) {
      throw new Error(`Isolated Codex path points to an unexpected target: ${destination}`);
    }
    return;
  }
  await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
}

async function prepareIsolatedHome(hookEndpoint) {
  const sourceHome = path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
  const isolatedHome = path.join(
    process.platform === "win32"
      ? process.env.LOCALAPPDATA ?? os.tmpdir()
      : process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
    "feishu-codex-bridge",
    "codex-home",
  );
  await mkdir(isolatedHome, { recursive: true });
  await resetIsolatedConfig(isolatedHome);
  await syncFile(path.join(sourceHome, "auth.json"), path.join(isolatedHome, "auth.json"));
  await syncFile(path.join(sourceHome, "installation_id"), path.join(isolatedHome, "installation_id"));
  await ensureDirectoryLink(path.join(sourceHome, "sessions"), path.join(isolatedHome, "sessions"));
  await ensureDirectoryLink(
    path.join(sourceHome, "archived_sessions"),
    path.join(isolatedHome, "archived_sessions"),
  );
  const hookDirectory = await createIsolatedHookDirectory(isolatedHome);
  const hookScriptPath = path.join(hookDirectory, "pre-tool-approval-hook.mjs");
  const hookSupportPath = path.join(hookDirectory, "hook-approval-server.js");
  try {
    await Promise.all([
      replaceControlledFile(HOOK_SOURCE_PATH, hookScriptPath),
      replaceControlledFile(HOOK_SUPPORT_SOURCE_PATH, hookSupportPath),
    ]);
    const commands = await writeHookLauncher(hookDirectory, hookScriptPath, hookEndpoint);
    return { sourceHome, isolatedHome, hookDirectory, ...commands };
  } catch (error) {
    await removeIsolatedHookDirectory(hookDirectory).catch(() => {});
    throw error;
  }
}

export async function startIsolatedAppServer(codexTool, {
  repositoryPath,
  hookEndpoint,
  signal = null,
}) {
  if (typeof hookEndpoint !== "string" || hookEndpoint.length === 0) {
    throw new Error("Approval hook endpoint is required for isolated Codex app-server");
  }
  throwIfStartupAborted(signal);
  try {
    await requireSupportedCodexVersion(codexTool, { signal });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR") {
      throw startupShutdownError(signal?.reason ?? error);
    }
    throw error;
  }
  throwIfStartupAborted(signal);
  const {
    sourceHome,
    isolatedHome,
    hookDirectory,
    hookCommand,
    hookCommandWindows,
  } = await prepareIsolatedHome(hookEndpoint);
  const expectedHook = {
    hookCommand,
    hookCommandWindows,
    hookTimeoutSeconds: HOOK_COMMAND_TIMEOUT_SECONDS,
  };

  const startVerifiedClient = async (trustArgs, allowedTrustStatuses) => {
    const client = new CodexAppServerClient(codexTool, {
      cwd: isolatedHome,
      extraArgs: [
        ...isolationArgs(expectedHook),
        ...trustArgs,
        "--config",
        `sqlite_home=${JSON.stringify(sourceHome)}`,
      ],
      environmentOverrides: { CODEX_HOME: isolatedHome },
    });
    const startupDiagnostics = [];
    const captureDiagnostic = (message) => {
      startupDiagnostics.push(String(message).slice(0, 2_000));
      if (startupDiagnostics.length > 8) startupDiagnostics.shift();
    };
    client.on("diagnostic", captureDiagnostic);
    try {
      await awaitStartupOperation(client, client.start(), signal);
      const isolated = await awaitStartupOperation(
        client,
        client.request("config/read", {
          includeLayers: false,
          cwd: repositoryPath,
        }),
        signal,
      );
      assertIsolatedConfig(isolated.config, expectedHook);
      const hooks = await awaitStartupOperation(
        client,
        client.request("hooks/list", { cwds: [repositoryPath] }),
        signal,
      );
      const hook = assertIsolatedHookList(hooks, expectedHook, { allowedTrustStatuses });
      client.off("diagnostic", captureDiagnostic);
      return { client, hook };
    } catch (error) {
      await client.stop().catch(() => {});
      client.off("diagnostic", captureDiagnostic);
      if (error?.code === "STARTUP_SHUTDOWN" || error?.name === "AbortError") {
        throw error;
      }
      const detail = startupDiagnostics.length > 0 ? ` (${startupDiagnostics.join(" | ")})` : "";
      throw new Error(`${error.message}${detail}`, { cause: error });
    }
  };

  let cleanupTransferred = false;
  try {
    throwIfStartupAborted(signal);
    const bootstrap = await startVerifiedClient([], ["untrusted", "trusted"]);
    await bootstrap.client.stop();
    throwIfStartupAborted(signal);
    const { key, currentHash } = bootstrap.hook;
    if (typeof key !== "string" || key.length === 0
      || typeof currentHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(currentHash)) {
      throw new Error("Codex app-server isolation failed (invalid approval hook trust identity)");
    }
    const trustState = `hooks.state={${JSON.stringify(key)}={trusted_hash=${JSON.stringify(currentHash)}}}`;
    const verified = await startVerifiedClient(["--config", trustState], ["trusted"]);
    if (signal?.aborted) {
      await verified.client.stop().catch(() => {});
      throw startupShutdownError(signal.reason);
    }
    attachHookDirectoryCleanup(verified.client, hookDirectory);
    cleanupTransferred = true;
    return verified.client;
  } finally {
    if (!cleanupTransferred) {
      await removeIsolatedHookDirectory(hookDirectory).catch(() => {});
    }
  }
}
