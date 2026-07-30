import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAIN_CONTEXT_ID = "main";
export const DEFAULT_APPROVAL_MODE = "balanced";
export const APPROVAL_MODES = Object.freeze(["strict", "balanced", "auto"]);

const APPROVAL_MODE_SET = new Set(APPROVAL_MODES);

function contextIdOrMain(contextId) {
  return typeof contextId === "string" && contextId.trim() !== ""
    ? contextId
    : MAIN_CONTEXT_ID;
}

function initialState() {
  return {
    version: 1,
    processedMessages: [],
    preferences: {},
    sessions: {},
    jobs: {},
  };
}

export class StateStore {
  constructor(dataDirectory, processedMessageLimit, storedJobLimit = 500) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "state.json");
    this.processedMessageLimit = processedMessageLimit;
    this.storedJobLimit = storedJobLimit;
    this.state = initialState();
    this.writeChain = Promise.resolve();
  }

  async load() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed.version !== 1) {
        throw new Error(`unsupported state version: ${parsed.version}`);
      }
      this.state = { ...initialState(), ...parsed };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await this.save();
    }
    return this.state;
  }

  hasProcessed(messageKey) {
    return this.state.processedMessages.includes(messageKey);
  }

  async markProcessed(messageKey) {
    this.state.processedMessages = this.state.processedMessages.filter((key) => key !== messageKey);
    this.state.processedMessages.push(messageKey);
    if (this.state.processedMessages.length > this.processedMessageLimit) {
      this.state.processedMessages.splice(
        0,
        this.state.processedMessages.length - this.processedMessageLimit,
      );
    }
    await this.save();
  }

  conversationKey(senderId, chatId, contextId = MAIN_CONTEXT_ID) {
    const base = `${senderId}:${chatId}`;
    const normalizedContextId = contextIdOrMain(contextId);
    return normalizedContextId === MAIN_CONTEXT_ID
      ? base
      : `${base}:ctx=${encodeURIComponent(normalizedContextId)}`;
  }

  sessionKey(senderId, chatId, repository, contextId = MAIN_CONTEXT_ID) {
    return `${this.conversationKey(senderId, chatId, contextId)}:${repository}`;
  }

  getRepository(senderId, chatId, fallback, contextId = MAIN_CONTEXT_ID) {
    return this.state.preferences[this.conversationKey(senderId, chatId, contextId)]?.repository
      ?? fallback;
  }

  async setRepository(senderId, chatId, repository, contextId = MAIN_CONTEXT_ID) {
    const key = this.conversationKey(senderId, chatId, contextId);
    this.state.preferences[key] = {
      ...this.state.preferences[key],
      repository,
    };
    await this.save();
  }

  getApprovalMode(senderId, chatId, contextId = MAIN_CONTEXT_ID) {
    const mode = this.state.preferences[this.conversationKey(senderId, chatId, contextId)]
      ?.approvalMode;
    return APPROVAL_MODE_SET.has(mode) ? mode : DEFAULT_APPROVAL_MODE;
  }

  async setApprovalMode(senderId, chatId, mode, contextId = MAIN_CONTEXT_ID) {
    if (!APPROVAL_MODE_SET.has(mode)) {
      throw new TypeError(`invalid approval mode: ${mode}`);
    }
    const key = this.conversationKey(senderId, chatId, contextId);
    this.state.preferences[key] = {
      ...this.state.preferences[key],
      approvalMode: mode,
    };
    await this.save();
  }

  getSession(senderId, chatId, repository, contextId = MAIN_CONTEXT_ID) {
    return this.state.sessions[this.sessionKey(senderId, chatId, repository, contextId)] ?? null;
  }

  async setSession(senderId, chatId, repository, threadId, contextId = MAIN_CONTEXT_ID) {
    const normalizedContextId = contextIdOrMain(contextId);
    this.state.sessions[this.sessionKey(senderId, chatId, repository, normalizedContextId)] = {
      threadId,
      updatedAt: new Date().toISOString(),
      senderId,
      chatId,
      contextId: normalizedContextId,
      repository,
    };
    await this.save();
  }

  async clearSession(senderId, chatId, repository, contextId = MAIN_CONTEXT_ID) {
    delete this.state.sessions[this.sessionKey(senderId, chatId, repository, contextId)];
    await this.save();
  }

  getJob(jobId) {
    return this.state.jobs[jobId] ?? null;
  }

  listJobs() {
    return Object.values(this.state.jobs);
  }

  async putJob(job) {
    this.state.jobs[job.id] = job;
    this.pruneJobs();
    await this.save();
  }

  pruneJobs() {
    const jobs = Object.values(this.state.jobs);
    if (jobs.length <= this.storedJobLimit) return;
    const terminal = jobs
      .filter((job) => ![
        "queued",
        "running",
        "waiting_conflict",
        "waiting_thread",
        "forking",
        "canceling",
      ].includes(job.status))
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    while (Object.keys(this.state.jobs).length > this.storedJobLimit && terminal.length > 0) {
      delete this.state.jobs[terminal.shift().id];
    }
  }

  async updateJob(jobId, patch) {
    const job = this.getJob(jobId);
    if (!job) {
      return null;
    }
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await this.save();
    return job;
  }

  async save() {
    const snapshot = JSON.stringify(this.state, null, 2) + "\n";
    this.writeChain = this.writeChain.then(async () => {
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    return this.writeChain;
  }

  flush() {
    return this.writeChain;
  }
}
