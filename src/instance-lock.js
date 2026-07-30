import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import process from "node:process";

const CONTROL_MESSAGE_LIMIT = 1_024;
const CONTROL_REQUEST_TIMEOUT_MS = 3_000;
const CONTROL_HANDLER_TIMEOUT_MS = 2_000;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function mutexAddress(dataDirectory) {
  const identity = path.resolve(dataDirectory).toLowerCase();
  const digest = createHash("sha256").update(identity).digest();
  const name = `feishu-codex-bridge-${digest.toString("hex").slice(0, 32)}`;
  if (process.platform === "win32") return { path: `\\\\.\\pipe\\${name}`, exclusive: true };
  if (process.platform === "linux") return { path: `\0${name}`, exclusive: true };
  return {
    host: "127.0.0.1",
    port: 49_152 + digest.readUInt16BE(0) % 16_384,
    exclusive: true,
  };
}

function connectionAddress(dataDirectory) {
  const { exclusive: _exclusive, ...address } = mutexAddress(dataDirectory);
  return address;
}

async function readLockOwner(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return {};
  }
}

function validOwner(owner) {
  return Number.isSafeInteger(owner?.pid) && owner.pid > 0
    && typeof owner.token === "string" && TOKEN_PATTERN.test(owner.token);
}

function controlRequest(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const keys = Object.keys(message).sort();
  if (keys.length !== 2 || keys[0] !== "action" || keys[1] !== "token") return null;
  if (message.action !== "shutdown" || typeof message.token !== "string") return null;
  return { action: "shutdown", token: message.token };
}

function withTimeout(operation, timeoutMs, message) {
  let timeout;
  return Promise.race([
    Promise.resolve(operation),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      timeout.unref?.();
    }),
  ]).finally(() => clearTimeout(timeout));
}

