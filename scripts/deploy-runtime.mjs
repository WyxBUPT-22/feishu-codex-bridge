#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertConfigSourceUnchanged,
  canonicalConfigPath,
  inspectCanonicalConfig,
} from "../src/config.js";
import { requestBridgeShutdown } from "../src/instance-lock.js";
import {
  createRuntimeSnapshot,
  runtimeSourceFingerprint,
  verifyRuntimeSnapshot,
} from "../src/runtime-snapshot.js";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

function usage() {
  return [
    "Usage: npm run deploy -- [options]",
    "  --config <canonical-path>",
    "  --ready-timeout-ms <milliseconds>",
    "  --stop-timeout-ms <milliseconds>",
    "  --prepare-only",
  ].join("\n");
}

function samePath(left, right) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === "win32"
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    configPath: canonicalConfigPath(),
    readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
    prepareOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--config" && value) {
      options.configPath = value;
      index += 1;
    } else if (option === "--ready-timeout-ms" && value) {
      options.readyTimeoutMs = positiveInteger(value, option);
      index += 1;
    } else if (option === "--stop-timeout-ms" && value) {
      options.stopTimeoutMs = positiveInteger(value, option);
      index += 1;
    } else if (option === "--prepare-only") {
      options.prepareOnly = true;
    } else {
      throw new Error(usage());
    }
  }
  return options;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runChecked(command, args, { cwd }) {
  const child = spawn(command, args, {
    cwd,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    const suffix = result.signal ? ` (signal=${result.signal})` : "";
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.code}${suffix}`);
  }
}

export async function runDeploymentPreflight(sourceRoot = SOURCE_ROOT) {
  await runChecked(process.execPath, ["--test"], { cwd: sourceRoot });
  for (const relative of [
    "src/main.js",
    "scripts/runtime-bootstrap.mjs",
    "scripts/deploy-runtime.mjs",
  ]) {
    await runChecked(process.execPath, ["--check", relative], { cwd: sourceRoot });
  }
}

function validLockOwner(owner) {
  return Number.isSafeInteger(owner?.pid) && owner.pid > 0
    && typeof owner.startedAt === "string" && Number.isFinite(Date.parse(owner.startedAt));
}

async function readBridgeOwner(dataDirectory, { requireValid = false } = {}) {
  const lockPath = path.join(dataDirectory, "bridge.lock");
  let owner;
  try {
    owner = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (!requireValid) return null;
    throw new Error(`Cannot safely read the bridge instance lock: ${error.message}`);
  }
  if (!validLockOwner(owner)) {
    if (requireValid) throw new Error("Bridge instance lock metadata is invalid");
    return null;
  }
  return owner;
}

async function currentBridgeOwner(dataDirectory) {
  const owner = await readBridgeOwner(dataDirectory, { requireValid: true });
  return owner && processExists(owner.pid) ? owner : null;
}

async function acquireDeploymentLock(dataDirectory) {
  const lockPath = path.join(dataDirectory, "deployment.lock");
  const token = randomBytes(16).toString("hex");
  await mkdir(dataDirectory, { recursive: true });

  async function acquire(allowStaleRecovery) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = null;
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        // A malformed lock is only recoverable when it is not owned by a live process.
      }
      if (Number.isSafeInteger(owner?.pid) && processExists(owner.pid)) {
        throw new Error(`Another deployment is already running (pid=${owner.pid})`);
      }
      if (!owner) {
        const metadata = await stat(lockPath).catch(() => null);
        if (metadata && Date.now() - metadata.mtimeMs < 10_000) {
          throw new Error("Another deployment is acquiring the deployment lock");
        }
      }
      if (!allowStaleRecovery) throw new Error("Deployment lock changed during recovery");
      await rm(lockPath, { force: true });
      return acquire(false);
    }
    try {
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
      })}\n`);
    } finally {
      await handle.close();
    }
    return async () => {
      let owner = null;
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (owner?.pid === process.pid && owner?.token === token) {
        await rm(lockPath, { force: true });
      }
    };
  }

  return acquire(true);
}

function deploymentStatePath(dataDirectory) {
  return path.join(dataDirectory, "deployment-state.json");
}

