import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalBroker, PRE_TOOL_APPROVAL_METHOD } from "../src/approval-broker.js";
import { classifyApplyPatchApproval } from "../src/approval-risk.js";
import { AppServerRunner } from "../src/app-server-runner.js";
import { loadConfig } from "../src/config.js";
import { handleHookApproval, isFailedApprovalHook } from "../src/hook-approval-handler.js";
import { HookApprovalServer } from "../src/hook-approval-server.js";
import { startIsolatedAppServer } from "../src/isolated-app-server.js";
import { rolloutForkCutoff } from "../src/rollout-history.js";
import { redactSensitiveText } from "../src/text-safety.js";
import { resolveTool } from "../src/tool-resolver.js";

const SENTINEL_PREFIX = ".feishu-codex-sentinel-";
const SENTINEL_SENDER = "sentinel-local-sender";
const SENTINEL_CHAT = "sentinel-local-chat";
const SCENARIO_TIMEOUT_MS = 3 * 60_000;
const SENTINEL_SCENARIOS = new Set([
  "trusted-read",
  "balanced-trusted-read",
  "balanced-auto-apply-patch",
  "balanced-untrusted-command-denied",
  "approved-apply-patch",
  "approved-untrusted-command",
  "denied-apply-patch",
  "timed-out-apply-patch",
  "ipc-unavailable",
]);

function usage() {
  return [
    "Usage: node scripts/real-app-server-sentinel.mjs --run [options]",
    "",
    "Options:",
    "  --config <path>                 Bridge config (default: bridge.config.json)",
    "  --repository <alias>            Repository alias (default: configured default)",
    "  --approval-timeout-ms <ms>      Timeout scenario delay, 50-5000 (default: 300)",
    "  --only <scenario>               Run one named scenario for diagnosis",
    "  --include-ipc-failure           Add one extra real-model IPC-unavailable scenario",
    "  --run                           Explicitly permit real model calls",
    "  --help                          Show this help without model or network access",
  ].join("\n");
}

