import { createHash, randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  canSendApprovalCardToTarget,
  normalizeContextId,
  sendApprovalCardToTarget,
  sendTextToTarget,
} from "./delivery-target.js";
import {
  APPROVAL_DISPOSITIONS,
  classifyApplyPatchApproval,
} from "./approval-risk.js";
import { redactSensitiveText } from "./text-safety.js";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "bridge/preToolUse/requestApproval",
]);

export const PRE_TOOL_APPROVAL_METHOD = "bridge/preToolUse/requestApproval";

const PRE_TOOL_NAMES = new Set([
  "Bash",
  "bash",
  "apply_patch",
  "exec_command",
  "shell",
  "shell_command",
  "unified_exec",
]);

const LINKED_APPROVAL_TTL_MS = 60_000;
export const APPROVAL_REMINDER_DELAY_MS = 10_000;

function commandHash(command) {
  return typeof command === "string" && command.length > 0
    ? createHash("sha256").update(command, "utf8").digest("hex")
    : null;
}

function shlexUnquoted(character) {
  const code = character.codePointAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || "+-./:@]_".includes(character);
}

// Mirrors shlex 1.3's canonical Quoter, which Codex app-server uses to
// serialize the native argv into params.command.
function shlexQuote(word) {
  if (typeof word !== "string" || word.includes("\0")) return null;
  if (word.length === 0) return "''";
  const output = [];
  let offset = 0;
  while (offset < word.length) {
    let allowed = 1 | 2 | 4; // unquoted | single quoted | double quoted
    let end = offset;
    if (word[end] === "^") {
      allowed = 2;
      end += 1;
    }
    while (end < word.length) {
      const codePoint = word.codePointAt(end);
      const width = codePoint > 0xffff ? 2 : 1;
      const character = word.slice(end, end + width);
      let current = allowed;
      if (codePoint >= 0x80) {
        current &= ~1;
      } else {
        if (!shlexUnquoted(character)) current &= ~1;
        if (["'", "^", "\\"].includes(character)) current &= ~2;
        if (["`", "$", "!", "^"].includes(character)) current &= ~4;
      }
      if (current === 0) break;
      allowed = current;
      end += width;
    }
    const chunk = word.slice(offset, end);
    if ((allowed & 1) !== 0) {
      output.push(chunk);
    } else if ((allowed & 2) !== 0) {
      output.push(`'${chunk}'`);
    } else if ((allowed & 4) !== 0) {
      output.push(`"${chunk.replace(/[$`"\\]/g, "\\$&")}"`);
    } else {
      return null;
    }
    offset = end;
  }
  return output.join("");
}

function shlexJoin(words) {
  const quoted = words.map(shlexQuote);
  return quoted.some((word) => word == null) ? null : quoted.join(" ");
}

function shlexWords(command) {
  if (typeof command !== "string") return null;
  const input = command;
  if (!input) return null;
  const words = [];
  let word = "";
  let started = false;
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote === "single") {
      if (character === "'") quote = null;
      else word += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === "\\") {
        const next = input[index + 1];
        if (next == null) return null;
        if ('"\\$`\n'.includes(next)) {
          if (next !== "\n") word += next;
          index += 1;
          continue;
        }
      }
      word += character;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    started = true;
    if (character === "'") {
      quote = "single";
    } else if (character === '"') {
      quote = "double";
    } else if (character === "\\") {
      if (index + 1 >= input.length) return null;
      word += input[index + 1];
      index += 1;
    } else {
      word += character;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words.length > 0 && shlexJoin(words) === command ? words : null;
}

function windowsPathKey(value) {
  return value.replace(/^\\\\\?\\/, "").replaceAll("/", "\\").toLowerCase();
}

function trustedPowerShellExecutable(command) {
  if (typeof command !== "string" || !/^[a-z]:[\\/]/i.test(command)) return false;
  const key = windowsPathKey(command);
  const systemRoots = [...new Set([
    process.env.SystemRoot,
    process.env.WINDIR,
    ...(process.env.SystemRoot || process.env.WINDIR ? [] : ["C:\\Windows"]),
  ].filter(Boolean).map(windowsPathKey))];
  if (systemRoots.some((root) => (
    key === `${root}\\system32\\windowspowershell\\v1.0\\powershell.exe`
  ))) return true;

  const programFilesRoots = [...new Set([
    process.env.ProgramFiles,
    ...(process.env.ProgramFiles ? [] : ["C:\\Program Files"]),
  ].filter(Boolean).map(windowsPathKey))];
  return programFilesRoots.some((root) => {
    const prefix = `${root}\\powershell\\`;
    const relative = key.startsWith(prefix) ? key.slice(prefix.length) : "";
    return /^[^\\]+\\pwsh\.exe$/.test(relative);
  });
}

function strictWrapperPayload(command) {
  const words = shlexWords(command);
  if (!words) return null;
  const args = words.slice(1);
  const equals = (left, right) => left?.toLowerCase() === right.toLowerCase();
  return trustedPowerShellExecutable(words[0])
    && args.length === 3
    && equals(args[0], "-NoProfile")
    && equals(args[1], "-Command")
    ? args[2]
    : null;
}

function nativeCommandHashes(params) {
  const commands = typeof params.command === "string" ? [params.command] : [];
  const hashes = new Set();
  for (const command of commands) {
    const direct = commandHash(command);
    if (direct) hashes.add(direct);
    // Codex may wrap the Hook command in a shell invocation for the native
    // approval callback. Only accept a wrapper whose entire payload is the
    // originally approved command; prefixes/suffixes therefore fail closed.
    const inner = commandHash(strictWrapperPayload(command));
    if (inner) hashes.add(inner);
  }
  return hashes;
}

function within(root, candidate) {
  if (typeof root !== "string" || root.trim().length === 0
    || typeof candidate !== "string" || candidate.trim().length === 0) return false;
  try {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === ""
      || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function realDirectoryWithin(root, candidate) {
  if (!within(root, candidate)) return false;
  try {
    if (!statSync(root).isDirectory() || !statSync(candidate).isDirectory()) return false;
    return within(realpathSync.native(root), realpathSync.native(candidate));
  } catch {
    return false;
  }
}

function exclusiveOwnProperty(object, names) {
  const keys = names.filter((key) => Object.prototype.hasOwnProperty.call(object, key));
  return {
    valid: keys.length <= 1,
    present: keys.length === 1,
    value: keys.length === 1 ? object[keys[0]] : undefined,
  };
}

function applyPatchTargets(patch) {
  if (typeof patch !== "string") return [];
  const targets = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
      ?? /^\*\*\* Move to: (.+)$/.exec(line);
    if (!match) continue;
    const target = match[1].trim();
    if (target) targets.push(target);
  }
  return [...new Set(targets)];
}

function requestSummary(method, params) {
  if (method === PRE_TOOL_APPROVAL_METHOD) {
    if (params.toolName === "apply_patch") {
      const patch = params.toolInput?.patch ?? params.toolInput?.input ?? params.toolInput?.command;
      const targets = applyPatchTargets(patch);
      return targets.length > 0
        ? `文件修改：${targets.slice(0, 12).join(", ")}${targets.length > 12 ? " …" : ""}`
        : "文件修改：apply_patch";
    }
    const command = String(params.command ?? "命令执行").replace(/\s+/g, " ").slice(0, 800);
    return `命令：${command}`;
  }
  if (method === "item/fileChange/requestApproval") {
    return params.reason ? `文件修改：${params.reason}` : "工作区内文件修改";
  }
  const command = String(params.command ?? "命令执行").replace(/\s+/g, " ").slice(0, 800);
  return `命令：${command}`;
}

function approvalReminderText(pending, confirmation) {
  return redactSensitiveText([
    `[Codex 待审批 · #${pending.job.id}]`,
    pending.summary,
    "请打开本话题中的任务卡处理。",
    `也可发送 /approve ${confirmation} 或 /deny ${confirmation}。`,
  ].join("\n"));
}

export function approvalCard({ job, summary, confirmation, actionId, timeoutMinutes }) {
  const actionValue = (decision) => ({
    v: 1,
    kind: "codex_approval",
    decision,
    actionId,
  });
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "Codex 操作审批" },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "plain_text", content: summary },
      },
      {
        tag: "div",
        fields: [
          {
            is_short: true,
            text: { tag: "plain_text", content: `任务：#${job.id}` },
          },
          {
            is_short: true,
            text: { tag: "plain_text", content: `仓库：${job.repository}` },
          },
        ],
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "批准本次" },
            value: actionValue("approve"),
          },
          {
            tag: "button",
            type: "danger",
            text: { tag: "plain_text", content: "拒绝" },
            value: actionValue("deny"),
          },
        ],
      },
      {
        tag: "note",
        elements: [{
          tag: "plain_text",
          content: `仅本次有效，约 ${timeoutMinutes} 分钟后失效。按钮不可用时发送 /approve ${confirmation} 或 /deny ${confirmation}`,
        }],
      },
    ],
  };
}

