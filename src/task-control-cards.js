import {
  canSendCardToTarget,
  sendCardToTarget,
} from "./delivery-target.js";
import { redactSensitiveText } from "./text-safety.js";

const ACTIVE_STATUSES = new Set([
  "queued",
  "running",
  "waiting_approval",
  "waiting_conflict",
  "waiting_thread",
  "forking",
  "canceling",
]);
const CONFLICT_STATUSES = new Set(["waiting_conflict", "waiting_thread", "forking"]);
const STATUS_LABELS = Object.freeze({
  queued: "排队中",
  running: "正在执行",
  waiting_approval: "等待审批",
  waiting_conflict: "会话占用",
  waiting_thread: "等待会话",
  forking: "正在 Fork",
  canceling: "正在停止",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
  interrupted: "已中断",
});
const STATUS_TEMPLATES = Object.freeze({
  queued: "blue",
  running: "blue",
  waiting_approval: "orange",
  waiting_conflict: "orange",
  waiting_thread: "orange",
  forking: "orange",
  canceling: "orange",
  completed: "green",
  failed: "red",
  canceled: "grey",
  interrupted: "grey",
});

function plain(content) {
  return { tag: "plain_text", content: String(content) };
}

function field(content) {
  return { is_short: true, text: plain(content) };
}

function safeLine(value, limit = 800) {
  return redactSensitiveText(String(value ?? "").replace(/\s+/g, " ").trim()).slice(0, limit);
}

function stopAction(jobId) {
  return {
    v: 1,
    kind: "codex_task_control",
    action: "stop",
    jobId,
  };
}

function conflictAction(jobId, token, action) {
  return {
    v: 1,
    kind: "codex_thread_conflict",
    action,
    jobId,
    token,
  };
}

function approvalAction(actionId, decision) {
  return {
    v: 1,
    kind: "codex_approval",
    decision,
    actionId,
  };
}

function approvalStatusLabel(status) {
  if (status === "approved") return "已通过";
  if (status === "denied") return "已拒绝";
  if (status === "expired") return "已超时";
  return "已失效";
}

export function parseTaskControlAction(rawValue) {
  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys === "action,jobId,kind,v") {
    if (value.v !== 1 || value.kind !== "codex_task_control" || value.action !== "stop") {
      return null;
    }
    if (!/^[a-f0-9]{10}$/.test(value.jobId)) return null;
    return { action: "stop", jobId: value.jobId };
  }
  if (keys !== "action,jobId,kind,token,v") return null;
  if (value.v !== 1 || value.kind !== "codex_thread_conflict") return null;
  if (!new Set(["wait", "fork", "cancel"]).has(value.action)) return null;
  if (!/^[a-f0-9]{10}$/.test(value.jobId) || !/^[a-f0-9]{32}$/.test(value.token)) {
    return null;
  }
  return { action: value.action, jobId: value.jobId, token: value.token };
}

