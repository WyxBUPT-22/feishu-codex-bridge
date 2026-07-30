import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const BOOTSTRAP_PATH = path.resolve("scripts/runtime-bootstrap.mjs");
const CONFIG_SECRET = "RUNTIME_CONFIG_SECRET_MUST_NOT_LEAK";
const SNAPSHOT_FILES = [
  "package.json",
  "bridge.config.json",
  "src/main.js",
  "src/runtime-marker.txt",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  return sha256(await readFile(filePath));
}

async function writeManifest(runtimeDirectory, relatives = SNAPSHOT_FILES) {
  const files = {};
  for (const relative of relatives) {
    files[relative] = await fileSha256(
      path.join(runtimeDirectory, ...relative.split("/")),
    );
  }
  const raw = Buffer.from(`${JSON.stringify({ version: 1, files }, null, 2)}\n`);
  await writeFile(path.join(runtimeDirectory, "runtime-manifest.json"), raw);
  return sha256(raw);
}

async function createRuntime(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDirectory = path.join(root, "runtime");
  const sourceDirectory = path.join(runtimeDirectory, "src");
  const canaryPath = path.join(root, "canary.json");
  await mkdir(sourceDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(runtimeDirectory, "package.json"), '{"type":"module"}\n'),
    writeFile(path.join(runtimeDirectory, "bridge.config.json"), `${JSON.stringify({
      runtimeSnapshot: { required: true },
      credentialCanary: CONFIG_SECRET,
    })}\n`),
    writeFile(path.join(sourceDirectory, "runtime-marker.txt"), "trusted runtime\n"),
    writeFile(path.join(sourceDirectory, "main.js"), `
import { writeFileSync } from "node:fs";
writeFileSync(
  process.env.RUNTIME_BOOTSTRAP_CANARY,
  JSON.stringify({ argv: process.argv.slice(1) }),
);
`),
  ]);
  const manifestSha256 = await writeManifest(runtimeDirectory);
  return {
    root,
    runtimeDirectory,
    canaryPath,
    configPath: path.join(runtimeDirectory, "bridge.config.json"),
    mainPath: path.join(sourceDirectory, "main.js"),
    manifestSha256,
  };
}

async function runBootstrap(runtime, manifestSha256) {
  const child = spawn(process.execPath, [
    BOOTSTRAP_PATH,
    "--runtime",
    runtime.runtimeDirectory,
    "--manifest-sha256",
    manifestSha256,
    "--",
    "start",
    "--config",
    runtime.configPath,
  ], {
    cwd: runtime.root,
    env: {
      ...process.env,
      RUNTIME_BOOTSTRAP_CANARY: runtime.canaryPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, "close");
  return { code, signal, stdout, stderr };
}

async function assertCanaryMissing(filePath) {
  await assert.rejects(
    access(filePath),
    (error) => error.code === "ENOENT",
  );
}

function assertSafeFailure(result, pattern) {
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(CONFIG_SECRET));
}

test("trusted runtime bootstrap verifies before executing the snapshot main module", async (t) => {
  const runtime = await createRuntime(t);
  const result = await runBootstrap(runtime, runtime.manifestSha256);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(await readFile(runtime.canaryPath, "utf8")), {
    argv: [runtime.mainPath, "start", "--config", runtime.configPath],
  });
});

test("runtime bootstrap rejects snapshot changes before canary execution", async (t) => {
  await t.test("tampered main module", async (subtest) => {
    const runtime = await createRuntime(subtest);
    await writeFile(runtime.mainPath, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.RUNTIME_BOOTSTRAP_CANARY, "tampered");
`);
    const result = await runBootstrap(runtime, runtime.manifestSha256);
    assertSafeFailure(result, /hash mismatch: src\/main\.js/);
    await assertCanaryMissing(runtime.canaryPath);
  });

  await t.test("deleted runtime-required marker", async (subtest) => {
    const runtime = await createRuntime(subtest);
    const config = JSON.parse(await readFile(runtime.configPath, "utf8"));
    delete config.runtimeSnapshot;
    await writeFile(runtime.configPath, `${JSON.stringify(config)}\n`);
    const result = await runBootstrap(runtime, runtime.manifestSha256);
    assertSafeFailure(result, /hash mismatch: bridge\.config\.json/);
    await assertCanaryMissing(runtime.canaryPath);
  });

  await t.test("deleted manifest-listed marker file", async (subtest) => {
    const runtime = await createRuntime(subtest);
    await unlink(path.join(runtime.runtimeDirectory, "src", "runtime-marker.txt"));
    const result = await runBootstrap(runtime, runtime.manifestSha256);
    assertSafeFailure(result, /file set does not match/);
    await assertCanaryMissing(runtime.canaryPath);
  });

  await t.test("extra file", async (subtest) => {
    const runtime = await createRuntime(subtest);
    await writeFile(path.join(runtime.runtimeDirectory, "src", "extra.js"), "throw new Error();\n");
    const result = await runBootstrap(runtime, runtime.manifestSha256);
    assertSafeFailure(result, /file set does not match/);
    await assertCanaryMissing(runtime.canaryPath);
  });

  await t.test("rewritten manifest with matching tampered file hash", async (subtest) => {
    const runtime = await createRuntime(subtest);
    await writeFile(runtime.mainPath, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.RUNTIME_BOOTSTRAP_CANARY, "rewritten manifest");
`);
    await writeManifest(runtime.runtimeDirectory);
    const result = await runBootstrap(runtime, runtime.manifestSha256);
    assertSafeFailure(result, /externally trusted SHA-256/);
    await assertCanaryMissing(runtime.canaryPath);
  });
});

test("runtime bootstrap rejects a symlink or reparse entry before execution", async (t) => {
  const runtime = await createRuntime(t);
  const linkPath = path.join(runtime.runtimeDirectory, "src", "linked-marker.txt");
  try {
    await symlink("runtime-marker.txt", linkPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error.code)) {
      t.skip(`symbolic links are unavailable on this platform: ${error.code}`);
      return;
    }
    throw error;
  }
  const result = await runBootstrap(runtime, runtime.manifestSha256);
  assertSafeFailure(result, /symbolic link or reparse point/);
  await assertCanaryMissing(runtime.canaryPath);
});