export function settledApprovalCard(card, approved) {
  const settled = JSON.parse(JSON.stringify(card));
  settled.header = {
    ...(settled.header ?? {}),
    template: approved ? "green" : "red",
    title: {
      tag: "plain_text",
      content: approved ? "Codex 操作已批准" : "Codex 操作已拒绝",
    },
  };
  settled.elements = (settled.elements ?? []).map((element) => {
    if (element?.tag === "action") {
      return {
        tag: "div",
        text: {
          tag: "plain_text",
          content: approved ? "已批准，本次操作正在继续执行。" : "已拒绝，本次操作不会执行。",
        },
      };
    }
    if (element?.tag === "note") {
      return {
        tag: "note",
        elements: [{
          tag: "plain_text",
          content: "本次审批已处理，原按钮和文字确认码均已失效。",
        }],
      };
    }
    return element;
  });
  return settled;
}

export class ApprovalBroker {
  constructor({
    lark,
    config,
    lookupJob,
    timeoutMs = 5 * 60_000,
    logger = console,
    approvalPresenter = null,
    reminderDelayMs = APPROVAL_REMINDER_DELAY_MS,
  }) {
    if (!Number.isSafeInteger(reminderDelayMs) || reminderDelayMs < 0) {
      throw new RangeError("Approval reminder delay must be a non-negative integer");
    }
    this.lark = lark;
    this.config = config;
    this.lookupJob = lookupJob;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.pending = new Map();
    this.pendingActions = new Map();
    this.linkedApprovals = new Map();
    this.jobStats = new Map();
    this.cardActionsAvailable = false;
    this.approvalPresenter = approvalPresenter;
    this.reminderDelayMs = reminderDelayMs;
    this.reminderTasks = new Set();
  }