export function taskControlCard(state) {
  const approvals = [...state.approvals.values()];
  const pending = approvals.filter((approval) => approval.status === "pending");
  const recentSettled = approvals.filter((approval) => approval.status !== "pending").slice(-3);
  const effectiveStatus = pending.length > 0 && ACTIVE_STATUSES.has(state.status)
    ? "waiting_approval"
    : state.status;
  const elements = [{
    tag: "div",
    fields: [
      field(`仓库：${state.job.repository}`),
      field(`审批：${state.job.approvalMode ?? "balanced"}`),
    ],
  }];

  if (state.progress) {
    elements.push({ tag: "div", text: plain(safeLine(state.progress, 1_200)) });
  }

  for (const approval of pending) {
    elements.push(
      { tag: "hr" },
      { tag: "div", text: plain(`待审批：${safeLine(approval.summary)}`) },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: plain("通过"),
            value: approvalAction(approval.actionId, "approve"),
          },
          {
            tag: "button",
            type: "danger",
            text: plain("拒绝"),
            value: approvalAction(approval.actionId, "deny"),
          },
        ],
      },
      {
        tag: "note",
        elements: [plain(`按钮不可用时发送 /approve ${approval.confirmation} 或 /deny ${approval.confirmation}`)],
      },
    );
  }

  for (const approval of recentSettled) {
    elements.push({
      tag: "note",
      elements: [plain(`${approvalStatusLabel(approval.status)}：${safeLine(approval.summary, 240)}`)],
    });
  }

  if (state.status === "waiting_conflict" && state.conflict) {
    elements.push(
      { tag: "hr" },
      {
        tag: "div",
        text: plain("该 Codex 会话正在被电脑端或其他客户端使用。请选择处理方式："),
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: plain("等待后继续"),
            value: conflictAction(state.job.id, state.conflict.token, "wait"),
          },
          {
            tag: "button",
            text: plain("安全 Fork"),
            value: conflictAction(state.job.id, state.conflict.token, "fork"),
          },
          {
            tag: "button",
            type: "danger",
            text: plain("取消任务"),
            value: conflictAction(state.job.id, state.conflict.token, "cancel"),
          },
        ],
      },
      {
        tag: "note",
        elements: [plain("等待和 Fork 都不会中断电脑端正在运行的回合。")],
      },
    );
  }

  const stats = state.stats ?? { automatic: 0, manual: 0 };
  elements.push({
    tag: "note",
    elements: [plain(`审批：自动 ${stats.automatic ?? 0} 次，人工 ${stats.manual ?? 0} 次。`)],
  });

  if (ACTIVE_STATUSES.has(state.status)
    && state.status !== "waiting_conflict"
    && state.status !== "forking") {
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        type: "danger",
        text: plain("停止任务"),
        value: stopAction(state.job.id),
      }],
    });
  }

  if (state.note) {
    elements.push({ tag: "note", elements: [plain(safeLine(state.note, 500))] });
  }

  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: {
      template: STATUS_TEMPLATES[effectiveStatus] ?? "blue",
      title: plain(`Codex 任务 #${state.job.id} · ${STATUS_LABELS[effectiveStatus] ?? effectiveStatus}`),
    },
    elements,
  };
}

export class TaskControlCards {
  constructor({ lark, logger = console }) {
    this.lark = lark;
    this.logger = logger;
    this.states = new Map();
  }

  async create(job, { queuePosition = 0 } = {}) {
    if (!canSendCardToTarget(this.lark, job)
      || typeof this.lark?.updateMessageCard !== "function") return null;
    const state = {
      job,
      messageId: null,
      status: "queued",
      progress: queuePosition > 1 ? `队列位置：${queuePosition}` : "任务已接收，准备启动。",
      note: null,
      stats: { automatic: 0, manual: 0 },
      approvals: new Map(),
      conflict: null,
      chain: Promise.resolve(),
    };
    try {
      const delivered = await sendCardToTarget(
        this.lark,
        job,
        taskControlCard(state),
        `task-control:${job.id}`,
      );
      if (typeof delivered?.messageId !== "string") {
        throw new Error("Task control card message id is missing");
      }
      state.messageId = delivered.messageId;
      this.states.set(job.id, state);
      return delivered.messageId;
    } catch (error) {
      this.logger.error?.(`Failed to create task control card: ${error.message}`);
      return null;
    }
  }

  restore(job) {
    if (typeof job?.controlCardMessageId !== "string") return null;
    const state = {
      job,
      messageId: job.controlCardMessageId,
      status: job.status ?? "interrupted",
      progress: "桥接服务已重启，原任务不再运行。",
      note: null,
      stats: { automatic: 0, manual: 0 },
      approvals: new Map(),
      conflict: null,
      chain: Promise.resolve(),
    };
    this.states.set(job.id, state);
    return state;
  }

  has(jobId) {
    return this.states.has(jobId);
  }

  messageId(jobId) {
    return this.states.get(jobId)?.messageId ?? null;
  }

  async mutate(jobId, mutation) {
    const state = this.states.get(jobId);
    if (!state) return false;
    const update = state.chain
      .catch(() => {})
      .then(() => {
        mutation(state);
        return this.lark.updateMessageCard(state.messageId, taskControlCard(state));
      });
    state.chain = update.catch((error) => {
      this.logger.error?.(`Failed to update task control card #${jobId}: ${error.message}`);
    });
    await update;
    return true;
  }

