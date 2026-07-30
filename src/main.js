#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { Bridge } from "./bridge.js";
import { AppServerRunner } from "./app-server-runner.js";
import { ApprovalBroker } from "./approval-broker.js";
import { loadConfig } from "./config.js";
import { runDoctor, formatDoctor } from "./doctor.js";
import { EventStream } from "./event-stream.js";
import { DesktopSync } from "./desktop-sync.js";
import { LarkClient, machineEnvironment } from "./lark-client.js";
import { requireSupportedLarkCliVersion } from "./lark-version.js";
import { handleHookApproval, isFailedApprovalHook } from "./hook-approval-handler.js";
import {
  HOOK_APPROVAL_TIMEOUT_MS,
  HookApprovalServer,
} from "./hook-approval-server.js";
import { monitorAppServer } from "./app-server-lifecycle.js";
import { startIsolatedAppServer } from "./isolated-app-server.js";
import { InstanceLock, requestBridgeShutdown } from "./instance-lock.js";
import { SessionCatalog } from "./session-catalog.js";
import { SessionState } from "./session-state.js";
import { StateStore } from "./state-store.js";
import { resolveTool } from "./tool-resolver.js";
import { verifyRuntimeSnapshot } from "./runtime-snapshot.js";

function usage() {
  return "Usage: node src/main.js <start|stop|doctor> [--config path]";
}

function parseArgs(argv) {
  const command = argv[0];
  let configPath;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--config" && argv[index + 1]) {
      configPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return { command, configPath };
}

async function dependencies(config) {
  const [larkTool, codexTool] = await Promise.all([
    resolveTool("lark", config.larkCliEntry),
    resolveTool("codex", config.codex.entry),
  ]);
  return { larkTool, codexTool };
}

