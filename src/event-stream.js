import { EventEmitter } from "node:events";
import { once } from "node:events";
import { readLines, spawnCommand, terminateProcessTree } from "./process-utils.js";
import { machineEnvironment } from "./lark-client.js";

export class EventStream extends EventEmitter {
  constructor(tool, config, eventKey = "im.message.receive_v1") {
    super();
    this.tool = tool;
    this.profile = config.lark.profile;
    this.eventKey = eventKey;
    this.readyMarker = `[event] ready event_key=${eventKey}`;
    this.child = null;
    this.stopping = false;
    this.ready = false;
  }

  args() {
    const globalArgs = this.profile ? ["--profile", this.profile] : [];
    return [
      ...globalArgs,
      "event",
      "consume",
      this.eventKey,
      "--as",
      "bot",
    ];
  }

  start() {
    if (this.child) {
      throw new Error("event stream is already running");
    }
    this.stopping = false;
    this.ready = false;
    const child = spawnCommand(this.tool, this.args(), {
      cwd: process.cwd(),
      env: machineEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    readLines(child.stdout, (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event?.type !== this.eventKey) {
          this.emit("warning", `Ignoring unexpected ${event?.type ?? "unknown"} event on ${this.eventKey}`);
          return;
        }
        this.emit("event", event);
      } catch (error) {
        this.emit("warning", `Ignoring invalid event JSON: ${error.message}`);
      }
    });
    readLines(child.stderr, (line) => {
      if (line.trim() === this.readyMarker && !this.ready && !this.stopping) {
        this.ready = true;
        this.emit("ready", { eventKey: this.eventKey });
      }
      if (line.trim()) {
        this.emit("diagnostic", line);
      }
    });
    child.once("error", (error) => this.emit("error", error));
    child.once("close", (code, signal) => {
      this.child = null;
      const expected = this.stopping && (code === 0 || signal !== null);
      this.emit("close", { code, signal, expected, eventKey: this.eventKey });
    });
    return child;
  }

  async stop({ timeoutMs = 5_000 } = {}) {
    const child = this.child;
    if (!child) return false;
    this.stopping = true;
    child.stdin.end();
    let timeout;
    try {
      await Promise.race([
        once(child, "close"),
        new Promise((resolve) => { timeout = setTimeout(resolve, timeoutMs); }),
      ]);
    } catch {
      // The process tree fallback below handles child errors during shutdown.
    } finally {
      clearTimeout(timeout);
    }
    if (this.child === child) await terminateProcessTree(child);
    return true;
  }
}
