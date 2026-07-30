import path from "node:path";
import { MAIN_CONTEXT_ID } from "./state-store.js";

const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const UUID_PREFIX = /^[a-f0-9-]{8,36}$/i;

export class SessionCatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SessionCatalogError";
    this.code = code;
    this.details = details;
  }
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sourceLabel(source) {
  if (typeof source === "string") return source;
  if (source?.custom) return source.custom;
  if (source?.subAgent) return "subAgent";
  return "unknown";
}

function statusLabel(status) {
  if (!status?.type) return "unknown";
  if (status.type === "active") {
    return status.activeFlags?.length ? `active:${status.activeFlags.join(",")}` : "active";
  }
  return status.type;
}

export class SessionCatalog {
  constructor(client, config, { clock = () => Date.now(), cacheTtlMs = DEFAULT_CACHE_TTL_MS } = {}) {
    this.client = client;
    this.config = config;
    this.clock = clock;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
  }

  cacheKey(scope) {
    return JSON.stringify([
      scope.senderId,
      scope.chatId,
      scope.contextId || MAIN_CONTEXT_ID,
      scope.repository,
    ]);
  }

  repository(scope) {
    const repository = this.config.repositories[scope.repository];
    if (!repository) throw new SessionCatalogError("repository_not_allowed", "Repository is not allowed");
    return repository;
  }

  async list(scope, { limit = 10, searchTerm = null } = {}) {
    const repository = this.repository(scope);
    const response = await this.client.listThreads({
      cwd: repository.path,
      limit,
      searchTerm,
      useStateDbOnly: false,
    });
    const threads = response.data
      .filter((thread) => normalizedPath(thread.cwd) === normalizedPath(repository.path))
      .slice(0, limit);
    this.cache.set(this.cacheKey(scope), { expiresAt: this.clock() + this.cacheTtlMs, threads });
    return threads;
  }

  async resolve(scope, selector) {
    const value = String(selector ?? "").trim();
    if (!value) throw new SessionCatalogError("selector_required", "Session selector is required");
    let threads;
    if (/^[1-9]\d*$/.test(value)) {
      const cached = this.cache.get(this.cacheKey(scope));
      if (!cached || cached.expiresAt <= this.clock()) {
        throw new SessionCatalogError("selection_expired", "Session list expired; run /sessions again");
      }
      const thread = cached.threads[Number(value) - 1];
      if (!thread) throw new SessionCatalogError("selection_missing", "Session number does not exist");
      return this.validate(scope, thread);
    }
    if (!UUID_PREFIX.test(value)) {
      throw new SessionCatalogError("selector_invalid", "Use a session number or thread-id prefix");
    }
    threads = await this.list(scope, { limit: 100 });
    const matches = threads.filter((thread) => thread.id.toLowerCase().startsWith(value.toLowerCase()));
    if (matches.length === 0) throw new SessionCatalogError("selection_missing", "Session was not found in this repository");
    if (matches.length > 1) throw new SessionCatalogError("selection_ambiguous", "Thread-id prefix is ambiguous");
    return this.validate(scope, matches[0]);
  }

  validate(scope, thread) {
    const repository = this.repository(scope);
    if (normalizedPath(thread.cwd) !== normalizedPath(repository.path)) {
      throw new SessionCatalogError("repository_mismatch", "Session belongs to another repository");
    }
    const expectedProvider = this.config.codex.provider?.id;
    if (expectedProvider && thread.modelProvider !== expectedProvider) {
      throw new SessionCatalogError(
        "provider_mismatch",
        `Session provider ${thread.modelProvider} does not match ${expectedProvider}`,
      );
    }
    return thread;
  }

  format(threads, boundThreadId = null) {
    if (threads.length === 0) return "当前仓库没有可用 Codex 会话。";
    const lines = threads.map((thread, index) => {
      const title = String(thread.name || thread.preview || "未命名会话").replace(/\s+/g, " ").slice(0, 80);
      const updated = new Date(thread.updatedAt * 1000).toLocaleString("zh-CN", { hour12: false });
      const bound = thread.id === boundThreadId ? "●" : "○";
      return `${bound} ${index + 1}. ${title}\n   ${thread.id.slice(0, 8)} · ${sourceLabel(thread.source)} · ${statusLabel(thread.status)} · ${updated}`;
    });
    return `最近会话：\n${lines.join("\n")}\n\n使用 /attach <编号> 绑定，或 /fork <编号> 创建分支。`;
  }
}
