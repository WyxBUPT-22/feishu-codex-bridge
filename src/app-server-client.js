import { EventEmitter, once } from "node:events";
import { createInterface } from "node:readline";
import { spawnCommand, terminateProcessTree } from "./process-utils.js";
import { codexEnvironment } from "./codex-runner.js";

const DEFAULT_TIMEOUT_MS = 30_000;

function protocolError(message) {
  const error = new Error(message?.error?.message ?? "Codex app-server request failed");
  error.code = message?.error?.code;
  error.data = message?.error?.data;
  return error;
}

function defaultApprovalResponse(method, messageParams = {}) {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn", strictAutoReview: true };
    case "item/tool/requestUserInput":
      return {
        answers: Object.fromEntries(
          (messageParams.questions ?? []).map((question) => [question.id, { answers: [] }]),
        ),
      };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/call":
      return { contentItems: [], success: false };
    case "currentTime/read":
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: "denied" };
    default:
      return null;
  }
}

export class CodexAppServerClient extends EventEmitter {
  constructor(tool, {
    cwd = process.cwd(),
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    approvalHandler = null,
    extraArgs = [],
    environmentOverrides = {},
  } = {}) {
    super();
    this.tool = tool;
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.initialized = false;
    this.stopping = false;
    this.approvalHandler = approvalHandler;
    this.extraArgs = [...extraArgs];
    this.environmentOverrides = { ...environmentOverrides };
  }

  async start() {
    if (this.child) return;
    this.stopping = false;
    const child = spawnCommand(this.tool, [...this.extraArgs, "app-server", "--stdio"], {
      cwd: this.cwd,
      env: { ...codexEnvironment(), ...this.environmentOverrides, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", (error) => this.emit("warning", `app-server stdin: ${error.message}`));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) this.emit("diagnostic", line);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("close", (code, signal) => {
      this.child = null;
      this.initialized = false;
      this.failAll(new Error(`Codex app-server exited (code=${code}, signal=${signal})`));
      this.emit("close", { code, signal, expected: this.stopping });
    });
    await this.request("initialize", {
      clientInfo: { name: "feishu-codex", title: "Feishu Codex", version: "0.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
    this.initialized = true;
    this.emit("ready");
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    child.stdin.end();
    await Promise.race([
      once(child, "close"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (this.child === child) await terminateProcessTree(child);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("warning", `Invalid app-server JSON: ${error.message}`);
      return;
    }
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(protocolError(message));
      else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method) {
      this.emit("notification", message);
      if (message.method === "error") {
        this.emit("app-server-error", message.params);
      } else {
        this.emit(message.method, message.params);
      }
    }
  }

  handleServerRequest(message) {
    const fallback = defaultApprovalResponse(message.method, message.params);
    if (fallback && this.approvalHandler) {
      Promise.resolve()
        .then(() => this.approvalHandler({ method: message.method, params: message.params }))
        .then((result) => this.respondApproval(message, result ?? fallback))
        .catch((error) => {
          this.emit("warning", `Approval handler failed: ${error.message}`);
          this.respondApproval(message, fallback);
        });
      return;
    }
    if (fallback) return this.respondApproval(message, fallback);
    this.write({
      id: message.id,
      error: { code: -32601, message: `Unsupported server request: ${message.method}` },
    });
    this.emit("warning", `Unsupported app-server request: ${message.method}`);
  }

  respondApproval(message, result) {
    this.write({ id: message.id, result });
    if (message.method === "item/permissions/requestApproval") {
      const { threadId, turnId } = message.params ?? {};
      if (threadId && turnId) {
        queueMicrotask(() => {
          this.interruptTurn(threadId, turnId).catch((error) => {
            this.emit("warning", `Failed to interrupt permission request turn: ${error.message}`);
          });
        });
      }
    }
    const accepted = result.decision === "accept" || result.decision === "approved";
    const approvalMethod = message.method.includes("Approval");
    if (!approvalMethod) {
      this.emit("server-request-resolved", { method: message.method, params: message.params, result });
      return;
    }
    this.emit(accepted ? "approval-accepted" : "approval-declined", {
      method: message.method,
      params: message.params,
    });
  }

  write(message) {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout, method });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  listThreads(params = {}) {
    return this.request("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      modelProviders: [],
      sourceKinds: [],
      archived: false,
      ...params,
    });
  }

  readThread(threadId, includeTurns = false) {
    return this.request("thread/read", { threadId, includeTurns });
  }

  listTurns(threadId, params = {}, timeoutMs = this.requestTimeoutMs) {
    return this.request("thread/turns/list", {
      threadId,
      limit: 20,
      sortDirection: "desc",
      itemsView: "full",
      ...params,
    }, timeoutMs);
  }

  resumeThread(params) {
    return this.request("thread/resume", params);
  }

  startThread(params) {
    return this.request("thread/start", params);
  }

  forkThread(params) {
    return this.request("thread/fork", params);
  }

  startTurn(params) {
    return this.request("turn/start", params);
  }

  interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }
}