  setCardActionsAvailable(available) {
    this.cardActionsAvailable = available === true;
  }

  setApprovalPresenter(presenter) {
    this.approvalPresenter = presenter;
  }

  async handle({ method, params }) {
    if (!APPROVAL_METHODS.has(method)) return null;
    params ??= {};
    if (!this.hasExactTurn(params)) return { decision: "decline" };
    const job = this.lookupJob(params.threadId, params.turnId);
    if (!job || !this.isSafeEnvelope(method, params, job)) return { decision: "decline" };
    const approvalMode = this.approvalMode(job);
    if (method === PRE_TOOL_APPROVAL_METHOD && params.toolName === "apply_patch") {
      const repositoryPath = this.config.repositories[job.repository]?.path;
      const classification = classifyApplyPatchApproval({ params, repositoryPath });
      if (classification.disposition === APPROVAL_DISPOSITIONS.DENY) {
        return { decision: "decline" };
      }
      if (!this.isSafeRequest(method, params, job)) return { decision: "decline" };
      const automaticallyApproved = approvalMode === "auto"
        || (approvalMode === "balanced"
          && classification.disposition === APPROVAL_DISPOSITIONS.AUTO_APPROVE);
      if (automaticallyApproved) {
        this.rememberLinkedApproval({ params, job });
        this.recordJobApproval(job, params, "automatic");
        return { decision: "accept" };
      }
    } else {
      if (!this.isSafeRequest(method, params, job)) return { decision: "decline" };
      if (method === PRE_TOOL_APPROVAL_METHOD && approvalMode !== "strict") {
        this.recordJobApproval(job, params, "automatic");
        return { decision: "accept" };
      }
    }
    const linkedApproval = this.consumeLinkedApproval(method, params, job);
    if (linkedApproval === "accept") return { decision: "accept" };
    if (linkedApproval === "mismatch") return { decision: "decline" };
    if (method === "item/fileChange/requestApproval") return { decision: "decline" };
    this.recordJobApproval(job, params, "manual");
    const confirmation = this.uniqueCode();
    const actionId = this.uniqueActionId();
    const timeoutMinutes = Math.max(1, Math.round(this.timeoutMs / 60_000));
    const summary = redactSensitiveText(requestSummary(method, params));
    const text = redactSensitiveText([
      `[Codex 二次确认 · #${job.id}]`,
      summary,
      `仓库：${job.repository}`,
      `批准：/approve ${confirmation}`,
      `拒绝：/deny ${confirmation}`,
      `确认码将在 ${timeoutMinutes} 分钟后失效；仅本次有效。`,
    ].join("\n"));
    const card = approvalCard({ job, summary, confirmation, actionId, timeoutMinutes });
    let resolveDecision;
    const decision = new Promise((resolve) => { resolveDecision = resolve; });
    const expiresAt = Date.now() + this.timeoutMs;
    const timer = setTimeout(() => this.settle(confirmation, false, "timeout"), this.timeoutMs);
    timer.unref?.();
    const pending = {
      method,
      params,
      job,
      resolve: resolveDecision,
      timer,
      expiresAt,
      actionId,
      cardMessageId: null,
      card,
      presentation: null,
      summary,
      reminderTimer: null,
    };
    this.pending.set(confirmation, pending);
    this.pendingActions.set(actionId, confirmation);

    try {
      let delivered = null;
      if (this.cardActionsAvailable && typeof this.approvalPresenter?.addApproval === "function") {
        delivered = await this.approvalPresenter.addApproval({
          job,
          actionId,
          summary,
          confirmation,
          expiresAt,
        });
      }
      if (!delivered && this.cardActionsAvailable && canSendApprovalCardToTarget(this.lark, job)) {
        const standalone = await sendApprovalCardToTarget(
          this.lark,
          job,
          card,
          `approval:${params.itemId}:${confirmation}`,
        );
        if (this.pending.get(confirmation) === pending) delivered = {
          ...standalone,
          presentation: "standalone",
        };
      }
      if (delivered) {
        if (this.pending.get(confirmation) === pending) {
          pending.cardMessageId = delivered?.messageId ?? null;
          pending.presentation = delivered?.presentation ?? "standalone";
          if (!pending.cardMessageId) throw new Error("Approval card message id is missing");
          if (pending.presentation === "control") {
            this.scheduleApprovalReminder(confirmation, pending);
          }
        }
      } else {
        this.pendingActions.delete(actionId);
        pending.actionId = null;
        await sendTextToTarget(
          this.lark,
          job,
          text,
          `approval:${params.itemId}:${confirmation}`,
        );
      }
    } catch (error) {
      this.logger.error?.(`Failed to send approval card: ${error.message}`);
      this.pendingActions.delete(actionId);
      pending.actionId = null;
      pending.cardMessageId = null;
      try {
        await sendTextToTarget(
          this.lark,
          job,
          text,
          `approval-fallback:${params.itemId}:${confirmation}`,
        );
      } catch (fallbackError) {
        this.logger.error?.(`Failed to send approval request: ${fallbackError.message}`);
        this.settle(confirmation, false, "delivery_failed");
      }
    }
    return decision;
  }

