import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(sourceRoot, "scripts", "install-windows.ps1");
const launcherTemplate = path.join(sourceRoot, "scripts", "start-bridge-windows.ps1");
const packageManifest = JSON.parse(
  await readFile(path.join(sourceRoot, "package.json"), "utf8"),
);
const powershell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function runInstaller(args) {
  return spawnSync(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer, ...args],
    {
      cwd: sourceRoot,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    },
  );
}

function runLauncher(launcher, args = [], { env = process.env } = {}) {
  return spawnSync(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, ...args],
    {
      cwd: os.tmpdir(),
      encoding: "utf8",
      env,
      timeout: 30_000,
      windowsHide: true,
    },
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-install-"));
  const repository = path.join(root, "repository");
  const dataDirectory = path.join(root, "state");
  const tools = path.join(root, "fake-tools");
  const codexEntry = path.join(tools, "codex.js");
  const larkCliEntry = path.join(tools, "lark.js");
  await mkdir(repository);
  await mkdir(tools);
  await writeFile(codexEntry, "");
  await writeFile(larkCliEntry, "");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, repository, dataDirectory, codexEntry, larkCliEntry };
}

test("Windows installer plan pins an isolated toolchain without writing files", {
  skip: process.platform !== "win32",
}, async (t) => {
  const { repository, dataDirectory } = await fixture(t);
  const result = runInstaller([
    "-PlanOnly",
    "-AllowedSender", "ou_example_user",
    "-RepositoryAlias", "example",
    "-RepositoryPath", repository,
    "-DataDirectory", dataDirectory,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(`Codex CLI: ${packageManifest.bridgeToolchain.codex.replaceAll(".", "\\.")} \\(isolated\\)`),
  );
  assert.match(
    result.stdout,
    new RegExp(`Lark CLI:\\s+${packageManifest.bridgeToolchain.larkCli.replaceAll(".", "\\.")} \\(isolated\\)`),
  );
  assert.match(result.stdout, /PLAN write canonical configuration/);
  await assert.rejects(access(dataDirectory), { code: "ENOENT" });
});

test("Windows installer writes an isolated canonical configuration and refuses overwrite", {
  skip: process.platform !== "win32",
}, async (t) => {
  const {
    repository, dataDirectory, codexEntry, larkCliEntry,
  } = await fixture(t);
  const args = [
    "-SkipToolInstall",
    "-SkipDoctor",
    "-AllowedSender", "ou_example_user",
    "-AllowedChat", "oc_workspace",
    "-WorkbenchChat", "oc_workspace",
    "-RepositoryAlias", "example",
    "-RepositoryPath", repository,
    "-DataDirectory", dataDirectory,
    "-CodexEntry", codexEntry,
    "-LarkCliEntry", larkCliEntry,
  ];
  const first = runInstaller(args);
  assert.equal(first.status, 0, first.stderr);

  const configPath = path.join(dataDirectory, "config", "bridge.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config.lark.allowedSenders, ["ou_example_user"]);
  assert.deepEqual(config.lark.allowedChats, ["oc_workspace"]);
  assert.deepEqual(config.lark.workbenchChats, ["oc_workspace"]);
  assert.equal(config.lark.p2pOnly, false);
  assert.equal(config.repositories.example.path, repository);
  assert.equal(config.codex.entry, codexEntry);
  assert.equal(config.larkCliEntry, larkCliEntry);
  assert.equal(config.dataDirectory, dataDirectory);
  const installedLauncher = path.join(
    dataDirectory,
    "launcher",
    "start-bridge-windows.ps1",
  );
  const launcherSource = await readFile(installedLauncher, "utf8");
  assert.doesNotMatch(launcherSource, /npm\.cmd|run deploy|ConfigPath|sourceRoot/);
  assert.match(first.stdout, /Fixed active-runtime launcher installed/);

  const second = runInstaller(args);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Configuration already exists/);

  const forced = runInstaller([...args, "-ForceConfig"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.deepEqual(
    JSON.parse(await readFile(configPath, "utf8")),
    config,
  );
});

test("Windows installer rejects a data directory junction into a repository", {
  skip: process.platform !== "win32",
}, async (t) => {
  const {
    root, repository, codexEntry, larkCliEntry,
  } = await fixture(t);
  const repositoryState = path.join(repository, "state");
  const linkedState = path.join(root, "linked-state");
  await mkdir(repositoryState);
  try {
    await symlink(repositoryState, linkedState, "junction");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip(`junction creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const result = runInstaller([
    "-SkipToolInstall",
    "-SkipDoctor",
    "-AllowedSender", "ou_example_user",
    "-RepositoryAlias", "example",
    "-RepositoryPath", repository,
    "-DataDirectory", linkedState,
    "-CodexEntry", codexEntry,
    "-LarkCliEntry", larkCliEntry,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DataDirectory must not pass through a reparse point/);
  await assert.rejects(access(path.join(repositoryState, "config")), { code: "ENOENT" });
});

async function activeLauncherFixture(t) {
  const { root } = await fixture(t);
  const dataDirectory = path.join(root, "state with spaces");
  const launcherDirectory = path.join(dataDirectory, "launcher");
  const runtimeDirectory = path.join(dataDirectory, "runtime", "verified-active");
  const bootstrapDirectory = path.join(dataDirectory, "bootstrap");
  const bootstrapPath = path.join(bootstrapDirectory, "runtime-bootstrap-test.mjs");
  const launcher = path.join(launcherDirectory, "start-bridge-windows.ps1");
  const canaryPath = path.join(root, "launcher-canary.json");
  await Promise.all([
    mkdir(launcherDirectory, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(bootstrapDirectory, { recursive: true }),
  ]);
  await copyFile(launcherTemplate, launcher);
  await writeFile(path.join(runtimeDirectory, "bridge.config.json"), "{}\n");
  const bootstrapSource = `
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const dataDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(dataDirectory, "bridge.lock");
await writeFile(lockPath, JSON.stringify({
  pid: process.pid,
  token: "00000000-0000-4000-8000-000000000000",
  startedAt: new Date().toISOString(),
}) + "\\n");
try {
  if (process.env.FEISHU_CODEX_LAUNCHER_CANARY) {
    await writeFile(
      process.env.FEISHU_CODEX_LAUNCHER_CANARY,
      JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
} finally {
  await rm(lockPath, { force: true });
}
`;
  await writeFile(bootstrapPath, bootstrapSource);
  const statePath = path.join(dataDirectory, "deployment-state.json");
  const state = {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    active: {
      runtimeDirectory,
      manifestSha256: "a".repeat(64),
      bootstrapPath,
      bootstrapSha256: sha256(bootstrapSource),
      pid: 1,
      startedAt: new Date(0).toISOString(),
    },
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return {
    root,
    dataDirectory,
    launcher,
    runtimeDirectory,
    bootstrapPath,
    bootstrapSource,
    statePath,
    state,
    canaryPath,
  };
}

test("Windows scheduled-task launcher verifies the installed active target without source access", {
  skip: process.platform !== "win32",
}, async (t) => {
  const fixture = await activeLauncherFixture(t);
  const result = runLauncher(fixture.launcher, ["-PlanOnly"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active runtime metadata and bootstrap verified/);
  assert.match(result.stdout, new RegExp(
    fixture.runtimeDirectory.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"),
  ));
  assert.doesNotMatch(result.stdout, /npm\.cmd|run deploy|source:/);
});

test("Windows scheduled-task launcher starts only the saved active target and refreshes its pid", {
  skip: process.platform !== "win32",
}, async (t) => {
  const fixture = await activeLauncherFixture(t);
  const result = runLauncher(fixture.launcher, [], {
    env: {
      ...process.env,
      FEISHU_CODEX_LAUNCHER_CANARY: fixture.canaryPath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified active runtime started/);
  const canary = JSON.parse(await readFile(fixture.canaryPath, "utf8"));
  assert.deepEqual(canary.argv, [
    "--runtime",
    fixture.runtimeDirectory,
    "--manifest-sha256",
    "a".repeat(64),
    "--",
    "start",
    "--config",
    path.join(fixture.runtimeDirectory, "bridge.config.json"),
  ]);
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.equal(state.active.pid, canary.pid);
  assert.notEqual(state.active.startedAt, new Date(0).toISOString());
  await assert.rejects(
    access(path.join(fixture.dataDirectory, "deployment.lock")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    access(path.join(fixture.dataDirectory, "bridge.lock")),
    { code: "ENOENT" },
  );
});

test("Windows scheduled-task launcher rejects bootstrap tampering and runtime path escape", {
  skip: process.platform !== "win32",
}, async (t) => {
  await t.test("tampered bootstrap", async (subtest) => {
    const fixture = await activeLauncherFixture(subtest);
    await writeFile(fixture.bootstrapPath, `${fixture.bootstrapSource}\n// tampered\n`);
    const result = runLauncher(fixture.launcher, ["-PlanOnly"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap hash mismatch/);
  });

  await t.test("runtime outside managed root", async (subtest) => {
    const fixture = await activeLauncherFixture(subtest);
    const escapedRuntime = path.join(fixture.root, "escaped-runtime");
    await mkdir(escapedRuntime);
    fixture.state.active.runtimeDirectory = escapedRuntime;
    await writeFile(fixture.statePath, `${JSON.stringify(fixture.state, null, 2)}\n`);
    const result = runLauncher(fixture.launcher, ["-PlanOnly"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime escaped/);
  });
});
