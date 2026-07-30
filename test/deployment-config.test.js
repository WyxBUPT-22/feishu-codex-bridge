import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertConfigSourceUnchanged,
  canonicalConfigPath,
  inspectCanonicalConfig,
} from "../src/config.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-deploy-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, "data");
  const repository = path.join(root, "repository");
  const sourceRoot = path.join(root, "source");
  const configPath = canonicalConfigPath(dataDirectory);
  const shadowConfigPath = path.join(sourceRoot, "bridge.config.json");
  await Promise.all([
    mkdir(path.dirname(configPath), { recursive: true }),
    mkdir(repository, { recursive: true }),
    mkdir(sourceRoot, { recursive: true }),
  ]);
  const config = {
    version: 1,
    dataDirectory,
    lark: {
      profile: "test",
      allowedSenders: ["ou_allowed"],
      allowedChats: [],
      p2pOnly: true,
    },
    repositories: { repo: { path: repository } },
    defaultRepository: "repo",
    codex: {
      sandbox: "workspace-write",
      approvalPolicy: "never",
      appServer: { enabled: true },
    },
    queue: { concurrency: 1 },
  };
  const raw = `${JSON.stringify(config, null, 2)}\n`;
  await Promise.all([
    writeFile(configPath, raw),
    writeFile(shadowConfigPath, raw),
  ]);
  return { config, configPath, shadowConfigPath, sourceRoot };
}

test("accepts the canonical production config when its workspace shadow is equivalent", async (t) => {
  const files = await fixture(t);
  const inspected = await inspectCanonicalConfig(files);
  assert.equal(inspected.configPath, files.configPath);
  assert.match(inspected.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    await assertConfigSourceUnchanged(files.configPath, inspected.sourceSha256),
    inspected.sourceSha256,
  );
});

test("fails closed when the workspace config shadow drifts", async (t) => {
  const files = await fixture(t);
  const shadow = JSON.parse(await readFile(files.shadowConfigPath, "utf8"));
  shadow.codex.maxRuntimeMinutes = 61;
  await writeFile(files.shadowConfigPath, `${JSON.stringify(shadow, null, 2)}\n`);
  await assert.rejects(
    inspectCanonicalConfig(files),
    /Configuration drift detected/,
  );
});

test("refuses a non-canonical production config even when its contents are valid", async (t) => {
  const files = await fixture(t);
  const otherPath = path.join(files.sourceRoot, "other.config.json");
  await writeFile(otherPath, await readFile(files.configPath));
  await assert.rejects(
    inspectCanonicalConfig({ configPath: otherPath }),
    /must use the canonical path/,
  );
});

test("detects canonical config changes after preflight", async (t) => {
  const files = await fixture(t);
  const inspected = await inspectCanonicalConfig(files);
  const config = JSON.parse(await readFile(files.configPath, "utf8"));
  config.codex.maxRuntimeMinutes = 62;
  await writeFile(files.configPath, `${JSON.stringify(config, null, 2)}\n`);
  await assert.rejects(
    assertConfigSourceUnchanged(files.configPath, inspected.sourceSha256),
    /changed during deployment/,
  );
});