  scheduleApprovalReminder(code, pending) {
    if (this.pending.get(code) !== pending || pending.reminderTimer) return false;
    pending.reminderTimer = setTimeout(() => {
      pending.reminderTimer = null;
      if (this.pending.get(code) !== pending) return;
      const task = this.sendApprovalReminder(code, pending);
      this.reminderTasks.add(task);
      void task.catch((error) => {
        this.logger.error?.(`Failed to send approval reminder: ${error.message}`);
      }).finally(() => this.reminderTasks.delete(task));
    }, this.reminderDelayMs);
    pending.reminderTimer.unref?.();
    return true;
  }

  async sendApprovalReminder(code, pending) {
    if (this.pending.get(code) !== pending || pending.presentation !== "control") return false;
    try {
      if (typeof this.lark?.urgentApp !== "function") {
        throw new Error("Feishu app urgent is unavailable");
      }
      await this.lark.urgentApp(pending.cardMessageId, [pending.job.senderId]);
      this.logger.info?.(`Approval ${code} sent an app urgent reminder`);
      return true;
    } catch (error) {
      this.logger.error?.(`Approval ${code} app urgent failed: ${error.message}`);
    }
    if (this.pending.get(code) !== pending) return false;
    await sendTextToTarget(
      this.lark,
      pending.job,
      approvalReminderText(pending, code),
      `approval-reminder:${pending.params.itemId}:${code}`,
    );
    this.logger.info?.(`Approval ${code} sent a text reminder fallback`);
    return true;
  }

