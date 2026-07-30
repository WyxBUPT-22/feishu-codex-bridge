import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SUPPORTED_LARK_CLI_VERSION } from "../src/lark-version.js";

const DISABLED_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "remote_plugin",
  "request_permissions_tool",
  "tool_suggest",
  "workspace_dependencies",
];

function isolatedConfig(hook) {
  return {
    mcp_servers: {},
    plugins: {},
    marketplaces: {},
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    },
    notify: [],
    allow_login_shell: false,
    hooks: {
      PreToolUse: [{
        matcher: hook.matcher,
        hooks: [{
          type: "command",
          command: hook.command,
          commandWindows: hook.commandWindows,
          timeout: hook.timeout,
          async: false,
          statusMessage: null,
        }],
      }],
      PermissionRequest: [],
      PostToolUse: [],
      PreCompact: [],
      PostCompact: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
      Stop: [],
    },
    tools: { web_search: null },
    web_search: "disabled",
    include_apps_instructions: false,
    skills: { include_instructions: false },
    orchestrator: { skills: { enabled: false }, mcp: { enabled: false } },
    features: {
      ...Object.fromEntries(DISABLED_FEATURES.map((name) => [name, false])),
      hooks: true,
    },
  };
}

function fakeCodexSource() {
  return `
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.144.1");
  process.exit(0);
}
const DISABLED_FEATURES = ${JSON.stringify(DISABLED_FEATURES)};
const hookArg = process.argv.find((arg) => arg.startsWith("hooks.PreToolUse="));
const trusted = process.argv.some((arg) => arg.startsWith("hooks.state="));
const hookValue = hookArg?.slice("hooks.PreToolUse=".length) ?? "";
const jsonField = (name) => {
  const marker = name + "=";
  const markerAt = hookValue.indexOf(marker);
  if (markerAt < 0) return null;
  const start = markerAt + marker.length;
  if (hookValue[start] !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < hookValue.length; index += 1) {
    const character = hookValue[index];
    if (character === '"' && !escaped) return JSON.parse(hookValue.slice(start, index + 1));
    if (character === "\\\\" && !escaped) escaped = true;
    else escaped = false;
  }
  return null;
};
const hook = {
  matcher: jsonField("matcher"),
  command: jsonField("command"),
  commandWindows: jsonField("command_windows"),
  timeout: Number(hookValue.slice(hookValue.indexOf("timeout=") + 8).split(/[^0-9]/, 1)[0] ?? 0),
};
const config = ${isolatedConfig.toString()}(hook);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
  } else if (message.method === "config/read") {
    send({ id: message.id, result: { config } });
  } else if (message.method === "hooks/list") {
    send({ id: message.id, result: { data: [{
      cwd: message.params.cwds[0], warnings: [], errors: [], hooks: [{
        key: "session-hook", eventName: "preToolUse", handlerType: "command",
        matcher: hook.matcher, command: hook.commandWindows ?? hook.command,
        timeoutSec: hook.timeout, enabled: true, isManaged: false,
        currentHash: "sha256:${"b".repeat(64)}", trustStatus: trusted ? "trusted" : "untrusted", source: "sessionFlags",
      }],
    }] } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
  }
});
lines.on("close", () => process.exit(0));
`;
}

function capture(child) {
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.on("data", (chunk) => { output.stderr += chunk; });
  return output;
}

async function waitFor(child, output, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(`${output.stdout}\n${output.stderr}`)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`process exited before ${pattern}: ${output.stderr}`);
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${pattern}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode];
  }
  let timeout;
  try {
    return await Promise.race([
      once(child, "close"),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("process did not exit")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("main stop requests the running bridge unified graceful shutdown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-stop-"));
  const repository = path.join(root, "repository");
  const dataDirectory = path.join(root, "data");
  const codexHome = path.join(root, "codex-home");
  const localAppData = path.join(root, "local-app-data");
  const codexEntry = path.join(root, "fake-codex.js");
  const larkEntry = path.join(root, "fake-lark.js");
  const configPath = path.join(root, "bridge.config.json");
  const credentialCanary = "SENSITIVE_CONFIG_CANARY";
  await Promise.all([
    mkdir(repository, { recursive: true }),
    mkdir(dataDirectory, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
  ]);
  await writeFile(codexEntry, fakeCodexSource());
  await writeFile(larkEntry, `
if (process.argv.includes("--version")) {
  console.log("lark-cli version ${SUPPORTED_LARK_CLI_VERSION}");
  process.exit(0);
}
const consumeAt = process.argv.indexOf("consume");
const eventKey = consumeAt >= 0 ? process.argv[consumeAt + 1] : "unknown";
process.stderr.write("[event] ready event_key=" + eventKey + "\\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`);
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    credentialCanary,
    dataDirectory,
    larkCliEntry: larkEntry,
    lark: {
      profile: "test",
      allowedSenders: ["ou_allowed"],
      allowedChats: [],
      p2pOnly: true,
    },
    repositories: { repo: { path: repository } },
    defaultRepository: "repo",
    codex: {
      entry: codexEntry,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      appServer: { enabled: true },
    },
    queue: { concurrency: 1 },
  }, null, 2)}\n`);

  const mainPath = path.resolve("src/main.js");
  const environment = { ...process.env, CODEX_HOME: codexHome, LOCALAPPDATA: localAppData };
  const bridge = spawn(process.execPath, [mainPath, "start", "--config", configPath], {
    cwd: path.resolve("."),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const bridgeOutput = capture(bridge);

  try {
    await waitFor(bridge, bridgeOutput, /Feishu event stream is ready/, 8_000);
    await waitFor(bridge, bridgeOutput, /Feishu approval card stream is ready/, 8_000);
    const stopper = spawn(process.execPath, [mainPath, "stop", "--config", configPath], {
      cwd: path.resolve("."),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stopOutput = capture(stopper);
    const [stopCode, stopSignal] = await waitForClose(stopper, 4_000);
    assert.equal(stopCode, 0, stopOutput.stderr);
    assert.equal(stopSignal, null);
    assert.match(stopOutput.stdout, new RegExp(`Shutdown requested for bridge pid ${bridge.pid}`));
    assert.doesNotMatch(`${stopOutput.stdout}\n${stopOutput.stderr}`, new RegExp(credentialCanary));

    const [bridgeCode, bridgeSignal] = await waitForClose(bridge, 8_000);
    assert.equal(bridgeCode, 0, bridgeOutput.stderr);
    assert.equal(bridgeSignal, null);
    assert.match(bridgeOutput.stdout, /Shutting down on local-control/);
    assert.doesNotMatch(`${bridgeOutput.stdout}\n${bridgeOutput.stderr}`, new RegExp(credentialCanary));
    await assert.rejects(
      access(path.join(dataDirectory, "bridge.lock")),
      (error) => error.code === "ENOENT",
    );
  } finally {
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill();
    await rm(root, { recursive: true, force: true });
  }
});