async function start(config) {
  const { larkTool, codexTool } = await dependencies(config);
  await requireSupportedLarkCliVersion(larkTool, { env: machineEnvironment() });

  let instanceLock = null;
  let appServer = null;
  let streams = [];
  let desktopSync = null;
  let approvalBroker = null;
  let hookApprovalServer = null;
  let codex = null;
  let bridge = null;
  let store = null;
  let appServerLifecycle = null;
  let startupOperation = null;
  let stopping = false;
  let shutdownPromise = null;
  let lockReleased = false;
  let lockReleasePromise = null;
  let signalHandlersInstalled = false;
  let startupSettled = false;
  let settleStartupPromise;
  const startupAbortController = new AbortController();
  const startupFinished = new Promise((resolve) => { settleStartupPromise = resolve; });
  const eventTasks = new Set();
  const markStartupFinished = () => {
    if (startupSettled) return;
    startupSettled = true;
    settleStartupPromise();
  };
  const releaseLock = async () => {
    if (lockReleased || !instanceLock) return;
    lockReleasePromise ??= instanceLock.release()
      .then(() => { lockReleased = true; })
      .catch((error) => {
        lockReleasePromise = null;
        throw error;
      });
    await lockReleasePromise;
  };
  const settleCleanup = async (label, operations) => {
    const results = await Promise.allSettled(operations);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      process.exitCode = Math.max(process.exitCode ?? 0, 1);
      for (const failure of failures) {
        console.error(`${label}: ${failure.reason?.message ?? String(failure.reason)}`);
      }
    }
    return results;
  };
  const assertStartupContinues = () => {
    if (!stopping) return;
    const error = new Error("Bridge startup interrupted by shutdown");
    error.code = "STARTUP_SHUTDOWN";
    throw error;
  };
  const onSigint = () => void shutdown("SIGINT");
  const onSigterm = () => void shutdown("SIGTERM");
  const removeSignalHandlers = () => {
    if (!signalHandlersInstalled) return;
    signalHandlersInstalled = false;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
  function shutdown(signal, exitCode = 0) {
    if (shutdownPromise) {
      process.exitCode = Math.max(process.exitCode ?? 0, exitCode);
      return shutdownPromise;
    }
    stopping = true;
    startupAbortController.abort();
    process.exitCode = Math.max(process.exitCode ?? 0, exitCode);
    console.log(`Shutting down on ${signal}...`);
    bridge?.beginShutdown();
    desktopSync?.stop();
    approvalBroker?.declineAll("shutdown");
    const forcedExit = setTimeout(() => process.exit(process.exitCode ?? 0), 15_000);
    shutdownPromise = (async () => {
      // If a signal arrives during the two-phase app-server startup, let the
      // startup path observe `stopping` and clean up the child it just created.
      await startupFinished;

      // Stop the ingress before taking the active-job snapshot. This prevents
      // a late Feishu event from creating a job that shutdown never sees.
      await settleCleanup(
        "Failed to stop Feishu ingress",
        streams.map((stream) => stream.stop()),
      );
      await settleCleanup("Feishu event handling failed during shutdown", [...eventTasks]);

      const active = codex?.activeJobIds?.() ?? [];
      await settleCleanup(
        "Failed to cancel an active Codex job",
        active.map((jobId) => codex.cancel(jobId)),
      );
      await settleCleanup(
        "Failed to drain bridge lifecycle state",
        [bridge?.waitForIdle(), approvalBroker?.waitForReminders?.(), store?.flush?.()],
      );

      appServerLifecycle?.dispose();
      await settleCleanup("Failed to stop Codex app-server", [appServer?.stop()]);
      await settleCleanup("Failed to stop approval hook server", [hookApprovalServer?.stop()]);
    })().finally(async () => {
      clearTimeout(forcedExit);
      appServerLifecycle?.dispose();
      removeSignalHandlers();
      await releaseLock().catch((error) => {
        process.exitCode = Math.max(process.exitCode ?? 0, 1);
        console.error(`Failed to release bridge instance lock: ${error.message}`);
      });
      process.exit(process.exitCode ?? 0);
    });
    return shutdownPromise;
  }

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  signalHandlersInstalled = true;
  try {
  instanceLock = await new InstanceLock(config.dataDirectory).acquire();
  instanceLock.registerControlHandler(() => {
    void shutdown("local-control");
    return true;
  });
  assertStartupContinues();
  store = new StateStore(
    config.dataDirectory,
    config.limits.processedMessageLimit,
    config.limits.storedJobLimit,
  );
  await store.load();
  assertStartupContinues();
  const lark = new LarkClient(larkTool, config);
  const sessions = new SessionState(store);
  await sessions.recoverAfterRestart();
  assertStartupContinues();
  approvalBroker = new ApprovalBroker({
    lark,
    config,
    timeoutMs: HOOK_APPROVAL_TIMEOUT_MS,
    lookupJob: (threadId, turnId) => codex?.findJob(threadId, turnId) ?? null,
  });
  hookApprovalServer = new HookApprovalServer(
    (request) => handleHookApproval(request, approvalBroker),
  );
  const hookEndpoint = await hookApprovalServer.start();
  assertStartupContinues();
  let catalog = null;
  if (!config.codex.appServer.enabled) {
    throw new Error("Codex app-server must be enabled for secure mobile session handoff");
  }
  try {
      appServer = await startIsolatedAppServer(codexTool, {
        cwd: process.cwd(),
        repositoryPath: config.repositories[config.defaultRepository].path,
        hookEndpoint,
        signal: startupAbortController.signal,
      });
      assertStartupContinues();
      appServerLifecycle = monitorAppServer(appServer, {
        onRuntimeExit: (error) => {
          if (!stopping) {
            console.error(error.message);
            void shutdown("app-server-close", 1);
          }
        },
      });
      appServer.on("diagnostic", (message) => console.error(`[codex-app-server] ${message}`));
      appServer.on("warning", (message) => console.warn(`[codex-app-server] ${message}`));
      appServer.on("app-server-error", (params) => {
        const message = typeof params?.error?.message === "string"
          ? params.error.message
          : "Codex app-server reported an error";
        const retry = params?.willRetry === true ? " (will retry)" : "";
        console.warn(`[codex-app-server] ${message}${retry}`);
      });
      appServer.on("hook/completed", (params) => {
        if (isFailedApprovalHook(params) && !stopping) {
          console.error("PreToolUse approval hook failed; stopping the bridge before further work.");
          void shutdown("approval-hook-failed", 1);
        }
      });
      catalog = new SessionCatalog(appServer, config);
      codex = new AppServerRunner(appServer, config);
      appServer.approvalHandler = (request) => approvalBroker.handle(request);
      console.log("Codex app-server session backend is ready.");
  } catch (error) {
    await appServer?.stop().catch(() => {});
    if (error?.code === "STARTUP_SHUTDOWN") throw error;
    throw new Error(`Codex app-server unavailable; refusing unsafe CLI fallback: ${error.message}`);
  }
  bridge = new Bridge({
    config, store, lark, codex, sessions, catalog, appServer, approvalBroker,
  });
  startupOperation = bridge.recoverInterruptedJobs();
  await appServerLifecycle.waitFor(startupOperation);
  startupOperation = null;
  assertStartupContinues();
  desktopSync = appServer
    ? new DesktopSync({
        client: appServer,
        sessions,
        lark,
        config,
        store,
        intervalMs: config.desktopSync.pollIntervalMs,
      })
    : null;
  desktopSync?.start();
  const messageStream = new EventStream(larkTool, config, "im.message.receive_v1");
  const cardStream = new EventStream(larkTool, config, "card.action.trigger");
  streams = [messageStream, cardStream];
  const handleFeishuEvent = (event) => {
    const task = bridge.handleEvent(event).catch((error) => console.error(error));
    eventTasks.add(task);
    void task.finally(() => eventTasks.delete(task));
  };
  for (const stream of streams) {
    stream.on("event", handleFeishuEvent);
    stream.on("warning", (message) => console.warn(message));
    stream.on("diagnostic", (message) => console.error(`[lark-cli:${stream.eventKey}] ${message}`));
  }
  messageStream.on("ready", () => {
    if (!stopping) console.log("Feishu event stream is ready.");
  });
  messageStream.on("error", (error) => {
    console.error(`Event stream error: ${error.message}`);
    void shutdown("event-stream-error", 1);
  });
  messageStream.on("close", ({ code, signal, expected }) => {
    if (!expected && !stopping) {
      console.error(`Feishu event stream exited unexpectedly (code=${code}, signal=${signal}).`);
      void shutdown("event-stream-close", 1);
    }
  });
  cardStream.on("ready", () => {
    if (stopping) return;
    approvalBroker.setCardActionsAvailable(true);
    console.log("Feishu approval card stream is ready.");
  });
  cardStream.on("error", (error) => {
    approvalBroker.setCardActionsAvailable(false);
    console.warn(`Approval card stream unavailable; using text approvals: ${error.message}`);
  });
  cardStream.on("close", ({ code, signal, expected }) => {
    approvalBroker.setCardActionsAvailable(false);
    if (!expected && !stopping) {
      console.warn(
        `Approval card stream exited unexpectedly (code=${code}, signal=${signal}); using text approvals.`,
      );
    }
  });
  messageStream.start();
  cardStream.start();
  assertStartupContinues();
  appServerLifecycle.activateRuntime();
  markStartupFinished();
  } catch (error) {
    stopping = true;
    appServerLifecycle?.dispose();
    desktopSync?.stop();
    approvalBroker?.declineAll("startup_failed");
    bridge?.beginShutdown();
    await settleCleanup("Startup cleanup failed", [
      startupOperation,
      ...streams.map((stream) => stream.stop()),
    ]);
    await settleCleanup("Startup event drain failed", [...eventTasks]);
    const active = codex?.activeJobIds?.() ?? [];
    await settleCleanup("Startup job cancellation failed", active.map((jobId) => codex.cancel(jobId)));
    await settleCleanup("Startup state drain failed", [bridge?.waitForIdle(), store?.flush?.()]);
    await settleCleanup("Startup child cleanup failed", [appServer?.stop(), hookApprovalServer?.stop()]);
    try {
      await releaseLock();
    } catch (releaseError) {
      if (error instanceof Error && error.cause === undefined) error.cause = releaseError;
      else console.error(`Failed to release bridge instance lock: ${releaseError.message}`);
    } finally {
      removeSignalHandlers();
      markStartupFinished();
    }
    throw error;
  }
}

async function main() {
  const { command, configPath } = parseArgs(process.argv.slice(2));
  if (!command || !["start", "stop", "doctor"].includes(command)) {
    throw new Error(usage());
  }
  const config = await loadConfig(configPath);
  if (command === "stop") {
    const result = await requestBridgeShutdown(config.dataDirectory);
    console.log(`Shutdown requested for bridge pid ${result.pid}.`);
    return;
  }
  if (config.runtimeSnapshot.required) {
    const verified = await verifyRuntimeSnapshot({
      runtimeDirectory: path.dirname(config.configPath),
    });
    console.log(`Runtime snapshot verified (${verified.fileCount} files).`);
  }
  if (command === "doctor") {
    const tools = await dependencies(config);
    const checks = await runDoctor({ config, ...tools });
    console.log(formatDoctor(checks));
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }
  await start(config);
}

main().catch((error) => {
  if (error.code !== "STARTUP_SHUTDOWN") {
    console.error(error.message);
    process.exitCode = 1;
  }
});