  async waitForReminders() {
    while (this.reminderTasks.size > 0) {
      await Promise.allSettled([...this.reminderTasks]);
    }
  }

  isSafeRequest(method, params, job) {
    if (!this.isSafeEnvelope(method, params, job)) return false;
    const repository = this.config.repositories[job.repository]?.path;
    const cwd = params.cwd ?? repository;
    if (method === PRE_TOOL_APPROVAL_METHOD) {
      if (typeof params.itemId !== "string" || params.itemId.trim().length === 0) return false;
      const input = params.toolInput;
      if (!PRE_TOOL_NAMES.has(params.toolName) || !input || typeof input !== "object"
        || Array.isArray(input)) return false;
      const sandboxPermissions = exclusiveOwnProperty(
        input,
        ["sandbox_permissions", "sandboxPermissions"],
      );
      if (!sandboxPermissions.valid
        || (sandboxPermissions.present && sandboxPermissions.value !== undefined
          && sandboxPermissions.value !== "use_default")) return false;
      const additionalPermissions = exclusiveOwnProperty(
        input,
        ["additional_permissions", "additionalPermissions"],
      );
      if (!additionalPermissions.valid
        || (additionalPermissions.present && additionalPermissions.value != null)) return false;
      const networkAccess = exclusiveOwnProperty(input, ["network_access", "networkAccess"]);
      if (!networkAccess.valid
        || (networkAccess.present && networkAccess.value !== undefined
          && networkAccess.value !== null && networkAccess.value !== false)) return false;
      const payload = params.toolName === "apply_patch"
        ? input.command ?? input.patch ?? input.input
        : params.command;
      if (typeof payload !== "string" || payload.trim().length === 0) return false;
      if (params.toolName === "apply_patch") {
        return true;
      }
      const command = exclusiveOwnProperty(input, ["command", "cmd"]);
      if (!command.valid || !command.present
        || typeof command.value !== "string" || command.value.trim().length === 0
        || typeof params.command !== "string" || params.command !== command.value) return false;
      const workingDirectory = exclusiveOwnProperty(input, ["workdir", "cwd"]);
      if (!workingDirectory.valid) return false;
      if (workingDirectory.present) {
        if (typeof workingDirectory.value !== "string"
          || workingDirectory.value.trim().length === 0) return false;
        const candidate = path.isAbsolute(workingDirectory.value)
          ? path.resolve(workingDirectory.value)
          : path.resolve(cwd, workingDirectory.value);
        if (!realDirectoryWithin(repository, candidate)) return false;
      }
      return true;
    }
    if (method === "item/commandExecution/requestApproval" && Array.isArray(params.commandActions)) {
      return params.commandActions.every((action) => (
        !action?.path || (typeof action.path === "string"
          && within(repository, path.resolve(cwd, action.path)))
      ));
    }
    return true;
  }

  isSafeEnvelope(method, params, job) {
    const additionalPermissions = params.additionalPermissions;
    if (additionalPermissions?.network != null || additionalPermissions?.fileSystem != null
      || params.networkApprovalContext) return false;
    if (method === "item/fileChange/requestApproval" && params.grantRoot) return false;
    if (Array.isArray(params.availableDecisions)
      && !params.availableDecisions.some((decision) => decision === "accept")) return false;
    const repository = this.config.repositories[job.repository]?.path;
    const cwd = params.cwd ?? repository;
    if (!repository || !cwd || !within(repository, cwd)) return false;
    return true;
  }

  hasExactTurn(params) {
    return typeof params.threadId === "string" && params.threadId.trim().length > 0
      && typeof params.turnId === "string" && params.turnId.trim().length > 0;
  }

  approvalMode(job) {
    return job?.approvalMode === "balanced" || job?.approvalMode === "auto"
      ? job.approvalMode
      : "strict";
  }