async function readDeploymentState(dataDirectory) {
  const statePath = deploymentStatePath(dataDirectory);
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state?.version !== 1 || !state.active || typeof state.active !== "object") {
      throw new Error("invalid structure");
    }
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read deployment state ${statePath}: ${error.message}`);
  }
}

async function writeDeploymentState(dataDirectory, active, extra = {}) {
  const statePath = deploymentStatePath(dataDirectory);
  const temporaryPath = `${statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const state = {
    version: 1,
    updatedAt: new Date().toISOString(),
    active,
    ...extra,
  };
  await mkdir(path.dirname(statePath), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, statePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
  return state;
}

function assertTargetShape(target) {
  if (!target || typeof target !== "object"
    || typeof target.runtimeDirectory !== "string"
    || typeof target.bootstrapPath !== "string"
    || !SHA256_PATTERN.test(target.manifestSha256 ?? "")
    || !SHA256_PATTERN.test(target.bootstrapSha256 ?? "")) {
    throw new Error("Deployment target metadata is invalid");
  }
}

async function verifyBootstrap(dataDirectory, bootstrapPath, expectedSha256) {
  const bootstrapRoot = path.join(dataDirectory, "bootstrap");
  if (!within(bootstrapRoot, bootstrapPath)) {
    throw new Error("Deployment bootstrap escaped the managed bootstrap directory");
  }
  const metadata = await lstat(bootstrapPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Deployment bootstrap must be a regular file");
  }
  const actualSha256 = await sha256File(bootstrapPath);
  if (actualSha256 !== expectedSha256) {
    throw new Error("Deployment bootstrap hash mismatch");
  }
}

async function verifyDeploymentTarget(target, dataDirectory) {
  assertTargetShape(target);
  const runtimeRoot = path.join(dataDirectory, "runtime");
  if (!within(runtimeRoot, target.runtimeDirectory)) {
    throw new Error("Deployment runtime escaped the managed runtime directory");
  }
  const verified = await verifyRuntimeSnapshot({
    runtimeDirectory: target.runtimeDirectory,
  });
  if (verified.manifestSha256 !== target.manifestSha256) {
    throw new Error("Deployment runtime manifest hash does not match saved state");
  }
  await verifyBootstrap(dataDirectory, target.bootstrapPath, target.bootstrapSha256);
  return {
    ...target,
    runtimeDirectory: verified.runtimeDirectory,
    fileCount: verified.fileCount,
    createdAt: verified.createdAt,
    configSource: verified.configSource,
    configSourceSha256: verified.configSourceSha256,
  };
}

async function inferPreviousTarget({
  dataDirectory,
  bootstrapPath,
  bootstrapSha256,
  runningOwner,
  excludeRuntimeDirectory,
}) {
  const runtimeRoot = path.join(dataDirectory, "runtime");
  let entries;
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".partial-")) continue;
    const runtimeDirectory = path.join(runtimeRoot, entry.name);
    if (samePath(runtimeDirectory, excludeRuntimeDirectory)) continue;
    try {
      const verified = await verifyRuntimeSnapshot({ runtimeDirectory });
      const createdAtMs = Date.parse(verified.createdAt ?? "");
      if (!Number.isFinite(createdAtMs)) continue;
      if (runningOwner && createdAtMs > Date.parse(runningOwner.startedAt)) continue;
      candidates.push({
        runtimeDirectory,
        manifestSha256: verified.manifestSha256,
        bootstrapPath,
        bootstrapSha256,
        fileCount: verified.fileCount,
        createdAt: verified.createdAt,
        configSource: verified.configSource,
        configSourceSha256: verified.configSourceSha256,
        inferred: true,
      });
    } catch {
      // A corrupt or incomplete snapshot is never a rollback candidate.
    }
  }
  candidates.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return candidates[0] ?? null;
}

async function resolvePreviousTarget({ dataDirectory, newTarget, runningOwner }) {
  const state = await readDeploymentState(dataDirectory);
  if (state) {
    const target = await verifyDeploymentTarget(state.active, dataDirectory);
    if (runningOwner && Number.isSafeInteger(state.active.pid)
      && state.active.pid !== runningOwner.pid) {
      throw new Error(
        "Live bridge PID differs from deployment state; refusing an unsafe replacement",
      );
    }
    return target;
  }
  return inferPreviousTarget({
    dataDirectory,
    bootstrapPath: newTarget.bootstrapPath,
    bootstrapSha256: newTarget.bootstrapSha256,
    runningOwner,
    excludeRuntimeDirectory: newTarget.runtimeDirectory,
  });
}

export function runtimeReadyMarkers(fileCount) {
  return [
    `Runtime snapshot verified (${fileCount} files).`,
    "Codex app-server session backend is ready.",
    "Feishu event stream is ready.",
    "Feishu approval card stream is ready.",
  ];
}

export function hasExactReadyMarkers(output, markers) {
  const lines = new Set(String(output).split(/\r?\n/));
  return markers.every((marker) => lines.has(marker));
}

