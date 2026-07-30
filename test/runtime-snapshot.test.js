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
import { createRuntimeSnapshot, verifyRuntimeSnapshot } from "../src/runtime-snapshot.js";

test("creates a repository-external runtime snapshot with relocated config and hashes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const configDirectory = path.join(root, "configuration");
  const repository = path.join(root, "repository");
  const dataDirectory = path.join(root, "data");
  await Promise.all([
    mkdir(path.join(source, "src"), { recursive: true }),
    mkdir(path.join(source, "scripts"), { recursive: true }),
    mkdir(configDirectory, { recursive: true }),
    mkdir(repository, { recursive: true }),
  ]);
  await writeFile(path.join(source, "src", "main.js"), "console.log('runtime');\n");
  await writeFile(path.join(source, "scripts", "runtime-bootstrap.mjs"), "console.log('bootstrap');\n");
  await writeFile(path.join(source, "package.json"), '{"type":"module"}\n');
  const configPath = path.join(configDirectory, "bridge.config.json");
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    dataDirectory: "../data",
    lark: {
      profile: "test",
      allowedSenders: ["ou_allowed"],
      allowedChats: [],
      p2pOnly: true,
    },
    repositories: { repo: { path: repository } },
    defaultRepository: "repo",
    codex: {
      entry: "../tools/codex.js",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      appServer: { enabled: true },
    },
    queue: { concurrency: 1 },
  })}\n`);

  const result = await createRuntimeSnapshot({
    configPath,
    sourceRoot: source,
    now: new Date("2026-07-14T00:00:00.000Z"),
  });
  assert.equal(path.dirname(path.dirname(result.runtimeDirectory)), dataDirectory);
  assert.match(path.basename(result.runtimeDirectory), /^20260714-000000000Z-[a-f0-9]{8}$/);
  assert.equal(await readFile(result.mainPath, "utf8"), "console.log('runtime');\n");

  const runtimeConfig = JSON.parse(await readFile(result.configPath, "utf8"));
  assert.equal(runtimeConfig.dataDirectory, dataDirectory);
  assert.equal(runtimeConfig.repositories.repo.path, repository);
  assert.equal(runtimeConfig.codex.entry, path.join(root, "tools", "codex.js"));
  assert.deepEqual(runtimeConfig.runtimeSnapshot, { required: true });

  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.sourceRoot, source);
  assert.match(manifest.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.sourceSha256, result.sourceSha256);
  assert.equal(manifest.configSource, configPath);
  assert.match(manifest.configSourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.configSourceSha256, result.configSourceSha256);
  assert.match(manifest.files["src/main.js"], /^[a-f0-9]{64}$/);
  assert.match(manifest.files["package.json"], /^[a-f0-9]{64}$/);
  assert.match(manifest.files["bridge.config.json"], /^[a-f0-9]{64}$/);
  const verified = await verifyRuntimeSnapshot({
    runtimeDirectory: result.runtimeDirectory,
  });
  assert.equal(verified.fileCount, 3);
  assert.equal(result.manifestSha256, verified.manifestSha256);
  assert.equal(verified.configSourceSha256, result.configSourceSha256);
  assert.equal(verified.sourceSha256, result.sourceSha256);
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
  assert.match(result.bootstrapSha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(result.bootstrapPath, "utf8"), "console.log('bootstrap');\n");
  assert.equal(path.dirname(result.bootstrapPath), path.join(dataDirectory, "bootstrap"));

  await writeFile(path.join(result.runtimeDirectory, "src", "main.js"), "tampered\n");
  await assert.rejects(
    verifyRuntimeSnapshot({ runtimeDirectory: result.runtimeDirectory }),
    /hash mismatch: src\/main\.js/,
  );
});