  recordJobApproval(job, params, kind) {
    if (typeof job?.id !== "string" || job.id.length === 0
      || typeof params?.turnId !== "string" || params.turnId.length === 0
      || typeof params?.itemId !== "string" || params.itemId.length === 0
      || (kind !== "automatic" && kind !== "manual")) return;
    const key = `${params.turnId}\0${params.itemId}`;
    let items = this.jobStats.get(job.id);
    if (!items) {
      items = new Map();
      this.jobStats.set(job.id, items);
    }
    if (items.get(key) === "manual" && kind === "automatic") return;
    items.set(key, kind);
    if (typeof this.approvalPresenter?.setStats === "function") {
      void this.approvalPresenter.setStats(job.id, this.jobStatsSnapshot(job.id));
    }
  }

  jobStatsSnapshot(jobId) {
    const items = this.jobStats.get(jobId);
    const stats = { automatic: 0, manual: 0 };
    for (const kind of items?.values?.() ?? []) stats[kind] += 1;
    return stats;
  }

  takeJobStats(jobId) {
    const stats = this.jobStatsSnapshot(jobId);
    this.jobStats.delete(jobId);
    return stats;
  }

  decide({ senderId, chatId, contextId, code, approved, now = Date.now() }) {
    const pending = this.pending.get(code);
    if (!pending) return { ok: false, reason: "missing" };
    if (pending.expiresAt <= now) {
      this.settle(code, false, "timeout");
      return { ok: false, reason: "missing" };
    }
    if (pending.job.senderId !== senderId || pending.job.chatId !== chatId) {
      return { ok: false, reason: "forbidden" };
    }
    if (contextId !== undefined
      && normalizeContextId(pending.job.contextId) !== normalizeContextId(contextId)) {
      return { ok: false, reason: "forbidden" };
    }
    if (!this.isPendingActive(pending)) {
      this.settle(code, false, "job_inactive");
      return { ok: false, reason: "missing" };
    }
    this.settle(code, approved, approved ? "approved" : "denied");
    return {
      ok: true,
      job: pending.job,
      approved,
      actionId: pending.actionId,
      presentation: pending.presentation,
    };
  }

  decideCard({ senderId, chatId, messageId, actionId, approved, now = Date.now() }) {
    const code = this.pendingActions.get(actionId);
    const pending = code ? this.pending.get(code) : null;
    if (!pending || pending.actionId !== actionId) return { ok: false, reason: "missing" };
    if (pending.expiresAt <= now) {
      this.settle(code, false, "timeout");
      return { ok: false, reason: "missing" };
    }
    if (pending.job.senderId !== senderId || pending.job.chatId !== chatId
      || pending.cardMessageId !== messageId) {
      return { ok: false, reason: "forbidden" };
    }
    if (!this.isPendingActive(pending)) {
      this.settle(code, false, "job_inactive");
      return { ok: false, reason: "missing" };
    }
    const presentation = pending.presentation;
    const card = presentation === "control" ? null : settledApprovalCard(pending.card, approved);
    this.settle(code, approved, approved ? "card_approved" : "card_denied", {
      updatePresentation: presentation !== "control",
    });
    return {
      ok: true,
      job: pending.job,
      approved,
      card,
      actionId,
      presentation,
    };
  }

  isPendingActive(pending) {
    const active = this.lookupJob(pending.params.threadId, pending.params.turnId);
    return Boolean(active && active.id === pending.job.id);
  }

  settle(code, approved, reason, { updatePresentation = true } = {}) {
    const pending = this.pending.get(code);
    if (!pending) return false;
    this.pending.delete(code);
    if (pending.actionId) this.pendingActions.delete(pending.actionId);
    clearTimeout(pending.timer);
    if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
    if (approved && pending.method === PRE_TOOL_APPROVAL_METHOD) {
      this.rememberLinkedApproval(pending);
    }
    if (updatePresentation && pending.presentation === "control"
      && typeof this.approvalPresenter?.settleApproval === "function") {
      void this.approvalPresenter.settleApproval(
        pending.job.id,
        pending.actionId,
        approved,
        reason,
      );
    }
    pending.resolve({ decision: approved ? "accept" : "decline" });
    this.logger.info?.(`Approval ${code} settled: ${reason}`);
    return true;
  }

  declineAll(reason = "shutdown") {
    for (const code of [...this.pending.keys()]) this.settle(code, false, reason);
    for (const grant of this.linkedApprovals.values()) clearTimeout(grant.timer);
    this.linkedApprovals.clear();
  }