function runtimeLogPaths(dataDirectory, runtimeDirectory) {
  const runtimeId = path.basename(runtimeDirectory).replace(/[^a-zA-Z0-9_-]/g, "_");
  const attemptId = `${new Date().toISOString().replace(/[-:.]/g, "")}`
    + `-${randomBytes(4).toString("hex")}`;
  const logRoot = path.join(dataDirectory, "logs");
  return {
    logRoot,
    stdoutPath: path.join(logRoot, `bridge-${runtimeId}-${attemptId}.stdout.log`),
    stderrPath: path.join(logRoot, `bridge-${runtimeId}-${attemptId}.stderr.log`),
  };
}

async function startRuntimeProcess(target, dataDirectory) {
  const logs = runtimeLogPaths(dataDirectory, target.runtimeDirectory);
  await mkdir(logs.logRoot, { recursive: true });
  let stdoutFd = null;
  let stderrFd = null;
  let child;
  try {
    stdoutFd = openSync(logs.stdoutPath, "ax", 0o600);
    stderrFd = openSync(logs.stderrPath, "ax", 0o600);
    child = spawn(process.execPath, [
      target.bootstrapPath,
      "--runtime",
      target.runtimeDirectory,
      "--manifest-sha256",
      target.manifestSha256,
      "--",
      "start",
      "--config",
      path.join(target.runtimeDirectory, "bridge.config.json"),
    ], {
      cwd: target.runtimeDirectory,
      detached: true,
      shell: false,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    if (stdoutFd != null) closeSync(stdoutFd);
    if (stderrFd != null) closeSync(stderrFd);
  }
  return {
    pid: child.pid,
    stdoutPath: logs.stdoutPath,
    stderrPath: logs.stderrPath,
  };
}

async function waitForRuntimeReady(target, started, timeoutMs) {
  const markers = runtimeReadyMarkers(target.fileCount);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let output = "";
    try {
      output = await readFile(started.stdoutPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (hasExactReadyMarkers(output, markers)) {
      const owner = await currentBridgeOwner(path.dirname(path.dirname(started.stdoutPath)));
      if (owner?.pid === started.pid) return { markers };
    }
    if (!processExists(started.pid)) {
      throw new Error(`Bridge process ${started.pid} exited before readiness; see ${started.stderrPath}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Bridge readiness timed out after ${timeoutMs}ms; see ${started.stderrPath}`);
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return !processExists(pid);
}

async function stopRunningBridge(dataDirectory, timeoutMs, expectedPid = null) {
  const owner = await currentBridgeOwner(dataDirectory);
  if (!owner) return { stopped: false, pid: null };
  if (expectedPid != null && owner.pid !== expectedPid) {
    throw new Error(
      `Live bridge changed during deployment (expected pid=${expectedPid}, found pid=${owner.pid})`,
    );
  }
  await requestBridgeShutdown(dataDirectory);
  if (!await waitForProcessExit(owner.pid, timeoutMs)) {
    throw new Error(`Bridge pid ${owner.pid} did not stop within ${timeoutMs}ms`);
  }
  return { stopped: true, pid: owner.pid };
}

async function cleanupStartedRuntime(started, dataDirectory, timeoutMs) {
  if (!started?.pid || !processExists(started.pid)) return;
  const owner = await currentBridgeOwner(dataDirectory);
  if (owner?.pid === started.pid) {
    try {
      await stopRunningBridge(dataDirectory, timeoutMs);
      return;
    } catch {
      // Only the process created by this deployment may be force-terminated below.
    }
  }
  try {
    process.kill(started.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  if (!await waitForProcessExit(started.pid, timeoutMs)) {
    throw new Error(`Failed to clean up deployment process ${started.pid}`);
  }
}

function activeState(target, started) {
  return {
    runtimeDirectory: target.runtimeDirectory,
    manifestSha256: target.manifestSha256,
    bootstrapPath: target.bootstrapPath,
    bootstrapSha256: target.bootstrapSha256,
    configSource: target.configSource ?? null,
    configSourceSha256: target.configSourceSha256 ?? null,
    fileCount: target.fileCount,
    pid: started.pid,
    startedAt: new Date().toISOString(),
    stdoutPath: started.stdoutPath,
    stderrPath: started.stderrPath,
  };
}

export async function replaceRuntime({
  dataDirectory,
  target,
  previousTarget,
  runningOwner,
  readyTimeoutMs,
  stopTimeoutMs,
}, operations = {}) {
  const start = operations.start ?? startRuntimeProcess;
  const waitReady = operations.waitReady ?? waitForRuntimeReady;
  const stop = operations.stop ?? stopRunningBridge;
  const cleanup = operations.cleanup ?? cleanupStartedRuntime;
  const saveState = operations.saveState ?? writeDeploymentState;

  if (runningOwner && !previousTarget) {
    throw new Error("A bridge is running but no verified rollback target is available");
  }
  if (runningOwner) await stop(dataDirectory, stopTimeoutMs, runningOwner.pid);

  let started = null;
  try {
    started = await start(target, dataDirectory);
    await waitReady(target, started, readyTimeoutMs);
    const active = activeState(target, started);
    await saveState(dataDirectory, active);
    return { active, rolledBack: false };
  } catch (startupError) {
    if (started) await cleanup(started, dataDirectory, stopTimeoutMs);
    if (!runningOwner || !previousTarget) throw startupError;

    let rollbackStarted = null;
    try {
      rollbackStarted = await start(previousTarget, dataDirectory);
      await waitReady(previousTarget, rollbackStarted, readyTimeoutMs);
      const active = activeState(previousTarget, rollbackStarted);
      await saveState(dataDirectory, active, {
        rollback: {
          failedRuntimeDirectory: target.runtimeDirectory,
          restoredAt: new Date().toISOString(),
        },
      });
      const error = new Error(
        `Deployment failed readiness and restored ${previousTarget.runtimeDirectory}`,
        { cause: startupError },
      );
      error.code = "DEPLOYMENT_ROLLED_BACK";
      error.rollback = active;
      throw error;
    } catch (rollbackError) {
      if (rollbackError.code === "DEPLOYMENT_ROLLED_BACK") throw rollbackError;
      if (rollbackStarted) {
        await cleanup(rollbackStarted, dataDirectory, stopTimeoutMs).catch(() => {});
      }
      throw new AggregateError(
        [startupError, rollbackError],
        "Deployment failed and the previous runtime could not be restored",
      );
    }
  }
}

export async function deployRuntime({
  configPath = canonicalConfigPath(),
  sourceRoot = SOURCE_ROOT,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  prepareOnly = false,
  runPreflight = runDeploymentPreflight,
} = {}) {
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const shadowConfigPath = path.join(absoluteSourceRoot, "bridge.config.json");
  const inspected = await inspectCanonicalConfig({ configPath, shadowConfigPath });
  const releaseDeploymentLock = await acquireDeploymentLock(inspected.config.dataDirectory);
  try {
    const preflightSourceSha256 = await runtimeSourceFingerprint({
      sourceRoot: absoluteSourceRoot,
    });
    await runPreflight(absoluteSourceRoot);
    await assertConfigSourceUnchanged(inspected.configPath, inspected.sourceSha256);
    await inspectCanonicalConfig({ configPath: inspected.configPath, shadowConfigPath });
    if (await runtimeSourceFingerprint({ sourceRoot: absoluteSourceRoot })
      !== preflightSourceSha256) {
      throw new Error("Runtime source changed during tests; retry deployment preflight");
    }

    const snapshot = await createRuntimeSnapshot({
      configPath: inspected.configPath,
      sourceRoot: absoluteSourceRoot,
    });
    if (snapshot.configSourceSha256 !== inspected.sourceSha256) {
      throw new Error("Runtime snapshot did not use the preflighted canonical configuration");
    }
    if (snapshot.sourceSha256 !== preflightSourceSha256) {
      throw new Error("Runtime snapshot does not match the source that passed preflight tests");
    }
    await assertConfigSourceUnchanged(inspected.configPath, inspected.sourceSha256);
    await inspectCanonicalConfig({ configPath: inspected.configPath, shadowConfigPath });
    if (await runtimeSourceFingerprint({ sourceRoot: absoluteSourceRoot })
      !== preflightSourceSha256) {
      throw new Error("Runtime source changed after snapshot creation; retry deployment");
    }
    const verified = await verifyRuntimeSnapshot({ runtimeDirectory: snapshot.runtimeDirectory });
    const target = await verifyDeploymentTarget({
      runtimeDirectory: snapshot.runtimeDirectory,
      manifestSha256: snapshot.manifestSha256,
      bootstrapPath: snapshot.bootstrapPath,
      bootstrapSha256: snapshot.bootstrapSha256,
      fileCount: verified.fileCount,
      configSource: snapshot.configSource,
      configSourceSha256: snapshot.configSourceSha256,
    }, inspected.config.dataDirectory);

    if (prepareOnly) return { prepared: target, active: null, rolledBack: false };

    const runningOwner = await currentBridgeOwner(inspected.config.dataDirectory);
    const previousTarget = await resolvePreviousTarget({
      dataDirectory: inspected.config.dataDirectory,
      newTarget: target,
      runningOwner,
    });
    const result = await replaceRuntime({
      dataDirectory: inspected.config.dataDirectory,
      target,
      previousTarget,
      runningOwner,
      readyTimeoutMs,
      stopTimeoutMs,
    });
    return { prepared: target, ...result };
  } finally {
    await releaseDeploymentLock();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await deployRuntime(options);
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    if (error instanceof AggregateError) {
      for (const cause of error.errors) console.error(`- ${cause.message}`);
    }
    process.exitCode = 1;
  });
}
