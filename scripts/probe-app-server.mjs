import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveTool } from "../src/tool-resolver.js";

const tool = await resolveTool("codex");
const child = spawn(tool.command, [...tool.prefixArgs, "app-server", "--stdio"], {
  cwd: process.cwd(),
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.pipe(process.stderr);
const pending = new Map();
let nextId = 1;
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ method, id, params });
  });
}

await request("initialize", {
  clientInfo: { name: "feishu-codex-probe", title: "Feishu Codex Probe", version: "0.1.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});
send({ method: "initialized" });
const result = await request("thread/list", {
  limit: 100,
  sortKey: "updated_at",
  sortDirection: "desc",
  sourceKinds: [],
  archived: false,
});
console.log(JSON.stringify(result.data.map((thread) => ({
  id: thread.id,
  cwd: thread.cwd,
  preview: thread.preview,
  name: thread.name,
  source: thread.source,
  status: thread.status,
  modelProvider: thread.modelProvider,
  updatedAt: thread.updatedAt,
})), null, 2));
child.stdin.end();
