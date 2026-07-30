import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { parseCommand, helpText } from "./commands.js";
import { eventDedupeKey, isWorkbenchChat, validateEvent } from "./event-policy.js";
import { MAIN_CONTEXT_ID, normalizeContextId, sendTextToTarget } from "./delivery-target.js";
import { JobQueue } from "./job-queue.js";
import { SessionState } from "./session-state.js";
import { parseTaskControlAction, TaskControlCards } from "./task-control-cards.js";
import { redactSensitiveText } from "./text-safety.js";
import { rolloutForkCutoff } from "./rollout-history.js";

function shortJobId() {
  return randomUUID().replaceAll("-", "").slice(0, 10);
}

function compactError(error) {
  const envelope = error?.details?.envelope;
  return redactSensitiveText(
    envelope?.error?.hint || envelope?.error?.message || error?.message || String(error),
  );
}

function jobLabel(job) {
  return `#${job.id} [${job.repository}]`;
}

const APPROVAL_MODE_LABELS = Object.freeze({
  strict: "严格",
  balanced: "均衡",
  auto: "自动",
});

const THREAD_CONFLICT_JOB_STATUSES = new Set([
  "waiting_conflict",
  "waiting_thread",
  "forking",
]);
const ACTIVE_JOB_STATUSES = new Set([
  "queued",
  "running",
  "canceling",
  ...THREAD_CONFLICT_JOB_STATUSES,
]);

function approvalModeLabel(mode) {
  return APPROVAL_MODE_LABELS[mode] ?? APPROVAL_MODE_LABELS.balanced;
}

function approvalStatsText(stats) {
  if (!stats) return "";
  const automatic = Number(stats.automatic ?? 0);
  const manual = Number(stats.manual ?? 0);
  if (automatic <= 0 && manual <= 0) return "";
  return `\n\n审批：自动 ${automatic} 次，人工 ${manual} 次。`;
}

function parseApprovalCardAction(rawValue) {
  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "actionId,decision,kind,v") return null;
  if (value.v !== 1 || value.kind !== "codex_approval") return null;
  if (!/^[a-f0-9]{32}$/.test(value.actionId)) return null;
  if (!new Set(["approve", "deny"]).has(value.decision)) return null;
  return { actionId: value.actionId, approved: value.decision === "approve" };
}

function approvalDecisionText(result, approved) {
  if (result.ok) {
    return `已${approved ? "批准" : "拒绝"}任务 #${result.job.id} 的本次操作。`;
  }
  return result.reason === "forbidden"
    ? "该审批不属于当前用户、聊天或审批卡片。"
    : "该审批不存在、已经处理或已经过期。";
}

export class Bridge {
  constructor({
    config,
    store,
    lark,
    codex,
    sessions,
    catalog = null,
    appServer = null,
    approvalBroker = null,
    taskControlCards = null,
    logger = console,
  }) {
    this.config = config;
    this.store = store;
    this.lark = lark;
    this.codex = codex;
    this.sessions = sessions ?? new SessionState(store);
    this.catalog = catalog;
    this.appServer = appServer;
    this.approvalBroker = approvalBroker;
    this.logger = logger;
    this.taskControlCards = taskControlCards ?? new TaskControlCards({ lark, logger });
    this.approvalBroker?.setApprovalPresenter?.(this.taskControlCards);
    this.takeoverConfirmations = new Map();
    this.threadConflicts = new Map();
    this.threadConflictPollMs = 3_000;
    this.progressState = new Map();
    this.inflightMessages = new Set();
    this.contextLocks = new Map();
    this.progressIntervalMs = 20_000;
    this.progressDebounceMs = 750;
    this.lifecycleTasks = new Set();
    this.lifecycleErrors = [];
    this.acceptingEvents = true;
    this.queue = new JobQueue(config.queue.concurrency, (job) => this.executeJob(job));
    this.queue.on("completed", (job, result) => this.safeHook(
      () => this.onJobCompleted(job, result),
      { critical: true },
    ));
    this.queue.on("failed", (job, error) => this.safeHook(
      () => this.onJobFailed(job, error),
      { critical: true },
    ));
    this.queue.on("canceled", (job) => this.safeHook(
      () => this.onQueuedJobCanceled(job),
      { critical: true },
    ));
    this.codex.on?.("progress", (progress) => this.onProgress(progress));
    this.codex.on?.("turn-started", ({ job, threadId, turnId }) => {
      this.safeHook(
        () => this.store.updateJob(job.id, { threadId, turnId }),
        { critical: true },
      );
    });
    this.codex.on?.("interrupting", ({ job, threadId, turnId, reason }) => {
      this.approvalBroker?.declineForJob(job.id, reason);
      this.approvalBroker?.declineForTurn(threadId, turnId, reason);
    });
    this.codex.on?.("turn-terminal", ({ job, threadId, turnId }) => {
      this.approvalBroker?.declineForJob(job.id, "turn_terminal");
      this.approvalBroker?.declineForTurn(threadId, turnId, "turn_terminal");
    });
    this.codex.on?.("turn-approval-close", ({ job, threadId, turnId }) => {
      this.approvalBroker?.declineForJob(job.id, "turn_completion_candidate");
      this.approvalBroker?.declineForTurn(
        threadId,
        turnId,
        "turn_completion_candidate",
      );
    });
    this.codex.on?.("recovering-orphaned-turn", ({ threadId, turnId }) => {
      this.approvalBroker?.declineForTurn(threadId, turnId, "orphan_recovery");
    });
  }

  safeHook(callback, { critical = false } = {}) {
    const task = Promise.resolve().then(callback).catch((error) => {
      if (critical) this.lifecycleErrors.push(error);
      this.logger.error?.(`Queue lifecycle error: ${compactError(error)}`);
    });
    this.lifecycleTasks.add(task);
    void task.finally(() => this.lifecycleTasks.delete(task));
    return task;
  }

  beginShutdown() {
    if (!this.acceptingEvents) return [];
    this.acceptingEvents = false;
    this.takeoverConfirmations.clear();
    for (const jobId of this.progressState.keys()) this.clearProgressState(jobId);
    for (const conflict of this.threadConflicts.values()) {
      if (conflict.timer) clearTimeout(conflict.timer);
      this.threadConflicts.delete(conflict.job.id);
      this.safeHook(
        () => this.finishThreadConflict(conflict, "interrupted", {
          progress: "桥接服务正在停止，等待中的任务已中断。",
          note: "重新启动服务后，请重新发送任务。",
        }),
        { critical: true },
      );
    }
    return this.queue.close({ cancelPending: true });
  }

  async waitForIdle() {
    await this.queue.whenIdle();
    while (this.lifecycleTasks.size > 0) {
      await Promise.allSettled([...this.lifecycleTasks]);
    }
    try {
      await this.store.flush?.();
    } catch (error) {
      this.lifecycleErrors.push(error);
    }
    if (this.lifecycleErrors.length > 0) {
      const errors = this.lifecycleErrors.splice(0);
      throw new AggregateError(errors, "Bridge lifecycle persistence failed");
    }
  }

  async recoverInterruptedJobs() {
    for (const job of this.store.listJobs()) {
      const wasActive = ACTIVE_JOB_STATUSES.has(job.status);
      if (wasActive) {
        this.taskControlCards.restore(job);
        await this.store.updateJob(job.id, {
          status: "interrupted",
          finishedAt: new Date().toISOString(),
          error: "Bridge restarted before the task completed",
        });
        await this.taskControlCards.setStatus(job.id, "interrupted", {
          progress: "桥接服务已重启，原任务已中断。",
          note: "原卡片中的审批和停止按钮均已失效。",
        });
      }

      if (!this.appServer || !job.threadId || !job.turnId
        || (!wasActive && !["interrupted", "failed"].includes(job.status))) continue;
      try {
        const repositoryPath = this.config.repositories[job.repository]?.path;
        if (repositoryPath && typeof this.codex.threadOptions === "function") {
          await this.appServer.resumeThread({
            threadId: job.threadId,
            ...this.codex.threadOptions(repositoryPath),
            excludeTurns: true,
          });
        }
        const turns = await this.listAllTurns(job.threadId);
        const orphaned = turns.find((turn) => turn.id === job.turnId);
        if (orphaned?.status !== "inProgress") continue;
        await this.appServer.interruptTurn(job.threadId, job.turnId);
        this.logger.warn?.(
          `Interrupted orphaned Codex turn ${job.turnId} for recovered job ${job.id}.`,
        );
      } catch (error) {
        this.logger.warn?.(
          `Could not reconcile recovered job ${job.id}: ${compactError(error)}`,
        );
      }
    }
  }

