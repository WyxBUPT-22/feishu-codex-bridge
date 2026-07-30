import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const HOOK_IPC_MAX_BYTES = 256 * 1024;
export const HOOK_APPROVAL_TIMEOUT_MS = 10 * 60_000;
export const HOOK_IPC_TIMEOUT_MS = HOOK_APPROVAL_TIMEOUT_MS + 10_000;
export const HOOK_CLIENT_TIMEOUT_MS = HOOK_IPC_TIMEOUT_MS + 10_000;
export const HOOK_COMMAND_TIMEOUT_SECONDS = Math.ceil((HOOK_CLIENT_TIMEOUT_MS + 10_000) / 1_000);

const ALLOWED_TOOL_NAMES = new Set([
  "Bash",
  "bash",
  "apply_patch",
  "exec_command",
  "shell",
  "shell_command",
  "unified_exec",
]);

export function isApprovalCapableTool(toolName) {
  return typeof toolName === "string" && ALLOWED_TOOL_NAMES.has(toolName);
}

function randomEndpoint() {
  const id = `${process.pid}-${randomBytes(16).toString("hex")}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\feishu-codex-hook-${id}`;
  }
  if (process.platform === "linux") {
    // A printable form is needed because this value is passed to the hook in argv.
    return `@feishu-codex-hook-${id}`;
  }
  return path.join(os.tmpdir(), `feishu-codex-hook-${id}.sock`);
}

export function hookEndpointPath(endpoint) {
  if (process.platform === "linux" && endpoint.startsWith("@")) {
    return `\0${endpoint.slice(1)}`;
  }
  return endpoint;
}

function reasonText(value, fallback) {
  const reason = typeof value === "string" ? value.trim() : "";
  return (reason || fallback).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2_000);
}

function isRequest(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function logError(logger, message) {
  try {
    logger.error?.(message);
  } catch {
    // Logging must never change an approval decision.
  }
}

function handlerOptions(handlerOrOptions, options) {
  if (typeof handlerOrOptions === "function") {
    return { ...options, handler: handlerOrOptions };
  }
  if (handlerOrOptions && typeof handlerOrOptions === "object") {
    return { ...handlerOrOptions, ...options };
  }
  return { ...options, handler: handlerOrOptions };
}

export class HookApprovalServer {
  constructor(handlerOrOptions, options = {}) {
    const resolved = handlerOptions(handlerOrOptions, options);
    if (typeof resolved.handler !== "function") {
      throw new TypeError("HookApprovalServer requires an async approval handler");
    }
    this.handler = resolved.handler;
    this.maxMessageBytes = resolved.maxMessageBytes ?? HOOK_IPC_MAX_BYTES;
    this.timeoutMs = resolved.timeoutMs ?? HOOK_IPC_TIMEOUT_MS;
    this.logger = resolved.logger ?? console;
    if (!Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes < 128) {
      throw new RangeError("maxMessageBytes must be an integer of at least 128");
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
    this.endpoint = null;
    this.server = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.sockets = new Set();
  }

  async start() {
    if (this.server?.listening) return this.endpoint;
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) await this.stopPromise;

    this.endpoint = randomEndpoint();
    const server = net.createServer({ allowHalfOpen: true }, (socket) => this.handleSocket(socket));
    this.server = server;
    this.startPromise = new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        server.on("error", (error) => {
          logError(this.logger, `Hook approval server error: ${error.message}`);
        });
        resolve(this.endpoint);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(hookEndpointPath(this.endpoint));
    });

    try {
      return await this.startPromise;
    } catch (error) {
      if (this.server === server) this.server = null;
      this.endpoint = null;
      throw error;
    } finally {
      this.startPromise = null;
    }
  }

  handleSocket(socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));

    let buffer = Buffer.alloc(0);
    let processing = false;
    let settled = false;
    const timer = setTimeout(() => finish(false, "approval request timed out"), this.timeoutMs);
    timer.unref?.();

    const finish = (approved, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const response = approved
        ? { approved: true }
        : { approved: false, reason: reasonText(reason, "approval denied") };
      try {
        socket.end(`${JSON.stringify(response)}\n`);
      } catch {
        socket.destroy();
      }
    };

    socket.on("error", () => {
      settled = true;
      clearTimeout(timer);
    });
    socket.on("end", () => {
      if (!processing && !settled) finish(false, "incomplete approval request");
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      if (processing) {
        finish(false, "multiple approval requests are not allowed");
        return;
      }
      if (buffer.length + chunk.length > this.maxMessageBytes) {
        finish(false, "approval request exceeds size limit");
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) {
        finish(false, "multiple approval requests are not allowed");
        return;
      }
      processing = true;
      let request;
      try {
        request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        finish(false, "invalid approval request JSON");
        return;
      }
      if (!isRequest(request)) {
        finish(false, "invalid approval request");
        return;
      }
      if (!isApprovalCapableTool(request.tool_name)) {
        finish(false, "tool is not eligible for approval");
        return;
      }
      Promise.resolve()
        .then(() => this.handler(request))
        .then((decision) => {
          if (decision === true || decision?.approved === true) {
            finish(true);
          } else {
            finish(false, decision?.reason);
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          logError(this.logger, `Hook approval handler failed: ${message}`);
          finish(false, "approval handler failed");
        });
    });
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopNow();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async stopNow() {
    if (this.startPromise) await this.startPromise.catch(() => {});
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    if (this.endpoint && process.platform !== "win32" && !this.endpoint.startsWith("@")) {
      await unlink(this.endpoint).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