  async setStatus(jobId, status, { progress = undefined, note = undefined, stats = undefined } = {}) {
    try {
      return await this.mutate(jobId, (state) => {
        state.status = status;
        if (progress !== undefined) state.progress = progress;
        if (note !== undefined) state.note = note;
        if (stats !== undefined) state.stats = { ...stats };
        if (!CONFLICT_STATUSES.has(status)) state.conflict = null;
        if (!ACTIVE_STATUSES.has(status)) {
          for (const approval of state.approvals.values()) {
            if (approval.status === "pending") approval.status = "denied";
          }
        }
      });
    } catch {
      return false;
    }
  }

  async setProgress(jobId, progress) {
    try {
      return await this.mutate(jobId, (state) => {
        state.status = "running";
        state.progress = safeLine(progress, 1_200);
      });
    } catch {
      return false;
    }
  }

  async setStats(jobId, stats) {
    try {
      return await this.mutate(jobId, (state) => { state.stats = { ...stats }; });
    } catch {
      return false;
    }
  }

  async showThreadConflict(jobId, { token, progress, note = null }) {
    try {
      return await this.mutate(jobId, (state) => {
        state.status = "waiting_conflict";
        state.progress = safeLine(progress, 1_200);
        state.note = note == null ? null : safeLine(note, 500);
        state.conflict = { token };
      });
    } catch {
      return false;
    }
  }

  async setThreadConflictPhase(jobId, token, status, { progress, note = undefined } = {}) {
    if (!CONFLICT_STATUSES.has(status)) return false;
    try {
      return await this.mutate(jobId, (state) => {
        if (state.conflict?.token !== token) {
          throw new Error("Thread conflict token is stale");
        }
        state.status = status;
        if (progress !== undefined) state.progress = safeLine(progress, 1_200);
        if (note !== undefined) state.note = note == null ? null : safeLine(note, 500);
      });
    } catch {
      return false;
    }
  }

  async addApproval({ job, actionId, summary, confirmation, expiresAt }) {
    const state = this.states.get(job.id);
    if (!state) return null;
    try {
      await this.mutate(job.id, (current) => {
        current.approvals.set(actionId, {
          actionId,
          summary,
          confirmation,
          expiresAt,
          status: "pending",
        });
      });
      return { messageId: state.messageId, presentation: "control" };
    } catch (error) {
      state.approvals.delete(actionId);
      this.logger.error?.(`Failed to add approval to task control card: ${error.message}`);
      return null;
    }
  }

  async settleApproval(jobId, actionId, approved, reason = null) {
    try {
      return await this.mutate(jobId, (state) => {
        const approval = state.approvals.get(actionId);
        const status = approved
          ? "approved"
          : reason === "timeout"
            ? "expired"
            : new Set(["denied", "card_denied"]).has(reason)
              ? "denied"
              : "invalidated";
        if (approval) approval.status = status;
        if (![...state.approvals.values()].some((item) => item.status === "pending")) {
          state.status = "running";
          state.progress = approved
            ? "审批已通过，任务继续执行。"
            : status === "denied"
              ? "审批已拒绝，本次操作不会执行。"
              : status === "expired"
                ? "审批已超时，本次操作不会执行。"
                : "审批已失效，本次操作不会执行。";
        }
      });
    } catch {
      return false;
    }
  }

  validateStop({ jobId, senderId, chatId, messageId }) {
    const state = this.states.get(jobId);
    if (!state || state.messageId !== messageId
      || state.job.senderId !== senderId || state.job.chatId !== chatId
      || !ACTIVE_STATUSES.has(state.status)) return null;
    return state.job;
  }

  validateThreadConflict({ jobId, token, senderId, chatId, messageId }) {
    const state = this.states.get(jobId);
    if (!state || state.messageId !== messageId
      || state.job.senderId !== senderId || state.job.chatId !== chatId
      || state.status !== "waiting_conflict"
      || state.conflict?.token !== token) return null;
    return state.job;
  }
}