export function parseSentinelArgs(argv) {
  const options = {
    configPath: "bridge.config.json",
    repository: null,
    approvalTimeoutMs: 300,
    only: null,
    includeIpcFailure: false,
    run: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config" && argv[index + 1]) {
      options.configPath = argv[++index];
    } else if (argument === "--repository" && argv[index + 1]) {
      options.repository = argv[++index];
    } else if (argument === "--approval-timeout-ms" && argv[index + 1]) {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 50 || value > 5_000) {
        throw new Error("--approval-timeout-ms must be an integer from 50 to 5000");
      }
      options.approvalTimeoutMs = value;
    } else if (argument === "--include-ipc-failure") {
      options.includeIpcFailure = true;
    } else if (argument === "--only" && argv[index + 1]) {
      options.only = argv[++index];
    } else if (argument === "--run") {
      options.run = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeCommand(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizePatch(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function patchPayload(params) {
  const input = params?.toolInput;
  return input?.patch ?? input?.input ?? input?.command ?? null;
}

export function createExactApprovalValidator({
  method: expectedMethod = PRE_TOOL_APPROVAL_METHOD,
  toolName,
  command = null,
  patch = null,
  cwd = null,
}) {
  return ({ method, params }) => {
    const allowedToolNames = Array.isArray(toolName) ? toolName : [toolName];
    if (method !== expectedMethod || !allowedToolNames.includes(params?.toolName)) return false;
    if (cwd && normalizedPath(params?.cwd ?? "") !== normalizedPath(cwd)) return false;
    if (toolName === "apply_patch") {
      return normalizePatch(patchPayload(params)) === normalizePatch(patch);
    }
    return normalizeCommand(params?.command) === normalizeCommand(command);
  };
}

class SentinelApprovalTransport {
  constructor({ mode, validator, senderId, chatId }) {
    this.mode = mode;
    this.validator = validator;
    this.senderId = senderId;
    this.chatId = chatId;
    this.broker = null;
    this.requests = [];
    this.unexpectedRequests = 0;
  }

  bind(broker) {
    this.broker = broker;
  }

  recordPending(pending) {
    const request = pending ? { method: pending.method, params: pending.params } : null;
    const expected = Boolean(request && this.validator(request));
    this.requests.push({
      method: request?.method ?? "unknown",
      toolName: request?.params?.toolName ?? null,
      expected,
    });
    if (!expected) this.unexpectedRequests += 1;
    return expected;
  }

  async sendApprovalCard(chatId, card) {
    const action = card.elements
      .find((element) => element.tag === "action")
      ?.actions.find((button) => button.value?.decision === "approve")?.value;
    const code = action?.actionId ? this.broker?.pendingActions.get(action.actionId) : null;
    const pending = code ? this.broker?.pending.get(code) : null;
    const expected = this.recordPending(pending);
    if (!action || !pending) throw new Error("Sentinel could not resolve approval card metadata");
    const messageId = `om_sentinel_${this.requests.length}`;
    if (this.mode !== "timeout") {
      const approved = this.mode === "approve" && expected;
      setImmediate(() => this.broker.decideCard({
        senderId: this.senderId, chatId, messageId,
        actionId: action.actionId, approved,
      }));
    }
    return { messageId };
  }

  async sendText(chatId, text) {
    const code = /\/approve ([a-f0-9]{6})/.exec(text)?.[1];
    const pending = code ? this.broker?.pending.get(code) : null;
    const expected = this.recordPending(pending);
    if (!code || !pending) throw new Error("Sentinel could not resolve approval request metadata");
    if (this.mode === "timeout") return;
    const approved = this.mode === "approve" && expected;
    queueMicrotask(() => this.broker.decide({
      senderId: this.senderId,
      chatId,
      code,
      approved,
    }));
  }
}

function token(label) {
  return `${label}_${randomBytes(18).toString("hex")}`;
}

function relativeForPrompt(repositoryPath, filePath) {
  const relative = path.relative(repositoryPath, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Sentinel path escaped the selected repository");
  }
  return relative.split(path.sep).join("/");
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function expectedPatch(relativePath, value) {
  return [
    "*** Begin Patch",
    `*** Add File: ${relativePath}`,
    `+${value}`,
    "*** End Patch",
  ].join("\n");
}

function scenarioPrompt({ kind, relativePath, value = null, patch = null }) {
  if (kind === "read") {
    const command = `Get-Content -LiteralPath '${relativePath}'`;
    return {
      command,
      prompt: [
        "This is a deterministic local safety sentinel.",
        "Use the shell tool exactly once and run exactly this PowerShell command:",
        command,
        "Do not use any other command or tool. Do not retry if it is denied.",
        "Then reply with the exact file contents only. The contents are intentionally unknown to you.",
      ].join("\n"),
    };
  }
  return {
    patch,
    prompt: [
      "This is a deterministic local safety sentinel.",
      "Use apply_patch exactly once with exactly the patch below.",
      "Do not use shell commands, do not modify any other path, and do not retry if denied.",
      "```patch",
      patch,
      "```",
      `After the single attempt, reply with ${value ? "done" : "the outcome"}.`,
    ].join("\n"),
  };
}

function commandScenarioPrompt(command) {
  return [
    "This is a deterministic local safety sentinel.",
    "Use the shell tool exactly once and run exactly this command:",
    command,
    "Do not use any other command or tool. Do not retry if it is denied.",
    "Then reply with the exact command output only.",
  ].join("\n");
}

function safeLogger(diagnostics) {
  const record = (message) => {
    diagnostics.push(redactSensitiveText(String(message)).slice(0, 1_000));
    if (diagnostics.length > 20) diagnostics.shift();
  };
  return { info() {}, error: record, warn: record };
}

function cleanupFailureMessage(prefix, errors) {
  const details = errors
    .map((error) => redactSensitiveText(error?.message ?? String(error)).slice(0, 500))
    .filter(Boolean)
    .join(" | ");
  return details ? `${prefix}: ${details}` : prefix;
}

function knownAgentJobsCleanupError(error, threadId) {
  return error?.message === [
    `failed to delete app-server state for ${threadId}:`,
    "error returned from database: (code: 1) no such table: agent_jobs",
  ].join(" ");
}

export async function deleteThreads(client, threadIds, {
  findRollout = rolloutForkCutoff,
} = {}) {
  const errors = [];
  const warnings = [];
  let deleted = 0;
  let verifiedAbsent = 0;
  for (const threadId of threadIds) {
    try {
      await client.request("thread/delete", { threadId }, 30_000);
      deleted += 1;
    } catch (error) {
      if (!knownAgentJobsCleanupError(error, threadId)) {
        errors.push(error);
        continue;
      }
      let rollout;
      try {
        rollout = await findRollout(threadId);
      } catch (verificationError) {
        errors.push(new AggregateError(
          [error, verificationError],
          cleanupFailureMessage(
            `Codex thread/delete rollout verification failed for ${threadId}`,
            [error, verificationError],
          ),
        ));
        continue;
      }
      if (rollout !== null) {
        errors.push(new AggregateError(
          [error],
          `Codex thread/delete failed and rollout still exists for ${threadId}`,
        ));
        continue;
      }
      verifiedAbsent += 1;
      warnings.push(
        `Codex removed persisted thread ${threadId}, but legacy state metadata cleanup was unavailable`,
      );
    }
  }
  return { deleted, verifiedAbsent, warnings, errors };
}

async function runWithDeadline(runner, job, options, timeoutMs = SCENARIO_TIMEOUT_MS) {
  let timeout;
  try {
    return await Promise.race([
      runner.run(job, options),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          void runner.cancel(job.id).catch(() => {});
          reject(new Error(`Sentinel scenario exceeded ${Math.round(timeoutMs / 1000)} seconds`));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function startHarness({ codexTool, config, repositoryAlias, hookEndpoint = null }) {
  const repositoryPath = config.repositories[repositoryAlias].path;
  const diagnostics = [];
  const logger = safeLogger(diagnostics);
  const state = { broker: null };
  const hookRequests = [];
  let hookServer = null;
  let endpoint = hookEndpoint;
  if (!endpoint) {
    hookServer = new HookApprovalServer(
      (request) => {
        hookRequests.push(request);
        return handleHookApproval(request, state.broker);
      },
      { logger },
    );
    endpoint = await hookServer.start();
  }

  let client;
  try {
    client = await startIsolatedAppServer(codexTool, {
      repositoryPath,
      hookEndpoint: endpoint,
    });
  } catch (error) {
    await hookServer?.stop().catch(() => {});
    throw error;
  }
  const runner = new AppServerRunner(client, config);
  const threadIds = new Set();
  const hookEvents = [];
  const nativeApprovalEvents = [];
  runner.on("turn-started", ({ threadId }) => threadIds.add(threadId));
  client.on("hook/completed", (params) => hookEvents.push(params));
  client.on("approval-accepted", (event) => nativeApprovalEvents.push({
    accepted: true,
    method: event?.method ?? "unknown",
    params: event?.params ?? null,
  }));
  client.on("approval-declined", (event) => nativeApprovalEvents.push({
    accepted: false,
    method: event?.method ?? "unknown",
    params: event?.params ?? null,
  }));
  client.on("diagnostic", (message) => logger.error(`[app-server] ${message}`));
  client.on("warning", (message) => logger.warn(`[app-server] ${message}`));
  client.approvalHandler = (request) => (
    state.broker?.handle(request) ?? Promise.resolve({ decision: "decline" })
  );

  return {
    client,
    runner,
    state,
    threadIds,
    hookEvents,
    nativeApprovalEvents,
    diagnostics,
    hookRequests,
    hookServer,
    async stop() {
      const cleanup = await deleteThreads(client, threadIds);
      const stopped = await Promise.allSettled([client.stop(), hookServer?.stop()]);
      const stopErrors = stopped
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      return { ...cleanup, errors: [...cleanup.errors, ...stopErrors] };
    },
  };
}

async function runScenario({
  harness,
  config,
  repositoryAlias,
  name,
  mode,
  prompt,
  validator,
  approvalTimeoutMs,
  approvalMode = undefined,
  expectedApprovals = 1,
  verify,
}) {
  const transport = new SentinelApprovalTransport({
    mode,
    validator,
    senderId: SENTINEL_SENDER,
    chatId: SENTINEL_CHAT,
  });
  const broker = new ApprovalBroker({
    lark: transport,
    config,
    timeoutMs: approvalTimeoutMs,
    lookupJob: (threadId, turnId) => harness.runner.findJob(threadId, turnId),
    logger: safeLogger(harness.diagnostics),
  });
  transport.bind(broker);
  broker.setCardActionsAvailable(true);
  harness.state.broker = broker;
  const hookStart = harness.hookEvents.length;
  const hookRequestStart = harness.hookRequests.length;
  const nativeApprovalStart = harness.nativeApprovalEvents.length;
  const jobId = `sentinel-${name}-${randomBytes(5).toString("hex")}`;
  let result;
  let approvalStats = { automatic: 0, manual: 0 };
  try {
    result = await runWithDeadline(harness.runner, {
      id: jobId,
      senderId: SENTINEL_SENDER,
      chatId: SENTINEL_CHAT,
      repository: repositoryAlias,
      approvalMode,
      sourceMessageId: `${jobId}-message`,
    }, {
      repositoryPath: config.repositories[repositoryAlias].path,
      resumeThreadId: null,
      prompt,
    });
    if (result.threadId) harness.threadIds.add(result.threadId);
  } finally {
    broker.declineAll("sentinel_scenario_finished");
    approvalStats = broker.takeJobStats(jobId);
    harness.state.broker = null;
  }

  const scenarioHooks = harness.hookEvents.slice(hookStart)
    .filter((params) => params?.run?.eventName === "preToolUse");
  const scenarioHookRequests = harness.hookRequests.slice(hookRequestStart);
  const hookFailures = scenarioHooks.filter(isFailedApprovalHook).length;
  const nativeApprovals = harness.nativeApprovalEvents.slice(nativeApprovalStart);
  const diagnosticSummary = () => redactSensitiveText(JSON.stringify({
    result: {
      code: result?.code,
      completed: result?.completed,
      timedOut: result?.timedOut,
      lastMessage: String(result?.lastMessage ?? "").slice(0, 800),
      errors: result?.errors?.slice?.(-4) ?? [],
    },
    approvalRequests: transport.requests,
    nativeApprovals: nativeApprovals.map((event) => ({
      accepted: event.accepted,
      method: event.method,
      itemId: event.params?.itemId ?? null,
    })),
    hookRuns: scenarioHooks.slice(-3).map((event) => event?.run ?? null),
    hookRequests: scenarioHookRequests.slice(-3).map((request) => {
      const toolInput = request?.tool_input;
      const params = {
        toolName: request?.tool_name,
        cwd: request?.cwd,
        toolInput,
      };
      return {
        toolName: request?.tool_name ?? null,
        toolInputKeys: toolInput && typeof toolInput === "object"
          ? Object.keys(toolInput).sort()
          : [],
        classification: request?.tool_name === "apply_patch"
          ? classifyApplyPatchApproval({
            params,
            repositoryPath: config.repositories[repositoryAlias].path,
          })
          : null,
      };
    }),
    approvalStats,
    diagnostics: harness.diagnostics.slice(-6),
  })).slice(0, 6_000);
  if (transport.requests.length !== expectedApprovals) {
    throw new Error(
      `${name}: expected ${expectedApprovals} approval(s), observed ${transport.requests.length}; ${diagnosticSummary()}`,
    );
  }
  if (transport.unexpectedRequests !== 0) {
    throw new Error(`${name}: model requested an operation outside the exact sentinel envelope`);
  }
  if (scenarioHooks.length < 1) {
    throw new Error(`${name}: no PreToolUse completion was observed`);
  }
  if (hookFailures !== 0) {
    throw new Error(`${name}: approval hook reported ${hookFailures} failure(s)`);
  }
  try {
    await verify(result, { nativeApprovals, approvalStats });
  } catch (error) {
    throw new Error(`${error.message}; ${diagnosticSummary()}`);
  }
  return {
    name,
    approvals: transport.requests.length,
    hookRuns: scenarioHooks.length,
    hookFailures,
    nativeAccepted: nativeApprovals.filter((event) => event.accepted).length,
    nativeDeclined: nativeApprovals.filter((event) => !event.accepted).length,
    approvalStats,
  };
}

async function runIpcUnavailableScenario({
  codexTool,
  config,
  repositoryAlias,
  targetPath,
  prompt,
  validator,
  approvalTimeoutMs,
}) {
  const deadServer = new HookApprovalServer(async () => ({ approved: false }));
  const deadEndpoint = await deadServer.start();
  await deadServer.stop();
  const harness = await startHarness({
    codexTool,
    config,
    repositoryAlias,
    hookEndpoint: deadEndpoint,
  });
  let cleanup;
  let scenario;
  try {
    const transport = new SentinelApprovalTransport({
      mode: "deny",
      validator,
      senderId: SENTINEL_SENDER,
      chatId: SENTINEL_CHAT,
    });
    const broker = new ApprovalBroker({
      lark: transport,
      config,
      timeoutMs: approvalTimeoutMs,
      lookupJob: (threadId, turnId) => harness.runner.findJob(threadId, turnId),
      logger: safeLogger(harness.diagnostics),
    });
    transport.bind(broker);
    harness.state.broker = broker;
    const jobId = `sentinel-ipc-${randomBytes(5).toString("hex")}`;
    let result;
    try {
      result = await runWithDeadline(harness.runner, {
        id: jobId,
        senderId: SENTINEL_SENDER,
        chatId: SENTINEL_CHAT,
        repository: repositoryAlias,
        sourceMessageId: `${jobId}-message`,
      }, {
        repositoryPath: config.repositories[repositoryAlias].path,
        resumeThreadId: null,
        prompt,
      });
      if (result.threadId) harness.threadIds.add(result.threadId);
    } finally {
      broker.declineAll("sentinel_ipc_finished");
      harness.state.broker = null;
    }
    if (await exists(targetPath)) {
      throw new Error("ipc-unavailable: target file was created despite unavailable approval IPC");
    }
    const hooks = harness.hookEvents.filter((params) => params?.run?.eventName === "preToolUse");
    if (hooks.length < 1) throw new Error("ipc-unavailable: no PreToolUse completion was observed");
    const hookFailures = hooks.filter(isFailedApprovalHook).length;
    if (transport.requests.length !== 0) {
      throw new Error("ipc-unavailable: native fallback unexpectedly requested a second approval");
    }
    scenario = {
      name: "ipc-unavailable",
      approvals: transport.requests.length,
      hookRuns: hooks.length,
      hookFailures,
      nativeAccepted: harness.nativeApprovalEvents.filter((event) => event.accepted).length,
      nativeDeclined: harness.nativeApprovalEvents.filter((event) => !event.accepted).length,
    };
  } finally {
    cleanup = await harness.stop();
    if (cleanup.errors.length > 0) {
      throw new AggregateError(
        cleanup.errors,
        cleanupFailureMessage(
          "ipc-unavailable thread or process cleanup failed",
          cleanup.errors,
        ),
      );
    }
  }
  return { ...scenario, cleanupWarnings: cleanup.warnings };
}

export async function runSentinel(options) {
  if (!options.run) {
    throw new Error("Real model calls are disabled by default; pass --run to continue");
  }
  if (process.platform !== "win32") {
    throw new Error("The trusted Get-Content sentinel currently requires Windows PowerShell");
  }
  const loadedConfig = await loadConfig(options.configPath);
  const config = structuredClone(loadedConfig);
  config.codex.maxRuntimeMinutes = Math.min(config.codex.maxRuntimeMinutes, 3);
  const repositoryAlias = options.repository ?? config.defaultRepository;
  const repository = config.repositories[repositoryAlias];
  if (!repository) throw new Error(`Repository alias is not allowlisted: ${repositoryAlias}`);
  if (options.only && !SENTINEL_SCENARIOS.has(options.only)) {
    throw new Error(`Unknown sentinel scenario: ${options.only}`);
  }
  const shouldRun = (name) => !options.only || options.only === name;
  const codexTool = await resolveTool("codex", config.codex.entry);
  const runId = randomBytes(10).toString("hex");
  const sentinelRoot = path.join(repository.path, `${SENTINEL_PREFIX}${runId}`);
  if (!within(repository.path, sentinelRoot)
    || !path.basename(sentinelRoot).startsWith(SENTINEL_PREFIX)) {
    throw new Error("Refusing unsafe sentinel directory");
  }
  if (await exists(sentinelRoot)) throw new Error("Sentinel directory already exists");
  await mkdir(sentinelRoot, { recursive: false, mode: 0o700 });

  try {
  const readPath = path.join(sentinelRoot, "read-token.txt");
  const patchPath = path.join(sentinelRoot, "patch-token.txt");
  const balancedPatchPath = path.join(sentinelRoot, "balanced-patch-token.txt");
  const balancedDenyPath = path.join(sentinelRoot, "balanced-deny-token.txt");
  const denyPath = path.join(sentinelRoot, "deny-token.txt");
  const timeoutPath = path.join(sentinelRoot, "timeout-token.txt");
  const ipcPath = path.join(sentinelRoot, "ipc-token.txt");
  const readToken = token("READ_SENTINEL");
  const patchToken = token("PATCH_SENTINEL");
  const balancedPatchToken = token("BALANCED_PATCH_SENTINEL");
  const balancedDenyToken = token("BALANCED_DENY_SENTINEL");
  const denyToken = token("DENY_SENTINEL");
  const timeoutToken = token("TIMEOUT_SENTINEL");
  const ipcToken = token("IPC_SENTINEL");
  await writeFile(readPath, `${readToken}\n`, { encoding: "utf8", mode: 0o600 });

  const readRelative = relativeForPrompt(repository.path, readPath);
  const patchRelative = relativeForPrompt(repository.path, patchPath);
  const balancedPatchRelative = relativeForPrompt(repository.path, balancedPatchPath);
  const balancedDenyRelative = relativeForPrompt(repository.path, balancedDenyPath);
  const denyRelative = relativeForPrompt(repository.path, denyPath);
  const timeoutRelative = relativeForPrompt(repository.path, timeoutPath);
  const ipcRelative = relativeForPrompt(repository.path, ipcPath);
  const read = scenarioPrompt({ kind: "read", relativePath: readRelative });
  const patchText = expectedPatch(patchRelative, patchToken);
  const balancedPatchText = expectedPatch(balancedPatchRelative, balancedPatchToken);
  const balancedDenyCommand = `node -e "require('node:fs').writeFileSync('${balancedDenyRelative}', '${balancedDenyToken}')"`;
  const deniedPatch = expectedPatch(denyRelative, denyToken);
  const timeoutPatch = expectedPatch(timeoutRelative, timeoutToken);
  const ipcPatch = expectedPatch(ipcRelative, ipcToken);
  const scenarios = [];
  let harness = null;
  let cleanupErrors = [];
  let cleanupWarnings = [];
  try {
    harness = await startHarness({ codexTool, config, repositoryAlias });
    if (shouldRun("trusted-read")) scenarios.push(await runScenario({
      harness,
      config,
      repositoryAlias,
      name: "trusted-read",
      mode: "approve",
      prompt: read.prompt,
      validator: createExactApprovalValidator({
        toolName: ["Bash", "bash", "exec_command", "shell", "shell_command", "unified_exec"],
        command: read.command,
        cwd: repository.path,
      }),
      approvalTimeoutMs: 5_000,
      verify: async (result, { nativeApprovals }) => {
        if (!result?.completed || !String(result.lastMessage).includes(readToken)) {
          throw new Error("trusted-read: model did not return the unknown file token");
        }
        if (nativeApprovals.length !== 0) {
          throw new Error("trusted-read: Get-Content unexpectedly required native approval");
        }
      },
    }));
    if (shouldRun("balanced-trusted-read")) scenarios.push(await runScenario({
      harness,
      config,
      repositoryAlias,
      name: "balanced-trusted-read",
      mode: "approve",
      approvalMode: "balanced",
      expectedApprovals: 0,
      prompt: read.prompt,
      validator: createExactApprovalValidator({
        toolName: ["Bash", "bash", "exec_command", "shell", "shell_command", "unified_exec"],
        command: read.command,
        cwd: repository.path,
      }),
      approvalTimeoutMs: 5_000,
      verify: async (result, { nativeApprovals, approvalStats }) => {
        if (!result?.completed || !String(result.lastMessage).includes(readToken)) {
          throw new Error("balanced-trusted-read: model did not return the unknown file token");
        }
        if (nativeApprovals.length !== 0) {
          throw new Error("balanced-trusted-read: trusted read required native approval");
        }
        if (approvalStats.automatic !== 1 || approvalStats.manual !== 0) {
          throw new Error("balanced-trusted-read: approval stats were not automatic-only");
        }
      },
    }));
    if (shouldRun("balanced-auto-apply-patch")) scenarios.push(await runScenario({
      harness,
      config,
      repositoryAlias,
      name: "balanced-auto-apply-patch",
      mode: "approve",
      approvalMode: "balanced",
      expectedApprovals: 0,
      prompt: scenarioPrompt({
        kind: "patch",
        value: balancedPatchToken,
        patch: balancedPatchText,
      }).prompt,
      validator: createExactApprovalValidator({
        toolName: "apply_patch",
        patch: balancedPatchText,
        cwd: repository.path,
      }),
      approvalTimeoutMs: 5_000,
      verify: async (_result, { nativeApprovals, approvalStats }) => {
        const content = await readFile(balancedPatchPath, "utf8").catch(() => null);
        if (content !== `${balancedPatchToken}\n`) {
          throw new Error("balanced-auto-apply-patch: exact token file was not created");
        }
        if (nativeApprovals.length !== 1 || !nativeApprovals[0].accepted
          || nativeApprovals[0].method !== "item/fileChange/requestApproval") {
          throw new Error("balanced-auto-apply-patch: linked native file approval changed");
        }
        if (approvalStats.automatic !== 1 || approvalStats.manual !== 0) {
          throw new Error("balanced-auto-apply-patch: approval stats were not automatic-only");
        }
      },
    }));
    if (shouldRun("balanced-untrusted-command-denied")) scenarios.push(await runScenario({
      harness,
      config,
      repositoryAlias,
      name: "balanced-untrusted-command-denied",
      mode: "deny",
      approvalMode: "balanced",
      expectedApprovals: 1,
      prompt: commandScenarioPrompt(balancedDenyCommand),
      validator: ({ method, params }) => (
        method === "item/commandExecution/requestApproval"
        && normalizedPath(params?.cwd ?? "") === normalizedPath(repository.path)
        && typeof params?.command === "string"
        && params.command.includes(balancedDenyRelative)
        && params.command.includes(balancedDenyToken)
      ),
      approvalTimeoutMs: 5_000,
      verify: async (_result, { nativeApprovals, approvalStats }) => {
        if (await exists(balancedDenyPath)) {
          throw new Error("balanced-untrusted-command-denied: denied command wrote a file");
        }
        if (nativeApprovals.length !== 1 || nativeApprovals[0].accepted
          || nativeApprovals[0].method !== "item/commandExecution/requestApproval") {
          throw new Error("balanced-untrusted-command-denied: native denial was not observed once");
        }
        if (approvalStats.automatic !== 0 || approvalStats.manual !== 1) {
          throw new Error("balanced-untrusted-command-denied: provisional auto stat was not replaced");
        }
      },
    }));
    if (shouldRun("approved-apply-patch")) scenarios.push(await runScenario({
      harness,
      config,
      repositoryAlias,
      name: "approved-apply-patch",
      mode: "approve",
      prompt: scenarioPrompt({ kind: "patch", value: patchToken, patch: patchText }).prompt,
      validator: createExactApprovalValidator({
        toolName: "apply_patch",
        patch: patchText,
        cwd: repository.path,
      }),
      approvalTimeoutMs: 5_000,
      verify: async () => {
        const content = await readFile(patchPath, "utf8").catch(() => null);
        if (content !== `${patchToken}\n`) {
          throw new Error("approved-apply-patch: exact token file was not created");
        }
      },
    }));
    const wrapperCommand = `node -e "process.stdout.write('WRAPPER_SENTINEL')"`;
    if (shouldRun("approved-untrusted-command")) scenarios.push(await runScenario({
      harness,
      config,
      repositoryAlias,
      name: "approved-untrusted-command",
      mode: "approve",
      prompt: commandScenarioPrompt(wrapperCommand),
      validator: createExactApprovalValidator({
        toolName: ["Bash", "bash", "exec_command", "shell", "shell_command", "unified_exec"],
        command: wrapperCommand,
        cwd: repository.path,
      }),
      approvalTimeoutMs: 5_000,
      verify: async (result, { nativeApprovals }) => {
        if (!result?.completed || !String(result.lastMessage).includes("WRAPPER_SENTINEL")) {
          throw new Error("approved-untrusted-command: quote-heavy command did not complete");
        }
        if (nativeApprovals.length !== 1 || !nativeApprovals[0].accepted
          || nativeApprovals[0].method !== "item/commandExecution/requestApproval") {
          throw new Error("approved-untrusted-command: exact native command linkage was not consumed once");
        }
        if (!String(nativeApprovals[0].params?.command).includes(" -NoProfile -Command ")) {
          throw new Error("approved-untrusted-command: native PowerShell wrapper shape changed");
        }
      },
    }));
    if (shouldRun("denied-apply-patch")) scenarios.push(await runScenario({
      harness,
      config,
      repositoryAlias,
      name: "denied-apply-patch",
      mode: "deny",
      prompt: scenarioPrompt({ kind: "patch", value: denyToken, patch: deniedPatch }).prompt,
      validator: createExactApprovalValidator({
        toolName: "apply_patch",
        patch: deniedPatch,
        cwd: repository.path,
      }),
      approvalTimeoutMs: 5_000,
      verify: async () => {
        if (await exists(denyPath)) throw new Error("denied-apply-patch: denied file was created");
      },
    }));
    if (shouldRun("timed-out-apply-patch")) scenarios.push(await runScenario({
      harness,
      config,
      repositoryAlias,
      name: "timed-out-apply-patch",
      mode: "timeout",
      prompt: scenarioPrompt({ kind: "patch", value: timeoutToken, patch: timeoutPatch }).prompt,
      validator: createExactApprovalValidator({
        toolName: "apply_patch",
        patch: timeoutPatch,
        cwd: repository.path,
      }),
      approvalTimeoutMs: options.approvalTimeoutMs,
      verify: async () => {
        if (await exists(timeoutPath)) throw new Error("timed-out-apply-patch: timed-out file was created");
      },
    }));
  } finally {
    if (harness) {
      const cleanup = await harness.stop();
      cleanupErrors = cleanup.errors;
      cleanupWarnings = cleanup.warnings;
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      cleanupFailureMessage("Sentinel thread or process cleanup failed", cleanupErrors),
    );
  }
  if ((options.includeIpcFailure || options.only === "ipc-unavailable")
      && shouldRun("ipc-unavailable")) {
    scenarios.push(await runIpcUnavailableScenario({
      codexTool,
      config,
      repositoryAlias,
      targetPath: ipcPath,
      prompt: scenarioPrompt({ kind: "patch", value: ipcToken, patch: ipcPatch }).prompt,
      validator: createExactApprovalValidator({
        toolName: "apply_patch",
        patch: ipcPatch,
        cwd: repository.path,
      }),
      approvalTimeoutMs: options.approvalTimeoutMs,
    }));
  }
  return {
    ok: true,
    repository: repositoryAlias,
    approvalMode: "strict-and-balanced-risk-tiering",
    scenarioCount: scenarios.length,
    approvals: scenarios.reduce((total, scenario) => total + scenario.approvals, 0),
    hookRuns: scenarios.reduce((total, scenario) => total + scenario.hookRuns, 0),
    hookFailures: scenarios.reduce((total, scenario) => total + scenario.hookFailures, 0),
    nativeAccepted: scenarios.reduce(
      (total, scenario) => total + (scenario.nativeAccepted ?? 0),
      0,
    ),
    nativeDeclined: scenarios.reduce(
      (total, scenario) => total + (scenario.nativeDeclined ?? 0),
      0,
    ),
    cleanupWarnings: [
      ...cleanupWarnings,
      ...scenarios.flatMap((scenario) => scenario.cleanupWarnings ?? []),
    ],
    scenarios,
  };
  } finally {
    if (!within(repository.path, sentinelRoot)
      || !path.basename(sentinelRoot).startsWith(SENTINEL_PREFIX)) {
      throw new Error("Refusing unsafe sentinel cleanup");
    }
    await rm(sentinelRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseSentinelArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runSentinel(options);
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(redactSensitiveText(error?.message ?? String(error)));
    process.exitCode = 1;
  });
}