  declineForJob(jobId, reason = "job_ended") {
    if (typeof jobId !== "string" || jobId.length === 0) return 0;
    const declined = this.declineMatching((pending) => pending.job.id === jobId, reason);
    this.clearLinkedApprovals((grant) => grant.jobId === jobId);
    return declined;
  }

  declineForTurn(threadId, turnId, reason = "turn_ended") {
    if (typeof threadId !== "string" || threadId.length === 0
      || typeof turnId !== "string" || turnId.length === 0) return 0;
    const declined = this.declineMatching(
      (pending) => pending.params.threadId === threadId && pending.params.turnId === turnId,
      reason,
    );
    this.clearLinkedApprovals(
      (grant) => grant.threadId === threadId && grant.turnId === turnId,
    );
    return declined;
  }

  linkedApprovalKey(threadId, turnId, itemId) {
    return `${threadId}\0${turnId}\0${itemId}`;
  }

  rememberLinkedApproval(pending) {
    const { params, job } = pending;
    if (typeof params.itemId !== "string" || params.itemId.length === 0) return;
    const repository = this.config.repositories[job.repository]?.path;
    const cwd = path.resolve(params.cwd ?? repository);
    const key = this.linkedApprovalKey(params.threadId, params.turnId, params.itemId);
    const previous = this.linkedApprovals.get(key);
    if (previous) clearTimeout(previous.timer);
    const grant = {
      jobId: job.id,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      cwd,
      kind: params.toolName === "apply_patch" ? "file" : "command",
      commandHash: params.toolName === "apply_patch" ? null : commandHash(params.command),
      timer: null,
    };
    grant.timer = setTimeout(() => {
      if (this.linkedApprovals.get(key) === grant) this.linkedApprovals.delete(key);
    }, LINKED_APPROVAL_TTL_MS);
    grant.timer.unref?.();
    this.linkedApprovals.set(key, grant);
  }

  consumeLinkedApproval(method, params, job) {
    const itemId = params.itemId;
    if (typeof itemId !== "string" || itemId.length === 0) return "absent";
    const key = this.linkedApprovalKey(params.threadId, params.turnId, itemId);
    const grant = this.linkedApprovals.get(key);
    if (!grant) return "absent";
    const expectedKind = method === "item/commandExecution/requestApproval"
      ? "command"
      : method === "item/fileChange/requestApproval" ? "file" : null;
    const repository = this.config.repositories[job.repository]?.path;
    const cwd = path.resolve(params.cwd ?? repository);
    const commandMatches = expectedKind !== "command"
      || (grant.commandHash && nativeCommandHashes(params).has(grant.commandHash));
    const matches = {
      method: Boolean(expectedKind),
      kind: grant.kind === expectedKind,
      job: grant.jobId === job.id,
      cwd: grant.cwd === cwd,
      command: commandMatches,
    };
    if (Object.values(matches).some((matchesField) => !matchesField)) {
      this.linkedApprovals.delete(key);
      clearTimeout(grant.timer);
      const failed = Object.entries(matches)
        .filter(([, matchesField]) => !matchesField)
        .map(([field]) => field)
        .join(",");
      this.logger.error?.(`Linked approval mismatch for ${method} ${itemId} (${failed})`);
      return "mismatch";
    }
    this.linkedApprovals.delete(key);
    clearTimeout(grant.timer);
    this.logger.info?.(`Linked approval consumed for ${method} ${itemId}`);
    return "accept";
  }

  clearLinkedApprovals(predicate) {
    for (const [key, grant] of [...this.linkedApprovals.entries()]) {
      if (!predicate(grant)) continue;
      this.linkedApprovals.delete(key);
      clearTimeout(grant.timer);
    }
  }

  declineMatching(predicate, reason) {
    let count = 0;
    for (const [code, pending] of [...this.pending.entries()]) {
      if (!predicate(pending)) continue;
      if (this.settle(code, false, reason)) count += 1;
    }
    return count;
  }

  uniqueCode() {
    let value = randomBytes(3).toString("hex");
    while (this.pending.has(value)) value = randomBytes(3).toString("hex");
    return value;
  }

  uniqueActionId() {
    let value = randomBytes(16).toString("hex");
    while (this.pendingActions.has(value)) value = randomBytes(16).toString("hex");
    return value;
  }
}
