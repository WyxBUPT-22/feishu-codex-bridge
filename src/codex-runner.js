import { EventEmitter } from "node:events";
import { readLines, spawnCommand, terminateProcessTree } from "./process-utils.js";

const CODEX_ENVIRONMENT_KEYS = new Set([
  "ALLUSERSPROFILE",
  "APPDATA",
  "CODEX_HOME",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

export function codexEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => CODEX_ENVIRONMENT_KEYS.has(key.toUpperCase())),
  );
}

export function captureStdinErrors(stream, errors) {
  stream.on("error", (error) => {
    errors.push(`Codex stdin error: ${error.message}`);
  });
}

function finalTextFromItem(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "agent_message" && typeof item.text === "string") return item.text;
  if (item.type === "message" && item.role === "assistant") {
    if (typeof item.text === "string") return item.text;
    if (Array.isArray(item.content)) {
      return item.content
        .map((part) => part.text ?? part.output_text ?? "")
        .filter(Boolean)
        .join("\n");
    }
  }
  return null;
}

export function parseCodexEvent(line, state) {
  const event = JSON.parse(line);
  if (event.type === "thread.started" && event.thread_id) {
    state.threadId = event.thread_id;
  }
  if (event.type === "item.completed") {
    const text = finalTextFromItem(event.item);
    if (text) state.lastMessage = text;
    if (event.item?.type === "error" && event.item.message) state.errors.push(event.item.message);
  }
  if (event.type === "error" && event.message) state.errors.push(event.message);
  if (event.type === "turn.failed" && event.error?.message) state.errors.push(event.error.message);
  if (event.type === "turn.completed") state.completed = true;
  return event;
}

export class CodexRunner extends EventEmitter {
  constructor(tool, config) {
    super();
    this.tool = tool;
    this.config = config;
    this.active = new Map();
  }

  buildArgs({ repositoryPath, resumeThreadId }) {
    const global = [
      "--ask-for-approval",
      this.config.codex.approvalPolicy,
      "--cd",
      repositoryPath,
      "--sandbox",
      this.config.codex.sandbox,
    ];
    const provider = this.config.codex.provider;
    if (provider) {
      const prefix = `model_providers.${provider.id}`;
      global.push(
        "--config", `model_provider=${JSON.stringify(provider.id)}`,
        "--config", `${prefix}.name=${JSON.stringify(provider.name)}`,
        "--config", `${prefix}.base_url=${JSON.stringify(provider.baseUrl)}`,
        "--config", `${prefix}.wire_api=${JSON.stringify(provider.wireApi)}`,
        "--config", `${prefix}.requires_openai_auth=true`,
      );
    }
    if (this.config.codex.model) global.push("--model", this.config.codex.model);
    const common = [
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
    ];
    if (resumeThreadId) {
      return [...global, "exec", "resume", ...common, resumeThreadId, "-"];
    }
    return [
      ...global,
      "exec",
      ...common,
      "-",
    ];
  }

  async run(job, options) {
    const state = { threadId: options.resumeThreadId ?? null, lastMessage: "", errors: [], completed: false };
    const child = spawnCommand(this.tool, this.buildArgs(options), {
      cwd: options.repositoryPath,
      env: { ...codexEnvironment(), NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.active.set(job.id, { child, termination: null });
    captureStdinErrors(child.stdin, state.errors);
    child.stdin.end(options.prompt);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const stderr = [];

    readLines(child.stdout, (line) => {
      if (!line.trim()) return;
      try {
        const event = parseCodexEvent(line, state);
        this.emit("event", { job, event, state: { ...state } });
      } catch (error) {
        state.errors.push(`Invalid Codex JSONL: ${error.message}`);
      }
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void this.cancel(job.id);
    }, this.config.codex.maxRuntimeMinutes * 60_000);
    timeout.unref?.();

    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      clearTimeout(timeout);
      this.active.delete(job.id);
    });

    const stderrText = stderr.join("").trim();
    if (stderrText) state.errors.push(stderrText);
    return { ...result, ...state, timedOut };
  }

  async cancel(jobId) {
    const active = this.active.get(jobId);
    if (!active) return false;
    active.termination ??= terminateProcessTree(active.child);
    await active.termination;
    return true;
  }

  activeJobIds() {
    return [...this.active.keys()];
  }
}
