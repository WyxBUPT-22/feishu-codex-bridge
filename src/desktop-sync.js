import { EventEmitter } from "node:events";
import { MAIN_CONTEXT_ID, normalizeContextId, sendTextToTarget } from "./delivery-target.js";

function textFromInput(content = []) {
  return content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function turnSummary(turn) {
  const user = turn.items.find((item) => item.type === "userMessage");
  const assistant = [...turn.items]
    .reverse()
    .find((item) => item.type === "agentMessage" && item.phase !== "commentary");
  return {
    turnId: turn.id,
    userText: textFromInput(user?.content).trim(),
    assistantText: assistant?.text?.trim() ?? "",
    completedAt: turn.completedAt,
  };
}

export class DesktopSync extends EventEmitter {
  constructor({ client, sessions, lark, config, store, intervalMs = 15_000, logger = console }) {
    super();
    this.client = client;
    this.sessions = sessions;
    this.lark = lark;
    this.config = config;
    this.store = store;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.seen = new Map();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll().catch((error) => {
      this.logger.error?.(`Desktop sync failed: ${error.message}`);
    }), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.running) return;
    this.running = true;
    try {
      for (const binding of this.sessions.listBindings()) {
        try {
          await this.pollBinding(binding);
        } catch (error) {
          this.logger.error?.(
            `Desktop sync failed for ${binding.repository ?? "unknown"}/${binding.threadId ?? "unknown"}: ${error.message}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  async pollBinding(binding) {
        if (!this.isBindingAllowed(binding)) return;
        const page = await this.client.listTurns(binding.threadId, {
          limit: 50,
          sortDirection: "desc",
        });
        const completed = page.data
          .filter((turn) => turn.status === "completed" && turn.completedAt)
          .reverse();
        if (completed.length === 0) return;
        const latest = completed.at(-1);
        const contextId = normalizeContextId(binding.contextId);
        const key = `${binding.senderId}:${binding.chatId}:${contextId}:${binding.repository}:${binding.threadId}`;
        const previous = this.seen.get(key) ?? binding.lastSyncedTurnId ?? null;
        if (!previous) {
          if (await this.persistCursor(binding, latest.id)) this.seen.set(key, latest.id);
          return;
        }
        if (latest.id === previous) return;
        const cursorIndex = completed.findIndex((turn) => turn.id === previous);
        if (cursorIndex < 0) {
          if (!this.isCurrentBinding(binding)) return;
          await sendTextToTarget(
            this.lark,
            binding,
            `[电脑端同步 · ${binding.repository}] 同步游标已超出最近 ${completed.length} 轮；为避免错误回放，已从最新一轮重新建立基线。`,
            `desktop-sync-gap:${contextId}:${binding.threadId}:${latest.id}`,
          );
          if (await this.persistCursor(binding, latest.id)) this.seen.set(key, latest.id);
          this.emit("gap", { binding, previous, latest: latest.id });
          return;
        }
        const knownMobileTurns = new Set(this.store.listJobs().map((candidate) => candidate.turnId).filter(Boolean));
        for (const turn of completed.slice(cursorIndex + 1)) {
          if (!this.isCurrentBinding(binding)) return;
          if (knownMobileTurns.has(turn.id)) {
            if (await this.persistCursor(binding, turn.id)) this.seen.set(key, turn.id);
            continue;
          }
          const summary = turnSummary(turn);
          const user = summary.userText ? `电脑端：${summary.userText.slice(0, 500)}` : "电脑端完成了一轮新对话。";
          const assistant = summary.assistantText
            ? `\n\nCodex：${summary.assistantText.slice(0, 1500)}`
            : "";
          await sendTextToTarget(
            this.lark,
            binding,
            `[电脑端同步 · ${binding.repository} · ${binding.threadId.slice(0, 8)}]\n${user}${assistant}`,
            `desktop-sync:${contextId}:${binding.threadId}:${turn.id}`,
          );
          if (await this.persistCursor(binding, turn.id)) this.seen.set(key, turn.id);
          this.emit("synced", { binding, turn });
        }
  }

  isBindingAllowed(binding) {
    if (!binding?.threadId || !this.config.repositories[binding.repository]) return false;
    if (!this.config.lark.allowedSenders.includes(binding.senderId)) return false;
    if (this.config.lark.allowedChats.length > 0
      && !this.config.lark.allowedChats.includes(binding.chatId)) return false;
    const contextId = normalizeContextId(binding.contextId);
    if (contextId !== MAIN_CONTEXT_ID
      && !this.config.lark.workbenchChats?.includes(binding.chatId)) return false;
    if (contextId !== MAIN_CONTEXT_ID && this.config.lark.p2pOnly) return false;
    return true;
  }

  isCurrentBinding(binding) {
    if (!this.isBindingAllowed(binding)) return false;
    const key = this.store.sessionKey(
      binding.senderId,
      binding.chatId,
      binding.repository,
      normalizeContextId(binding.contextId),
    );
    const current = this.store.state.sessions[key];
    if (!current || current.threadId !== binding.threadId) return false;
    return !Number.isSafeInteger(binding.bindingGeneration)
      || current.bindingGeneration === binding.bindingGeneration;
  }

  async persistCursor(binding, turnId) {
    const key = this.store.sessionKey(
      binding.senderId,
      binding.chatId,
      binding.repository,
      normalizeContextId(binding.contextId),
    );
    const current = this.store.state.sessions[key];
    if (!current || current.threadId !== binding.threadId) return false;
    if (
      Number.isSafeInteger(binding.bindingGeneration)
      && current.bindingGeneration !== binding.bindingGeneration
    ) return false;
    current.lastSyncedTurnId = turnId;
    current.lastSyncedAt = new Date().toISOString();
    await this.store.save();
    return true;
  }
}