  async listAllTurns(threadId, { pageSize = 100, maxPages = 100 } = {}) {
    const turns = [];
    const seenTurnIds = new Set();
    const seenCursors = new Set();
    let cursor = null;

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await this.appServer.listTurns(threadId, {
        limit: pageSize,
        sortDirection: "desc",
        itemsView: "notLoaded",
        ...(cursor ? { cursor } : {}),
      });
      for (const turn of page?.data ?? []) {
        if (!turn?.id || seenTurnIds.has(turn.id)) continue;
        seenTurnIds.add(turn.id);
        turns.push(turn);
      }

      const nextCursor = page?.nextCursor ?? null;
      if (!nextCursor) return turns;
      if (seenCursors.has(nextCursor)) {
        throw new Error(`Turn pagination repeated cursor for thread ${threadId}`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new Error(`Turn pagination exceeded ${maxPages} pages for thread ${threadId}`);
  }

  async confirmNoActiveTurns(threadId, { attempts = 5, delayMs = 100 } = {}) {
    let activeTurns = [];
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      activeTurns = (await this.listAllTurns(threadId))
        .filter((turn) => turn.status === "inProgress");
      if (activeTurns.length === 0) return;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    const error = new Error(
      `Unable to confirm interruption of active turn(s): ${activeTurns.map((turn) => turn.id).join(", ")}`,
    );
    error.code = "TURN_INTERRUPT_UNCONFIRMED";
    throw error;
  }

  async handleEvent(event) {
    if (!this.acceptingEvents) {
      return { accepted: false, reason: "shutting_down" };
    }
    const policy = validateEvent(event, this.config);
    if (!policy.accepted) {
      this.logger.warn?.(`Ignored event: ${policy.reason}`);
      return { accepted: false, reason: policy.reason };
    }
    const messageKey = eventDedupeKey(event);
    if (this.store.hasProcessed(messageKey) || this.inflightMessages.has(messageKey)) {
      return { accepted: false, reason: "duplicate" };
    }
    this.inflightMessages.add(messageKey);

    try {
      if (event.type === "card.action.trigger") {
        await this.store.markProcessed(messageKey);
        return this.handleCardAction(event);
      }
      try {
        event = await this.resolveEventContext(event);
      } catch (error) {
        this.logger.error?.(`Failed to resolve Feishu topic context: ${compactError(error)}`);
        try {
          await this.lark.replyText(
            event.message_id,
            "无法识别这条消息所属的飞书话题。为避免把内容发到错误会话，本次没有执行；请稍后重试。",
            `${event.event_id || event.message_id}:context-failed`.slice(0, 128),
            { replyInThread: true },
          );
          await this.store.markProcessed(messageKey);
        } catch (replyError) {
          this.logger.error?.(`Failed to report topic context error: ${compactError(replyError)}`);
        }
        return { accepted: false, reason: "context_lookup_failed" };
      }

      await this.store.markProcessed(messageKey);
      return await this.withContextLock(event, () => this.handleCommand(event));
    } finally {
      this.inflightMessages.delete(messageKey);
    }
  }

  async handleCommand(event) {
    if (!(await this.ensureTopicOwner(event))) {
      return { accepted: false, reason: "topic_owned_by_other_sender" };
    }
    let command = parseCommand(event.content);
    if (command.type === "invalid" && command.reason === "command_required"
      && this.isTopicEvent(event)) {
      const repository = this.currentRepository(event);
      const binding = this.sessions.getBinding(this.scope(event, repository));
      if (binding) {
        command = { type: "task", prompt: String(event.content).trim(), resume: true, implicit: true };
      } else if (this.hasExplicitRepository(event)) {
        command = { type: "task", prompt: String(event.content).trim(), resume: false, implicit: true };
      } else {
        await this.reply(
          event,
          "这是一个新的 Codex 话题。请先发送 /start <仓库> <任务>，或者先用 /repo <仓库> 选定仓库，再直接描述任务。",
          "topic-needs-repository",
        );
        return { accepted: true, command };
      }
    }
    if (command.type === "invalid") {
      await this.reply(event, `${this.invalidCommandMessage(command)}\n\n${helpText()}`, "invalid");
      return { accepted: true, command };
    }

    switch (command.type) {
      case "help":
        await this.reply(event, helpText(), "help");
        break;
      case "repos":
        await this.reply(event, this.repositoryList(event), "repos");
        break;
      case "sessions":
        await this.listSessions(event);
        break;
      case "attach":
        await this.attachSession(event, command.selector);
        break;
      case "detach":
        await this.detachSession(event);
        break;
      case "fork":
        await this.forkSession(event, command.selector);
        break;
      case "takeover":
        await this.takeoverSession(event, command.confirmation);
        break;
      case "approve":
      case "deny":
        await this.decideApproval(event, command.code, command.type === "approve");
        break;
      case "repo":
        await this.selectRepository(event, command.alias);
        break;
      case "approval":
        await this.configureApprovalMode(event, command.mode);
        break;
      case "start":
        if (!(await this.startTask(event, command))) {
          return { accepted: false, reason: "shutting_down" };
        }
        break;
      case "new":
        await this.clearSession(event);
        break;
      case "status":
        await this.reply(event, this.statusText(event), "status");
        break;
      case "cancel":
        await this.cancelJob(event, command.jobId);
        break;
      case "task":
        if (!(await this.enqueueTask(event, command))) {
          return { accepted: false, reason: "shutting_down" };
        }
        break;
      default:
        throw new Error(`Unhandled command: ${command.type}`);
    }
    return { accepted: true, command };
  }

  async withContextLock(event, callback) {
    const key = `${event.chat_id}:${this.contextId(event)}`;
    const previous = this.contextLocks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.contextLocks.set(key, current);
    await previous.catch(() => {});
    try {
      return await callback();
    } finally {
      release();
      if (this.contextLocks.get(key) === current) this.contextLocks.delete(key);
    }
  }

  async ensureTopicOwner(event) {
    if (!this.isTopicEvent(event)) return true;
    const bindings = this.sessions.listBindings({
      chatId: event.chat_id,
      contextId: this.contextId(event),
    });
    const owner = bindings.find((binding) => binding.senderId !== event.sender_id);
    if (!owner) return true;
    await this.reply(
      event,
      "这个飞书话题已经由另一位允许用户绑定。为避免两条 Codex 会话串线，本次消息没有执行。",
      "topic-owner-mismatch",
    );
    return false;
  }

  invalidCommandMessage(command) {
    switch (command.reason) {
      case "command_required": return "为安全起见，只接受以 / 开头的固定命令。";
      case "repository_required": return "请提供仓库别名，例如 /repo feishu-codex。";
      case "start_arguments_required": return "请使用 /start <仓库> <任务>，例如 /start study-methods 整理学习流程。";
      case "prompt_required": return "请在命令后提供任务内容。";
      case "job_id_invalid": return "任务号格式无效，请使用 /status 查看任务号。";
      case "session_selector_required": return "请提供会话编号或 thread-id 前缀。";
      case "approval_code_invalid": return "审批确认码应为 6 位十六进制字符。";
      case "approval_mode_invalid": return "审批模式只支持 strict、balanced 或 auto。";
      default: return `未知命令：/${command.command ?? ""}`;
    }
  }

  isWorkbenchChat(chatId) {
    return isWorkbenchChat(chatId, this.config);
  }

  isTopicEvent(event) {
    return event?.chat_type === "group"
      && this.isWorkbenchChat(event.chat_id)
      && normalizeContextId(event.context_id) !== MAIN_CONTEXT_ID;
  }

  contextId(event) {
    return normalizeContextId(event?.context_id);
  }

  target(record) {
    return { chatId: record.chatId ?? record.chat_id, contextId: record.contextId ?? record.context_id };
  }

  async resolveEventContext(event) {
    if (event.chat_type !== "group" || !this.isWorkbenchChat(event.chat_id)) {
      return { ...event, context_id: MAIN_CONTEXT_ID };
    }
    const embedded = {
      chatId: event.chat_id,
      threadId: event.thread_id ?? null,
      rootId: event.root_id ?? null,
      parentId: event.parent_id ?? null,
    };
    const details = embedded.rootId
      ? embedded
      : await this.lark.getMessageContext(event.message_id);
    if (details.chatId !== event.chat_id) {
      throw new Error(`Message context belongs to unexpected chat ${details.chatId}`);
    }
    const rootMessageId = await this.canonicalRootMessageId(
      details,
      event.message_id,
      event.chat_id,
    );
    return {
      ...event,
      content: this.normalizeWorkbenchContent(details.text ?? event.content, details.mentionKeys),
      context_id: rootMessageId,
      root_id: details.rootId,
      parent_id: details.parentId,
      thread_id: details.threadId,
    };
  }

  normalizeWorkbenchContent(rawContent, mentionKeys = []) {
    let content = String(rawContent ?? "").trimStart();
    const keys = [...new Set(mentionKeys.filter((key) => typeof key === "string" && key.length > 0))]
      .sort((left, right) => right.length - left.length);
    while (keys.length > 0) {
      const key = keys.find((candidate) => content.startsWith(candidate));
      if (!key) break;
      content = content.slice(key.length).trimStart();
    }
    return content;
  }

  async canonicalRootMessageId(details, messageId, chatId) {
    if (details.rootId) return details.rootId;
    let parentId = details.parentId;
    const visited = new Set([messageId]);
    for (let depth = 0; parentId && depth < 8; depth += 1) {
      if (visited.has(parentId)) throw new Error("Feishu message parent chain contains a cycle");
      visited.add(parentId);
      const parent = await this.lark.getMessageContext(parentId);
      if (parent.chatId !== chatId) {
        throw new Error(`Message parent belongs to unexpected chat ${parent.chatId}`);
      }
      if (parent.rootId) return parent.rootId;
      if (!parent.parentId) return parent.messageId;
      parentId = parent.parentId;
    }
    if (parentId) throw new Error("Feishu message parent chain is too deep");
    return messageId;
  }

  hasExplicitRepository(event) {
    const key = this.store.conversationKey(event.sender_id, event.chat_id, this.contextId(event));
    return Boolean(this.store.state.preferences?.[key]?.repository);
  }

  currentRepository(event) {
    return this.store.getRepository(
      event.sender_id,
      event.chat_id,
      this.config.defaultRepository,
      this.contextId(event),
    );
  }

  currentApprovalMode(event) {
    return this.store.getApprovalMode(
      event.sender_id,
      event.chat_id,
      this.contextId(event),
    );
  }

  async configureApprovalMode(event, mode) {
    if (mode) {
      await this.store.setApprovalMode(
        event.sender_id,
        event.chat_id,
        mode,
        this.contextId(event),
      );
    }
    const current = mode ?? this.currentApprovalMode(event);
    const details = {
      strict: "每项可审批操作都需要人工确认。",
      balanced: "可信读取和普通文件修改自动通过，高风险或未知操作仍需确认。",
      auto: "仓库内文件操作尽量自动通过；提权、联网、越界和不可信命令仍受保护。",
    }[current];
    await this.reply(
      event,
      `当前审批模式：${current}（${approvalModeLabel(current)}）\n${details}\n新模式只影响之后创建的任务。`,
      `approval-mode-${current}`,
    );
  }

  scope(event, repository = this.currentRepository(event)) {
    return {
      senderId: event.sender_id,
      chatId: event.chat_id,
      contextId: this.contextId(event),
      repository,
    };
  }

  repositoryList(event) {
    const current = this.currentRepository(event);
    const lines = Object.keys(this.config.repositories).map(
      (alias) => `${alias === current ? "●" : "○"} ${alias}`,
    );
    return `允许的仓库：\n${lines.join("\n")}`;
  }

  async selectRepository(event, alias) {
    if (!this.config.repositories[alias]) {
      await this.reply(event, `仓库别名不存在：${alias}\n\n${this.repositoryList(event)}`, "repo-missing");
      return;
    }
    if (this.isTopicEvent(event)) {
      const bindings = this.sessions.listBindings({
        chatId: event.chat_id,
        contextId: this.contextId(event),
      });
      const active = this.hasActiveJob(event);
      if (active) {
        await this.reply(event, "这个话题已有任务正在运行，暂时不能切换仓库。", "repo-topic-active");
        return;
      }
      if (bindings.length > 0 && bindings.some((binding) => binding.repository !== alias)) {
        await this.reply(
          event,
          `这个话题已经固定绑定仓库 ${bindings[0].repository}。如需使用 ${alias}，请新建一个飞书话题。`,
          "repo-topic-locked",
        );
        return;
      }
    }
    await this.store.setRepository(
      event.sender_id,
      event.chat_id,
      alias,
      this.contextId(event),
    );
    await this.reply(event, `已切换到仓库：${alias}`, "repo-selected");
  }

  async startTask(event, command) {
    if (!this.config.repositories[command.alias]) {
      await this.reply(
        event,
        `仓库别名不存在：${command.alias}\n\n${this.repositoryList(event)}`,
        "start-repo-missing",
      );
      return true;
    }
    if (this.isTopicEvent(event)) {
      const bindings = this.sessions.listBindings({
        chatId: event.chat_id,
        contextId: this.contextId(event),
      });
      if (bindings.length > 0) {
        await this.reply(
          event,
          "这个话题已经绑定了一条 Codex 会话。请直接发送普通文字继续，或新建飞书话题开启新会话。",
          "start-topic-bound",
        );
        return true;
      }
      if (this.hasActiveJob(event)) {
        await this.reply(
          event,
          "这个话题正在创建 Codex 会话，请等待当前任务完成后再继续。",
          "start-topic-active",
        );
        return true;
      }
    }
    await this.store.setRepository(
      event.sender_id,
      event.chat_id,
      command.alias,
      this.contextId(event),
    );
    return this.enqueueTask(event, { type: "task", prompt: command.prompt, resume: false });
  }

  async clearSession(event) {
    if (this.isTopicEvent(event)) {
      await this.reply(
        event,
        "飞书话题与 Codex 会话保持固定绑定，不能在原话题内清空后改作其他会话。请新建一个话题。",
        "topic-new-required",
      );
      return;
    }
    const repository = this.currentRepository(event);
    const scope = this.scope(event, repository);
    const binding = this.sessions.getBinding(scope);
    if (binding) {
      await this.sessions.detach(scope, { expectedBindingGeneration: binding.bindingGeneration });
    }
    await this.reply(event, `已清除仓库 ${repository} 的 Codex 会话。`, "session-cleared");
  }

  statusText(event) {
    const repository = this.currentRepository(event);
    const status = this.queue.status();
    const session = this.sessions.getBinding(this.scope(event, repository));
    const belongsToConversation = (job) => this.jobBelongsToEvent(job, event);
    const running = status.running.filter(belongsToConversation).map(jobLabel).join(", ") || "无";
    const pending = status.pending.filter(belongsToConversation).map(jobLabel).join(", ") || "无";
    const waiting = [...this.threadConflicts.values()]
      .map((conflict) => conflict.job)
      .filter(belongsToConversation)
      .map(jobLabel)
      .join(", ") || "无";
    return [
      `当前仓库：${repository}`,
      `审批模式：${this.currentApprovalMode(event)}（${approvalModeLabel(this.currentApprovalMode(event))}）`,
      ...(this.isTopicEvent(event) ? [`当前话题：${this.contextId(event).slice(0, 12)}`] : []),
      `运行中：${running}`,
      `排队中：${pending}`,
      `等待会话处理：${waiting}`,
      `可续接会话：${session?.threadId ? session.threadId : "无"}`,
      `会话来源：${session?.source ?? "无"}`,
      `移动端 lease：${session?.lease?.active ? `${session.lease.owner}（至 ${session.lease.expiresAt}）` : "无"}`,
    ].join("\n");
  }

  jobBelongsToEvent(job, event) {
    return job.senderId === event.sender_id
      && job.chatId === event.chat_id
      && normalizeContextId(job.contextId) === this.contextId(event);
  }

  hasActiveJob(event) {
    const belongs = (job) => this.isTopicEvent(event)
      ? job.chatId === event.chat_id
        && normalizeContextId(job.contextId) === this.contextId(event)
      : this.jobBelongsToEvent(job, event);
    const queued = this.queue.status();
    if ([...queued.running, ...queued.pending].some(belongs)) {
      return true;
    }
    return this.store.listJobs().some((job) => (
      ACTIVE_JOB_STATUSES.has(job.status)
      && belongs(job)
    ));
  }

  requireCatalog() {
    if (!this.catalog || !this.appServer) {
      const error = new Error("Codex app-server 当前不可用，会话发现与接管功能已降级关闭");
      error.code = "APP_SERVER_UNAVAILABLE";
      throw error;
    }
  }

  requireThreadConflictBackend() {
    if (!this.appServer || typeof this.appServer.listTurns !== "function") {
      const error = new Error("Codex app-server 当前不可用，无法检查会话占用状态");
      error.code = "APP_SERVER_UNAVAILABLE";
      throw error;
    }
  }

  async latestCompletedTurnId(threadId) {
    const page = await this.appServer.listTurns(threadId, {
      limit: 50,
      sortDirection: "desc",
    });
    return page?.data?.find((turn) => turn.status === "completed")?.id ?? null;
  }

  async safeForkCutoff(threadId) {
    const rollout = await rolloutForkCutoff(threadId);
    if (rollout?.hasResidual) {
      if (rollout.lastTurnId) return rollout.lastTurnId;
      const error = new Error("源会话的首个回合仍处于残留运行状态，无法找到安全的 Fork 截断点");
      error.code = "FORK_CUTOFF_UNAVAILABLE";
      throw error;
    }

    const turns = await this.listAllTurns(threadId);
    let oldestActiveIndex = -1;
    for (let index = 0; index < turns.length; index += 1) {
      if (turns[index].status === "inProgress") oldestActiveIndex = index;
    }
    if (oldestActiveIndex < 0) return null;

    const cutoff = turns.slice(oldestActiveIndex + 1)
      .find((turn) => turn.status !== "inProgress");
    if (!cutoff) {
      const error = new Error("源会话的首个回合仍处于残留运行状态，无法找到安全的 Fork 截断点");
      error.code = "FORK_CUTOFF_UNAVAILABLE";
      throw error;
    }
    return cutoff.id;
  }

  async listSessions(event) {
    try {
      this.requireCatalog();
      const scope = this.scope(event);
      const threads = await this.catalog.list(scope);
      const binding = this.sessions.getBinding(scope);
      await this.reply(event, this.catalog.format(threads, binding?.threadId), "sessions");
    } catch (error) {
      await this.reply(event, `无法列出会话：${compactError(error)}`, "sessions-failed");
    }
  }

  async attachSession(event, selector) {
    try {
      this.requireCatalog();
      const scope = this.scope(event);
      const snapshot = this.sessions.getSnapshot(scope);
      const thread = await this.catalog.resolve(scope, selector);
      if (this.isTopicEvent(event) && snapshot.threadId && snapshot.threadId !== thread.id) {
        throw new Error("这个飞书话题已经绑定其他 Codex 会话；请新建话题后再绑定");
      }
      const duplicate = this.sessions.listBindings().find((binding) => (
        binding.threadId === thread.id
        && (
          binding.senderId !== scope.senderId
          || binding.chatId !== scope.chatId
          || binding.contextId !== scope.contextId
          || binding.repository !== scope.repository
        )
      ));
      if (duplicate) {
        throw new Error(
          `该 Codex 会话已绑定到另一个飞书上下文（${duplicate.repository}/${duplicate.contextId.slice(0, 12)}）；请先在那里 /detach`,
        );
      }
      const lastSyncedTurnId = await this.latestCompletedTurnId(thread.id);
      const options = {
        expectedBindingGeneration: snapshot.bindingGeneration,
        ...(snapshot.threadId && snapshot.threadId !== thread.id ? { replace: true } : {}),
      };
      const binding = await this.sessions.bind(scope, {
        threadId: thread.id,
        title: thread.name || thread.preview || null,
        source: typeof thread.source === "string" ? thread.source : "unknown",
        lastSyncedTurnId,
      }, options);
      await this.reply(
        event,
        `已绑定会话 ${binding.threadId.slice(0, 8)}（${binding.source}）。\n使用 /continue <内容> 接着聊。`,
        "attached",
      );
    } catch (error) {
      await this.reply(event, `绑定失败：${this.sessionError(error)}`, "attach-failed");
    }
  }

  async detachSession(event) {
    try {
      if (this.isTopicEvent(event)) {
        await this.reply(
          event,
          "话题绑定不会在原地解除，以免后续消息串到其他会话。需要迁移时，请先在旧私聊中 /detach，再新建话题绑定。",
          "topic-detach-blocked",
        );
        return;
      }
      const scope = this.scope(event);
      const binding = this.sessions.getBinding(scope);
      if (!binding) {
        await this.reply(event, "当前仓库没有绑定会话。", "detach-empty");
        return;
      }
      await this.sessions.detach(scope, { expectedBindingGeneration: binding.bindingGeneration });
      await this.reply(event, `已解除会话 ${binding.threadId.slice(0, 8)} 的绑定。`, "detached");
    } catch (error) {
      await this.reply(event, `解绑失败：${this.sessionError(error)}`, "detach-failed");
    }
  }

  async forkSession(event, selector) {
    let forkedThreadId = null;
    try {
      this.requireCatalog();
      const scope = this.scope(event);
      const snapshot = this.sessions.getSnapshot(scope);
      if (this.isTopicEvent(event) && snapshot.threadId) {
        throw new Error("这个话题已绑定会话；请新建一个飞书话题后再执行 /fork");
      }
      const source = await this.catalog.resolve(scope, selector);
      if (source.status?.type === "active") {
        throw new Error("源会话正在运行，请等待完成后再 fork");
      }
      const repositoryPath = this.config.repositories[scope.repository].path;
      const lastTurnId = await this.safeForkCutoff(source.id);
      const result = await this.appServer.forkThread({
        threadId: source.id,
        ...this.codex.threadOptions(repositoryPath),
        approvalPolicy: "never",
        excludeTurns: true,
        threadSource: "feishu-fork",
        ...(lastTurnId ? { lastTurnId } : {}),
      });
      forkedThreadId = result.thread.id;
      const lastSyncedTurnId = await this.latestCompletedTurnId(result.thread.id);
      const options = {
        expectedBindingGeneration: snapshot.bindingGeneration,
        ...(snapshot.threadId && snapshot.threadId !== result.thread.id ? { replace: true } : {}),
      };
      await this.sessions.bind(scope, {
        threadId: result.thread.id,
        title: `${source.name || source.preview || "会话"}（飞书分支）`,
        source: "feishu-fork",
        lastSyncedTurnId,
      }, options);
      await this.reply(
        event,
        `已从 ${source.id.slice(0, 8)} 创建并绑定分支 ${result.thread.id.slice(0, 8)}。${lastTurnId ? "检测到未结束的历史回合，已在其之前安全截断。" : ""}`,
        "forked",
      );
    } catch (error) {
      const prefix = forkedThreadId
        ? `分支 ${forkedThreadId.slice(0, 8)} 已创建，但未绑定：`
        : "Fork 失败：";
      await this.reply(event, `${prefix}${this.sessionError(error)}`, "fork-failed");
    }
  }

  async takeoverSession(event, confirmation) {
    const scope = this.scope(event);
    const key = scope.contextId === MAIN_CONTEXT_ID
      ? `${scope.senderId}:${scope.chatId}:${scope.repository}`
      : `${scope.senderId}:${scope.chatId}:${scope.contextId}:${scope.repository}`;
    try {
      const binding = this.sessions.getBinding(scope);
      if (!binding) throw new Error("当前仓库没有绑定会话");
      if (!confirmation) {
        const code = randomUUID().replaceAll("-", "").slice(0, 6);
        this.takeoverConfirmations.set(key, {
          code,
          expiresAt: Date.now() + 5 * 60_000,
          bindingGeneration: binding.bindingGeneration,
          leaseGeneration: binding.leaseGeneration,
          threadId: binding.threadId,
        });
        await this.reply(
          event,
          `接管会中断该 thread 的活动 turn，并可能影响电脑侧正在进行的工作。\n确认请在 5 分钟内发送：/takeover ${code}`,
          "takeover-confirm",
        );
        return;
      }
      const pending = this.takeoverConfirmations.get(key);
      this.takeoverConfirmations.delete(key);
      if (!pending || pending.expiresAt < Date.now() || pending.code !== confirmation) {
        throw new Error("确认码无效或已过期，请重新发送 /takeover");
      }
      const takeover = await this.sessions.takeoverLease(scope, {
        owner: `takeover:${event.message_id}`,
        observedGeneration: pending.leaseGeneration,
        expectedThreadId: pending.threadId,
        expectedBindingGeneration: pending.bindingGeneration,
        ttlMs: 15 * 60_000,
        reason: "confirmed_from_feishu",
      });
      let takeoverComplete = false;
      try {
        const previousJobMatch = /^job:([^\s:]+)$/.exec(takeover.previousLease?.owner ?? "");
        if (previousJobMatch) {
          const previousJobId = previousJobMatch[1];
          const previousJob = this.store.getJob(previousJobId);
          const ownsLease = previousJob?.senderId === scope.senderId
            && previousJob.chatId === scope.chatId
            && normalizeContextId(previousJob.contextId) === scope.contextId
            && previousJob.repository === scope.repository;
          if (ownsLease) {
            this.approvalBroker?.declineForJob(previousJobId, "takeover");
            const cancellation = this.queue.cancel(previousJobId);
            if (cancellation?.type === "running") {
              await this.store.updateJob(previousJobId, { status: "canceling" });
            }
            const canceled = await this.codex.cancel(previousJobId);
            if (cancellation?.type === "running" && !canceled) {
              throw new Error(`Unable to confirm cancellation of job ${previousJobId}`);
            }
          }
        }
        if (this.appServer) {
          const activeTurns = (await this.listAllTurns(takeover.binding.threadId))
            .filter((turn) => turn.status === "inProgress");
          for (const activeTurn of activeTurns) {
            this.approvalBroker?.declineForTurn(
              takeover.binding.threadId,
              activeTurn.id,
              "takeover",
            );
            await this.appServer.interruptTurn(takeover.binding.threadId, activeTurn.id);
          }
          await this.confirmNoActiveTurns(takeover.binding.threadId);
        }
        takeoverComplete = true;
      } finally {
        if (takeoverComplete) await this.sessions.releaseLease(scope, takeover.token);
      }
      await this.reply(event, "接管已完成。现在可使用 /continue <内容>。", "takeover-done");
    } catch (error) {
      await this.reply(event, `接管失败：${this.sessionError(error)}`, "takeover-failed");
    }
  }

  async decideApproval(event, code, approved) {
    if (!this.approvalBroker) {
      await this.reply(event, "当前没有启用远程审批代理。", "approval-unavailable");
      return;
    }
    const result = this.approvalBroker.decide({
      senderId: event.sender_id,
      chatId: event.chat_id,
      contextId: this.contextId(event),
      code,
      approved,
    });
    const text = approvalDecisionText(result, approved);
    await this.reply(event, text, `approval-${approved ? "yes" : "no"}-${code}`);
  }

  async handleCardAction(event) {
    if (parseApprovalCardAction(event.action_value)) {
      return this.handleApprovalCardAction(event);
    }
    const control = parseTaskControlAction(event.action_value);
    if (control) return this.handleTaskControlCardAction(event, control);
    this.logger.warn?.("Ignored event: invalid_card_action");
    return { accepted: false, reason: "invalid_card_action" };
  }

  async handleApprovalCardAction(event) {
    const action = parseApprovalCardAction(event.action_value);
    if (!action) {
      this.logger.warn?.("Ignored event: invalid_card_action");
      return { accepted: false, reason: "invalid_card_action" };
    }
    if (!this.approvalBroker) {
      await this.reply(event, "当前没有启用远程审批代理。", "approval-card-unavailable");
      return { accepted: true, action };
    }
    const result = this.approvalBroker.decideCard({
      senderId: event.operator_id,
      chatId: event.chat_id,
      messageId: event.message_id,
      actionId: action.actionId,
      approved: action.approved,
    });
    if (result.ok && result.presentation === "control") {
      const updated = await this.taskControlCards.settleApproval(
        result.job.id,
        result.actionId,
        action.approved,
        action.approved ? "card_approved" : "card_denied",
      );
      if (updated) return { accepted: true, action, result };
    }
    if (result.ok && result.card && typeof event.token === "string"
      && typeof this.lark.updateApprovalCard === "function") {
      try {
        await this.lark.updateApprovalCard(event.token, result.card, event.operator_id);
      } catch (error) {
        this.logger.error?.(`Failed to update approval card: ${compactError(error)}`);
      }
    }
    const decisionText = approvalDecisionText(result, action.approved);
    if (result.job && this.isWorkbenchChat(event.chat_id)) {
      await this.replyToJob(
        result.job,
        decisionText,
        `approval-card-${action.approved ? "yes" : "no"}-${event.event_id}`,
      );
    } else if (this.isWorkbenchChat(event.chat_id)) {
      try {
        await this.lark.replyText(
          event.message_id,
          decisionText,
          `${event.event_id}:approval-card-result`.slice(0, 128),
          { replyInThread: true },
        );
      } catch (error) {
        this.logger.error?.(`Failed to send approval decision: ${compactError(error)}`);
      }
    } else {
      await this.reply(
        event,
        decisionText,
        `approval-card-${action.approved ? "yes" : "no"}-${event.event_id}`,
      );
    }
    return { accepted: true, action, result };
  }

  async handleTaskControlCardAction(event, action) {
    if (action.token) return this.handleThreadConflictCardAction(event, action);
    const job = this.taskControlCards.validateStop({
      jobId: action.jobId,
      senderId: event.operator_id,
      chatId: event.chat_id,
      messageId: event.message_id,
    });
    if (!job) return { accepted: false, reason: "invalid_task_control" };
    const result = await this.requestJobCancellation(job);
    if (!result) return { accepted: false, reason: "job_not_active" };
    if (result.type === "thread_conflict") {
      return { accepted: true, action, job, result };
    }
    await this.taskControlCards.setStatus(job.id, result.type === "pending" ? "canceled" : "canceling", {
      progress: result.type === "pending" ? "排队任务已取消。" : "正在停止 Codex 任务。",
    });
    return { accepted: true, action, job, result };
  }

  async handleThreadConflictCardAction(event, action) {
    const job = this.taskControlCards.validateThreadConflict({
      jobId: action.jobId,
      token: action.token,
      senderId: event.operator_id,
      chatId: event.chat_id,
      messageId: event.message_id,
    });
    const conflict = this.threadConflicts.get(action.jobId);
    if (!job || !conflict || conflict.job !== job
      || conflict.token !== action.token || conflict.phase !== "choice") {
      return { accepted: false, reason: "invalid_thread_conflict" };
    }

    // Claim synchronously before any await so two distinct card events cannot both win.
    conflict.phase = action.action;
    if (action.action === "cancel") {
      const result = await this.cancelThreadConflict(conflict);
      return { accepted: true, action, job, result };
    }
    if (action.action === "wait") {
      await this.beginThreadConflictWait(conflict);
      return { accepted: true, action, job };
    }
    await this.forkThreadConflict(conflict);
    return { accepted: true, action, job };
  }

  conflictScope(job) {
    return {
      senderId: job.senderId,
      chatId: job.chatId,
      contextId: normalizeContextId(job.contextId),
      repository: job.repository,
    };
  }

  isCurrentThreadConflict(conflict) {
    return this.threadConflicts.get(conflict.job.id) === conflict;
  }

  async deferThreadBusyJob(job, error) {
    const threadId = error?.threadId ?? job.resumeThreadId ?? null;
    if (typeof threadId !== "string" || threadId.length === 0) return false;
    if (job.resumeThreadId && job.resumeThreadId !== threadId) return false;

    const scope = this.conflictScope(job);
    if (!job.resumeThreadId) {
      const snapshot = this.sessions.getSnapshot(scope);
      const expectedThreadId = job.bindingSnapshotThreadId ?? null;
      const expectedGeneration = job.bindingSnapshotGeneration ?? 0;
      if (snapshot.threadId !== expectedThreadId
        || snapshot.bindingGeneration !== expectedGeneration) return false;
      try {
        const binding = await this.sessions.bind(scope, {
          threadId,
          title: null,
          source: "feishu",
        }, { expectedBindingGeneration: expectedGeneration });
        job.resumeThreadId = threadId;
        job.bindingSnapshotThreadId = threadId;
        job.bindingSnapshotGeneration = binding.bindingGeneration;
      } catch {
        return false;
      }
    }

    const token = randomUUID().replaceAll("-", "");
    const conflict = {
      job,
      threadId,
      conflictingTurnId: error?.conflictingTurnId ?? null,
      token,
      phase: "choice",
      timer: null,
    };
    this.threadConflicts.set(job.id, conflict);
    await this.store.updateJob(job.id, {
      status: "waiting_conflict",
      threadId,
      resumeThreadId: job.resumeThreadId,
      bindingSnapshotThreadId: job.bindingSnapshotThreadId,
      bindingSnapshotGeneration: job.bindingSnapshotGeneration,
      error: compactError(error),
      finishedAt: null,
    });
    const detail = conflict.conflictingTurnId
      ? `活动回合：${conflict.conflictingTurnId.slice(0, 12)}`
      : null;
    const shown = await this.taskControlCards.showThreadConflict(job.id, {
      token,
      progress: "检测到该会话正在被其他客户端使用，任务尚未执行。",
      note: detail,
    });
    if (!shown) {
      if (this.isCurrentThreadConflict(conflict)) this.threadConflicts.delete(job.id);
      return false;
    }
    return true;
  }

  async beginThreadConflictWait(conflict) {
    if (!this.isCurrentThreadConflict(conflict) || conflict.phase !== "wait") return false;
    await this.store.updateJob(conflict.job.id, {
      status: "waiting_thread",
      error: null,
    });
    if (!this.isCurrentThreadConflict(conflict)) return false;
    await this.taskControlCards.setThreadConflictPhase(
      conflict.job.id,
      conflict.token,
      "waiting_thread",
      {
        progress: "正在等待电脑端或其他客户端结束当前回合；空闲后会自动继续。",
        note: "等待期间可点击“停止任务”，不会中断其他客户端的回合。",
      },
    );
    if (!this.isCurrentThreadConflict(conflict)) return false;
    this.scheduleThreadConflictPoll(conflict, 0);
    return true;
  }

  scheduleThreadConflictPoll(conflict, delayMs = this.threadConflictPollMs) {
    if (!this.isCurrentThreadConflict(conflict) || conflict.phase !== "wait") return;
    if (conflict.timer) clearTimeout(conflict.timer);
    conflict.timer = setTimeout(() => {
      conflict.timer = null;
      this.safeHook(() => this.pollThreadConflict(conflict), { critical: true });
    }, delayMs);
    conflict.timer.unref?.();
  }

  async pollThreadConflict(conflict) {
    if (!this.isCurrentThreadConflict(conflict) || conflict.phase !== "wait") return;
    if (!this.acceptingEvents) {
      this.threadConflicts.delete(conflict.job.id);
      await this.finishThreadConflict(conflict, "interrupted", {
        progress: "桥接服务正在停止，等待中的任务已中断。",
      });
      return;
    }
    try {
      this.requireThreadConflictBackend();
      const turns = await this.listAllTurns(conflict.threadId);
      const recoverableTurnId = this.store.getJob(conflict.job.id)?.turnId ?? null;
      const unknownActiveTurn = turns.some((turn) => (
        turn.status === "inProgress" && turn.id !== recoverableTurnId
      ));
      if (unknownActiveTurn) {
        this.scheduleThreadConflictPoll(conflict);
        return;
      }
      await this.requeueThreadConflict(conflict);
    } catch (error) {
      if (!this.isCurrentThreadConflict(conflict) || conflict.phase !== "wait") return;
      await this.taskControlCards.setThreadConflictPhase(
        conflict.job.id,
        conflict.token,
        "waiting_thread",
        {
          progress: "暂时无法确认会话是否空闲，稍后会自动重试。",
          note: compactError(error),
        },
      );
      this.scheduleThreadConflictPoll(conflict);
    }
  }

  async requeueThreadConflict(conflict) {
    if (!this.isCurrentThreadConflict(conflict)) return false;
    const snapshot = this.sessions.getSnapshot(this.conflictScope(conflict.job));
    if (snapshot.threadId !== conflict.job.resumeThreadId
      || snapshot.bindingGeneration !== conflict.job.bindingSnapshotGeneration) {
      this.threadConflicts.delete(conflict.job.id);
      await this.finishThreadConflict(conflict, "failed", {
        progress: "等待期间会话绑定发生变化，任务未继续。",
        note: "请在当前话题重新发送任务。",
        error: "Session binding changed while waiting for an active turn",
      });
      return false;
    }
    conflict.phase = "requeueing";
    await this.store.updateJob(conflict.job.id, {
      status: "queued",
      error: null,
      finishedAt: null,
    });
    await this.taskControlCards.setStatus(conflict.job.id, "queued", {
      progress: "会话已经空闲，任务重新进入队列。",
      note: null,
    });
    if (!this.isCurrentThreadConflict(conflict) || !this.acceptingEvents) {
      if (this.isCurrentThreadConflict(conflict)) this.threadConflicts.delete(conflict.job.id);
      await this.finishThreadConflict(conflict, "interrupted", {
        progress: "桥接服务正在停止，任务未重新启动。",
      });
      return false;
    }
    this.threadConflicts.delete(conflict.job.id);
    try {
      this.queue.add(conflict.job);
      return true;
    } catch (error) {
      await this.finishThreadConflict(conflict, "interrupted", {
        progress: "任务未能重新进入队列。",
        note: compactError(error),
        error: compactError(error),
      });
      return false;
    }
  }

  async forkThreadConflict(conflict) {
    if (!this.isCurrentThreadConflict(conflict) || conflict.phase !== "fork") return false;
    await this.store.updateJob(conflict.job.id, { status: "forking", error: null });
    await this.taskControlCards.setThreadConflictPhase(
      conflict.job.id,
      conflict.token,
      "forking",
      {
        progress: "正在从最后一个安全回合创建分支，不会中断其他客户端。",
        note: null,
      },
    );

    const scope = this.conflictScope(conflict.job);
    let leaseToken = null;
    let forkedThreadId = null;
    try {
      this.requireThreadConflictBackend();
      if (typeof this.appServer.forkThread !== "function"
        || typeof this.codex.threadOptions !== "function") {
        throw new Error("Codex app-server 当前不可用，无法创建安全分支");
      }
      if (!this.isCurrentThreadConflict(conflict) || !this.acceptingEvents) return false;
      const sourceBinding = this.sessions.getBinding(scope);
      const lease = await this.sessions.acquireLease(scope, {
        owner: `conflict-fork:${conflict.job.id}`,
        expectedThreadId: conflict.threadId,
        expectedBindingGeneration: conflict.job.bindingSnapshotGeneration,
      });
      leaseToken = lease.token;
      if (!this.isCurrentThreadConflict(conflict) || !this.acceptingEvents) return false;

      let lastTurnId = await this.safeForkCutoff(conflict.threadId);
      if (!lastTurnId) {
        const terminalTurn = (await this.listAllTurns(conflict.threadId))
          .find((turn) => turn.status !== "inProgress");
        if (!terminalTurn) {
          const error = new Error("源会话没有可用于安全 Fork 的已结束回合");
          error.code = "FORK_CUTOFF_UNAVAILABLE";
          throw error;
        }
        lastTurnId = terminalTurn.id;
      }
      if (!this.isCurrentThreadConflict(conflict) || !this.acceptingEvents) return false;
      const result = await this.appServer.forkThread({
        threadId: conflict.threadId,
        ...this.codex.threadOptions(conflict.job.repositoryPath),
        approvalPolicy: "never",
        excludeTurns: true,
        threadSource: "feishu-conflict-fork",
        lastTurnId,
      });
      forkedThreadId = result?.thread?.id ?? null;
      if (!forkedThreadId) throw new Error("Fork did not return a thread id");
      if (!this.isCurrentThreadConflict(conflict) || !this.acceptingEvents) return false;

      const committed = await this.sessions.commitFork(scope, leaseToken, {
        sourceThreadId: conflict.threadId,
        newThreadId: forkedThreadId,
        title: `${sourceBinding?.title || "会话"}（飞书冲突分支）`,
        source: "feishu-conflict-fork",
      });
      leaseToken = committed.token;
      conflict.threadId = forkedThreadId;
      conflict.job.resumeThreadId = forkedThreadId;
      conflict.job.bindingSnapshotThreadId = forkedThreadId;
      conflict.job.bindingSnapshotGeneration = committed.binding.bindingGeneration;
      await this.store.updateJob(conflict.job.id, {
        threadId: forkedThreadId,
        turnId: null,
        resumeThreadId: forkedThreadId,
        bindingSnapshotThreadId: forkedThreadId,
        bindingSnapshotGeneration: committed.binding.bindingGeneration,
      });
      await this.sessions.releaseLease(scope, leaseToken);
      leaseToken = null;
      return await this.requeueThreadConflict(conflict);
    } catch (error) {
      if (!this.isCurrentThreadConflict(conflict) || !this.acceptingEvents) return false;
      const token = randomUUID().replaceAll("-", "");
      conflict.token = token;
      conflict.phase = "choice";
      const orphanNote = forkedThreadId
        ? `分支 ${forkedThreadId.slice(0, 8)} 已创建，但未能安全绑定。`
        : "未创建分支。";
      await this.store.updateJob(conflict.job.id, {
        status: "waiting_conflict",
        error: compactError(error),
      });
      const shown = await this.taskControlCards.showThreadConflict(conflict.job.id, {
        token,
        progress: "安全 Fork 未完成，请重新选择处理方式。",
        note: `${orphanNote} ${compactError(error)}`,
      });
      if (!shown) {
        this.threadConflicts.delete(conflict.job.id);
        await this.finishThreadConflict(conflict, "failed", {
          progress: "安全 Fork 失败，任务未执行。",
          note: compactError(error),
          error: compactError(error),
        });
        await this.replyToJob(
          conflict.job,
          `任务 ${jobLabel(conflict.job)} 启动失败。\n${compactError(error)}`,
          "conflict-fork-failed",
        );
      }
      return false;
    } finally {
      if (leaseToken) {
        await this.sessions.releaseLease(scope, leaseToken).catch((error) => {
          this.logger.error?.(`Conflict fork lease release failed: ${compactError(error)}`);
        });
      }
    }
  }

  async cancelThreadConflict(conflict) {
    if (!this.isCurrentThreadConflict(conflict)) return null;
    if (conflict.timer) clearTimeout(conflict.timer);
    this.threadConflicts.delete(conflict.job.id);
    await this.finishThreadConflict(conflict, "canceled", {
      progress: "任务已取消；其他客户端的活动回合未受影响。",
    });
    return { type: "thread_conflict", stopped: true, job: conflict.job };
  }

  async finishThreadConflict(conflict, status, {
    progress,
    note = undefined,
    error = null,
  } = {}) {
    if (conflict.timer) clearTimeout(conflict.timer);
    if (this.isCurrentThreadConflict(conflict)) this.threadConflicts.delete(conflict.job.id);
    this.approvalBroker?.declineForJob(conflict.job.id, `thread_conflict_${status}`);
    const stats = this.approvalBroker?.takeJobStats?.(conflict.job.id) ?? null;
    await this.store.updateJob(conflict.job.id, {
      status,
      finishedAt: new Date().toISOString(),
      error,
    });
    await this.taskControlCards.setStatus(conflict.job.id, status, {
      progress,
      note,
      stats,
    });
  }

  sessionError(error) {
    switch (error?.code) {
      case "lease_conflict": return "该会话正由另一项移动端任务使用；可用 /status 查看。";
      case "provider_mismatch": return "该会话使用不同模型提供商，默认禁止接管。";
      case "selection_expired": return "会话列表已过期，请重新发送 /sessions。";
      case "THREAD_BUSY": return "电脑侧或其他客户端正在运行该会话。请等待、/fork，或使用 /takeover 二次确认。";
      default: return compactError(error);
    }
  }

  async enqueueTask(event, command) {
    if (!this.acceptingEvents) return false;
    if (command.prompt.length > this.config.limits.maxPromptChars) {
      await this.reply(
        event,
        `任务过长：${command.prompt.length} 字符，限制为 ${this.config.limits.maxPromptChars}。`,
        "prompt-too-long",
      );
      return true;
    }
    const repository = this.currentRepository(event);
    const repositoryPath = this.config.repositories[repository].path;
    try {
      await access(repositoryPath);
    } catch {
      await this.reply(event, `仓库路径不可访问：${repository}`, "repo-unavailable");
      return true;
    }

    const scope = this.scope(event, repository);
    const bindingSnapshot = this.sessions.getSnapshot(scope);
    const session = command.resume ? this.sessions.getBinding(scope) : null;
    if (this.isTopicEvent(event) && !command.resume && this.hasActiveJob(event)) {
      await this.reply(
        event,
        "这个话题正在创建 Codex 会话，请等待当前任务完成后再继续。",
        "topic-task-active",
      );
      return true;
    }
    if (this.isTopicEvent(event) && !command.resume && bindingSnapshot.threadId) {
      await this.reply(
        event,
        "这个飞书话题已经绑定会话。请直接发送普通文字继续；要开启新会话，请新建一个飞书话题。",
        "topic-task-bound",
      );
      return true;
    }
    if (command.resume && !session?.threadId) {
      await this.reply(event, `仓库 ${repository} 没有可续接会话，请先使用 /task。`, "no-session");
      return true;
    }
    const now = new Date().toISOString();
    const job = {
      id: shortJobId(),
      status: "queued",
      repository,
      repositoryPath,
      prompt: command.prompt,
      resumeThreadId: session?.threadId ?? null,
      replaceBindingGeneration: command.resume
        ? null
        : bindingSnapshot?.bindingGeneration ?? null,
      bindingSnapshotThreadId: bindingSnapshot.threadId,
      bindingSnapshotGeneration: bindingSnapshot.bindingGeneration,
      senderId: event.sender_id,
      chatId: event.chat_id,
      contextId: this.contextId(event),
      sourceMessageId: event.message_id,
      sourceEventId: event.event_id,
      approvalMode: this.currentApprovalMode(event),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.putJob({ ...job, prompt: undefined });
    if (!this.acceptingEvents) {
      await this.store.updateJob(job.id, {
        status: "canceled",
        finishedAt: new Date().toISOString(),
        error: "Bridge shut down before the task entered the queue",
      });
      return false;
    }
    const position = this.queue.status().pending.length + 1;
    const controlCardMessageId = await this.taskControlCards.create(job, {
      queuePosition: position,
    });
    if (controlCardMessageId) {
      job.controlCardMessageId = controlCardMessageId;
      await this.store.updateJob(job.id, { controlCardMessageId });
    }
    this.queue.add(job);
    if (!controlCardMessageId) await this.reply(
      event,
      `已接收任务 ${jobLabel(job)}${position > 0 ? `，队列位置 ${position}` : "，即将执行"}。\n审批模式：${job.approvalMode}（${approvalModeLabel(job.approvalMode)}）`,
      `accepted-${job.id}`,
    );
    return true;
  }

  async cancelJob(event, requestedJobId) {
    const status = this.queue.status();
    const candidates = [
      ...status.running,
      ...status.pending,
      ...[...this.threadConflicts.values()].map((conflict) => conflict.job),
    ].filter(
      (job) => this.jobBelongsToEvent(job, event),
    );
    const jobId = requestedJobId ?? candidates[0]?.id;
    if (!jobId) {
      await this.reply(event, "当前没有可取消的任务。", "cancel-empty");
      return;
    }
    const job = this.store.getJob(jobId);
    if (!job || !this.jobBelongsToEvent(job, event)) {
      await this.reply(event, `找不到可取消的任务 #${jobId}。`, "cancel-missing");
      return;
    }
    const cancellation = await this.requestJobCancellation(job);
    if (!cancellation) {
      await this.reply(event, `任务 #${jobId} 已结束，无法取消。`, "cancel-ended");
      return;
    }
    if (cancellation.type === "thread_conflict") {
      await this.reply(event, `已取消等待中的任务 #${jobId}。`, `cancel-${jobId}`);
      return;
    }
    if (cancellation.type === "running") {
      await this.reply(
        event,
        cancellation.stopped ? `正在取消任务 #${jobId}。` : `任务 #${jobId} 已不在运行。`,
        `cancel-${jobId}`,
      );
    } else {
      await this.reply(event, `已取消排队任务 #${jobId}。`, `cancel-${jobId}`);
    }
  }

  async requestJobCancellation(job) {
    const conflict = this.threadConflicts.get(job.id);
    if (conflict && new Set(["choice", "wait"]).has(conflict.phase)) {
      return this.cancelThreadConflict(conflict);
    }
    const cancellation = this.queue.cancel(job.id);
    if (!cancellation) return null;
    if (cancellation.type === "running") {
      await this.store.updateJob(job.id, { status: "canceling" });
      this.approvalBroker?.declineForJob(job.id, "cancel_requested");
      const stopped = await this.codex.cancel(job.id);
      return { ...cancellation, stopped };
    }
    return cancellation;
  }

  async onQueuedJobCanceled(job) {
    this.approvalBroker?.declineForJob(job.id, "canceled_while_queued");
    this.approvalBroker?.takeJobStats?.(job.id);
    await this.store.updateJob(job.id, {
      status: "canceled",
      finishedAt: new Date().toISOString(),
    });
    await this.taskControlCards.setStatus(job.id, "canceled", {
      progress: "排队任务已取消。",
    });
  }

  async executeJob(job) {
    await this.store.updateJob(job.id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    await this.taskControlCards.setStatus(job.id, "running", {
      progress: "Codex 已启动，正在处理任务。",
    });
    const scope = {
      senderId: job.senderId,
      chatId: job.chatId,
      contextId: normalizeContextId(job.contextId),
      repository: job.repository,
    };
    let lease = null;
    let renewal = null;
    let releaseLease = true;
    try {
      if (job.resumeThreadId) {
        lease = await this.sessions.acquireLease(scope, {
          owner: `job:${job.id}`,
          expectedThreadId: job.resumeThreadId,
          expectedBindingGeneration: job.bindingSnapshotGeneration,
        });
        renewal = setInterval(() => {
          this.sessions.renewLease(scope, lease.token).catch((error) => {
            this.logger.error?.(`Lease renewal failed for ${job.id}: ${compactError(error)}`);
          });
        }, 60_000);
        renewal.unref?.();
      }
      if (!this.acceptingEvents) {
        const error = new Error("Bridge shut down before the task started Codex");
        error.code = "BRIDGE_SHUTDOWN";
        throw error;
      }
      const recoverableTurnIds = job.resumeThreadId
        ? this.store.listJobs()
          .filter((candidate) => (
            candidate.repository === job.repository
            && candidate.threadId === job.resumeThreadId
            && (candidate.id === job.id || ["failed", "interrupted"].includes(candidate.status))
            && typeof candidate.turnId === "string"
            && candidate.turnId.length > 0
          ))
          .map((candidate) => candidate.turnId)
        : [];
      return await this.codex.run(job, {
        prompt: job.prompt,
        repositoryPath: job.repositoryPath,
        resumeThreadId: job.resumeThreadId,
        recoverableTurnIds,
      });
    } catch (error) {
      if (error.code === "TURN_INTERRUPT_UNCONFIRMED") {
        releaseLease = false;
        if (lease) {
          await this.sessions.renewLease(scope, lease.token, { ttlMs: 15 * 60_000 }).catch(() => {});
        }
      }
      throw error;
    } finally {
      if (renewal) clearInterval(renewal);
      if (lease && releaseLease) await this.sessions.releaseLease(scope, lease.token).catch(() => {});
    }
  }

  async onJobCompleted(job, result) {
    this.clearProgressState(job.id);
    this.approvalBroker?.declineForJob(job.id, result.timedOut ? "timeout" : "job_ended");
    const approvalStats = this.approvalBroker?.takeJobStats?.(job.id) ?? null;
    const storedJob = this.store.getJob(job.id);
    const canceled = storedJob?.status === "canceling";
    if (result.threadId) {
      const scope = {
        senderId: job.senderId,
        chatId: job.chatId,
        contextId: normalizeContextId(job.contextId),
        repository: job.repository,
      };
      const current = this.sessions.getBinding(scope);
      const currentSnapshot = this.sessions.getSnapshot(scope);
      const snapshotMatches =
        currentSnapshot.threadId === (job.bindingSnapshotThreadId ?? null)
        && currentSnapshot.bindingGeneration === (job.bindingSnapshotGeneration ?? 0);
      if (!job.resumeThreadId && !snapshotMatches) {
        result.bindingWarning = "任务已完成，但会话绑定在运行期间发生变化；结果 thread 未自动覆盖当前绑定。";
      } else {
        const options = {
          expectedBindingGeneration: job.bindingSnapshotGeneration ?? 0,
          ...(current && current.threadId !== result.threadId ? { replace: true } : {}),
        };
        try {
          await this.sessions.bind(scope, {
            threadId: result.threadId,
            title: current?.threadId === result.threadId ? current.title : null,
            source: current?.threadId === result.threadId ? current.source : "feishu",
            lastSyncedTurnId: result.turnId ?? null,
          }, options);
        } catch (error) {
          if (!["generation_mismatch", "binding_conflict", "lease_conflict"].includes(error.code)) throw error;
          result.bindingWarning = "任务已完成，但会话绑定在运行期间发生变化；结果 thread 未自动覆盖当前绑定。";
        }
      }
    }
    if (canceled) {
      await this.store.updateJob(job.id, {
        status: "canceled",
        threadId: result.threadId,
        finishedAt: new Date().toISOString(),
      });
      await this.taskControlCards.setStatus(job.id, "canceled", {
        progress: "任务已取消。",
        stats: approvalStats,
      });
      await this.replyToJob(
        job,
        `任务 ${jobLabel(job)} 已取消。${approvalStatsText(approvalStats)}`,
        "canceled",
      );
      return;
    }

    const succeeded = !result.timedOut
      && result.code === 0
      && result.completed
      && result.lastMessage;
    await this.store.updateJob(job.id, {
      status: succeeded ? "completed" : "failed",
      threadId: result.threadId,
      finishedAt: new Date().toISOString(),
      exitCode: result.code,
      turnId: result.turnId ?? null,
      error: succeeded ? null : this.resultError(result),
    });
    await this.taskControlCards.setStatus(job.id, succeeded ? "completed" : "failed", {
      progress: succeeded ? "任务已完成，详细结果见后续消息。" : "任务执行失败，详细原因见后续消息。",
      note: result.bindingWarning ?? null,
      stats: approvalStats,
    });
    if (succeeded) {
      const warning = result.bindingWarning ? `\n\n⚠ ${result.bindingWarning}` : "";
      const reply = this.truncateReply(
        `任务 ${jobLabel(job)} 完成。\n\n${result.lastMessage}${warning}${approvalStatsText(approvalStats)}`,
      );
      await this.replyToJob(job, reply, "completed");
    } else {
      await this.replyToJob(
        job,
        `任务 ${jobLabel(job)} 失败。\n${this.resultError(result)}${approvalStatsText(approvalStats)}`,
        "failed",
      );
    }
  }

  resultError(result) {
    if (result.timedOut) return `超过 ${this.config.codex.maxRuntimeMinutes} 分钟运行限制。`;
    const errors = result.errors.filter(Boolean);
    return this.truncateReply(errors.at(-1) || `Codex 退出码：${result.code ?? "未知"}`);
  }

  async onJobFailed(job, error) {
    this.clearProgressState(job.id);
    if (error?.code === "THREAD_BUSY" && await this.deferThreadBusyJob(job, error)) {
      this.approvalBroker?.declineForJob(job.id, "thread_busy");
      return;
    }
    this.approvalBroker?.declineForJob(job.id, "job_failed");
    const approvalStats = this.approvalBroker?.takeJobStats?.(job.id) ?? null;
    if (error.code === "BRIDGE_SHUTDOWN") {
      await this.store.updateJob(job.id, {
        status: "canceled",
        finishedAt: new Date().toISOString(),
        error: error.message,
      });
      await this.taskControlCards.setStatus(job.id, "canceled", {
        progress: "桥接服务停止前未能启动任务。",
        stats: approvalStats,
      });
      return;
    }
    await this.store.updateJob(job.id, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: compactError(error),
    });
    await this.taskControlCards.setStatus(job.id, "failed", {
      progress: "任务启动失败，详细原因见后续消息。",
      note: compactError(error),
      stats: approvalStats,
    });
    await this.replyToJob(
      job,
      `任务 ${jobLabel(job)} 启动失败。\n${compactError(error)}${approvalStatsText(approvalStats)}`,
      "start-failed",
    );
  }

  onProgress(progress) {
    if (!progress.job?.id || !new Set(["text", "tool"]).has(progress.type)) return;
    const now = Date.now();
    const state = this.progressState.get(progress.job.id) ?? {
      lastSentAt: 0,
      summaries: [],
      narrative: "",
      timer: null,
      sequence: 0,
      job: progress.job,
    };
    state.job = progress.job;
    if (progress.type === "text" && typeof progress.delta === "string") {
      state.narrative += progress.delta;
      const maxBuffered = this.config.limits.maxReplyChars * 2;
      if (state.narrative.length > maxBuffered) {
        state.narrative = state.narrative.slice(-maxBuffered);
      }
    }
    if (progress.type === "tool" && progress.summary
      && !state.summaries.includes(progress.summary)) {
      state.summaries.push(progress.summary);
    }
    if (state.timer) clearTimeout(state.timer);
    this.progressState.set(progress.job.id, state);
    const throttleDelay = Math.max(0, this.progressIntervalMs - (now - state.lastSentAt));
    const delay = progress.type === "tool" && state.lastSentAt === 0
      ? 0
      : Math.max(this.progressDebounceMs, throttleDelay);
    state.timer = setTimeout(() => this.flushProgress(progress.job.id), delay);
    state.timer.unref?.();
  }

  flushProgress(jobId) {
    const state = this.progressState.get(jobId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const narrative = state.narrative.trim();
    const summary = state.summaries.slice(-4).join("；");
    if (!narrative && !summary) return;
    state.narrative = "";
    state.summaries = [];
    state.lastSentAt = Date.now();
    state.sequence += 1;
    const details = [narrative, summary ? `正在执行：${summary}` : ""].filter(Boolean).join("\n");
    this.safeHook(async () => {
      const updated = await this.taskControlCards.setProgress(jobId, details);
      if (!updated) await sendTextToTarget(
        this.lark,
        this.target(state.job),
        this.truncateReply(`任务 #${jobId} 进度：\n${details}`),
        `progress:${jobId}:${state.sequence}`,
      );
    });
  }

  clearProgressState(jobId) {
    const state = this.progressState.get(jobId);
    if (state?.timer) clearTimeout(state.timer);
    this.progressState.delete(jobId);
  }

  truncateReply(text) {
    const safeText = redactSensitiveText(text);
    if (safeText.length <= this.config.limits.maxReplyChars) return safeText;
    const omitted = safeText.length - this.config.limits.maxReplyChars;
    return `${safeText.slice(0, this.config.limits.maxReplyChars)}\n\n…已截断 ${omitted} 个字符。`;
  }

  async reply(event, text, suffix) {
    try {
      const topic = this.isTopicEvent(event);
      await this.lark.replyText(
        topic ? this.contextId(event) : event.message_id,
        this.truncateReply(text),
        `${event.event_id || event.message_id}:${suffix}`.slice(0, 128),
        topic ? { replyInThread: true } : undefined,
      );
    } catch (error) {
      this.logger.error?.(`Failed to reply: ${compactError(error)}`);
    }
  }

  async replyToJob(job, text, suffix) {
    try {
      const contextId = normalizeContextId(job.contextId);
      const topic = contextId !== MAIN_CONTEXT_ID;
      await this.lark.replyText(
        topic ? contextId : job.sourceMessageId,
        this.truncateReply(text),
        `${job.sourceEventId || job.sourceMessageId}:${job.id}:${suffix}`.slice(0, 128),
        topic ? { replyInThread: true } : undefined,
      );
    } catch (error) {
      this.logger.error?.(`Failed to send job result: ${compactError(error)}`);
    }
  }
}