function readJsonLine(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    const parse = (line) => {
      try {
        finish(null, JSON.parse(line));
      } catch {
        finish(new Error("Invalid bridge control response"));
      }
    };
    const onData = (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > CONTROL_MESSAGE_LIMIT) {
        finish(new Error("Bridge control message is too large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (buffer.slice(newline + 1).trim()) {
        finish(new Error("Bridge control protocol accepts one message"));
        return;
      }
      parse(buffer.slice(0, newline));
    };
    const onEnd = () => finish(new Error("Bridge control connection closed before a response"));
    const onError = (error) => finish(error);
    const timeout = setTimeout(
      () => finish(new Error("Bridge control request timed out")),
      timeoutMs,
    );
    timeout.unref?.();
    socket.setEncoding("utf8");
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

function sendJsonAndClose(socket, message) {
  if (socket.destroyed || !socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(`${JSON.stringify(message)}\n`, () => socket.destroy());
}

export async function requestBridgeShutdown(
  dataDirectory,
  { timeoutMs = CONTROL_REQUEST_TIMEOUT_MS } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("Bridge control timeout must be a positive integer");
  }
  const filePath = path.join(path.resolve(dataDirectory), "bridge.lock");
  const owner = await readLockOwner(filePath);
  if (!validOwner(owner)) {
    throw new Error("Bridge is not running or its lock metadata is invalid");
  }

  const socket = createConnection(connectionAddress(dataDirectory));
  try {
    const responsePromise = readJsonLine(socket, timeoutMs);
    // The connection attempt and response reader observe the same socket error.
    // Attach a handler immediately so a connect failure cannot leave the response
    // promise rejected but unobserved while the connect wait is unwinding.
    void responsePromise.catch(() => {});
    await withTimeout(
      new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      }),
      timeoutMs,
      "Bridge control connection timed out",
    );
    socket.write(`${JSON.stringify({ action: "shutdown", token: owner.token })}\n`);
    const response = await responsePromise;
    if (!response || response.ok !== true || Object.keys(response).length !== 1) {
      throw new Error("Bridge shutdown request was rejected");
    }
    return { pid: owner.pid };
  } finally {
    socket.destroy();
  }
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export class InstanceLock {
  constructor(dataDirectory, {
    pid = process.pid,
    isProcessAlive = processExists,
    malformedGraceMs = 10_000,
    clock = () => Date.now(),
  } = {}) {
    this.filePath = path.join(dataDirectory, "bridge.lock");
    this.mutexAddress = mutexAddress(dataDirectory);
    this.pid = pid;
    this.isProcessAlive = isProcessAlive;
    this.malformedGraceMs = malformedGraceMs;
    this.clock = clock;
    this.token = randomUUID();
    this.handle = null;
    this.mutexServer = null;
    this.controlHandler = null;
    this.controlSockets = new Set();
  }

  async acquire() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.acquireMutex();
    try {
      try {
        this.handle = await open(this.filePath, "wx", 0o600);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = await this.readOwner();
        if (owner?.pid && this.isProcessAlive(owner.pid)) {
          throw new Error(`Another bridge instance is already running (pid=${owner.pid})`);
        }
        if (!owner?.pid && await this.isRecentLock()) {
          throw new Error("Another bridge instance is acquiring the instance lock");
        }
        await unlink(this.filePath).catch((unlinkError) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
        this.handle = await open(this.filePath, "wx", 0o600).catch((openError) => {
          if (openError.code === "EEXIST") {
            throw new Error("Instance lock changed during stale-lock recovery");
          }
          throw openError;
        });
      }
      await this.handle.writeFile(`${JSON.stringify({
        pid: this.pid,
        token: this.token,
        startedAt: new Date(this.clock()).toISOString(),
      })}\n`);
      return this;
    } catch (error) {
      const handle = this.handle;
      this.handle = null;
      await handle?.close().catch(() => {});
      await this.releaseMutex().catch(() => {});
      throw error;
    }
  }

  async acquireMutex() {
    const server = createServer((socket) => {
      this.controlSockets.add(socket);
      socket.once("close", () => this.controlSockets.delete(socket));
      void this.handleControlSocket(socket);
    });
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          server.off("error", onError);
          server.off("listening", onListening);
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onListening = () => {
          cleanup();
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.mutexAddress);
      });
    } catch (error) {
      await closeServer(server).catch(() => {});
      if (error.code === "EADDRINUSE") {
        const owner = await this.readOwner();
        const detail = owner?.pid ? ` (pid=${owner.pid})` : "";
        throw new Error(`Another bridge instance is already running${detail}`);
      }
      throw error;
    }
    server.unref();
    this.mutexServer = server;
  }

  registerControlHandler(handler) {
    if (!this.handle || !this.mutexServer) {
      throw new Error("Bridge control handler requires an acquired instance lock");
    }
    if (typeof handler !== "function") {
      throw new TypeError("Bridge control handler must be a function");
    }
    if (this.controlHandler) {
      throw new Error("Bridge control handler is already registered");
    }
    this.controlHandler = handler;
    return () => {
      if (this.controlHandler === handler) this.controlHandler = null;
    };
  }

  async handleControlSocket(socket) {
    try {
      const message = controlRequest(await readJsonLine(socket, CONTROL_REQUEST_TIMEOUT_MS));
      const owner = await this.readOwner();
      if (!message || !this.controlHandler
        || message.token !== this.token
        || owner?.pid !== this.pid || owner?.token !== this.token) {
        throw new Error("Bridge control request denied");
      }
      const accepted = await withTimeout(
        Promise.resolve().then(() => this.controlHandler({ action: "shutdown" })),
        CONTROL_HANDLER_TIMEOUT_MS,
        "Bridge control handler timed out",
      );
      if (accepted !== true) throw new Error("Bridge control handler rejected the request");
      sendJsonAndClose(socket, { ok: true });
    } catch {
      sendJsonAndClose(socket, { ok: false });
    }
  }

  async releaseMutex() {
    const server = this.mutexServer;
    this.mutexServer = null;
    this.controlHandler = null;
    for (const socket of this.controlSockets) socket.destroy();
    this.controlSockets.clear();
    await closeServer(server);
  }

  async isRecentLock() {
    try {
      const metadata = await stat(this.filePath);
      return this.clock() - metadata.mtimeMs < this.malformedGraceMs;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async readOwner() {
    return readLockOwner(this.filePath);
  }

  async release() {
    if (!this.handle && !this.mutexServer) return false;
    const handle = this.handle;
    this.handle = null;
    try {
      await handle?.close().catch(() => {});
      const owner = await this.readOwner();
      if (owner?.pid === this.pid && owner.token === this.token) {
        await unlink(this.filePath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    } finally {
      await this.releaseMutex();
    }
    return true;
  }
}
