import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SUPPORTED_CODEX_VERSION } from "../src/codex-version.js";
import { formatDoctor, runDoctor, stopDoctorResources } from "../src/doctor.js";
import { SUPPORTED_LARK_CLI_VERSION } from "../src/lark-version.js";
import { baseConfig } from "./helpers.js";

test("formats isolation warnings without treating them as failures", () => {
  assert.equal(
    formatDoctor([{ name: "isolation", ok: true, warning: true, detail: "separate users" }]),
    "WARN isolation: separate users",
  );
});

test("doctor always attempts both app-server and hook-server cleanup", async () => {
  const calls = [];
  const client = {
    stop() {
      calls.push("client");
      throw new Error("client stop failed");
    },
  };
  const hookServer = {
    async stop() {
      calls.push("hook");
    },
  };
  await assert.rejects(
    stopDoctorResources(client, hookServer),
    /Doctor resource cleanup failed/,
  );
  assert.deepEqual(calls.sort(), ["client", "hook"]);
});

test("doctor fails the lark-cli check for a version outside the audited toolchain", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-doctor-lark-version-"));
  const repository = path.join(root, "repository");
  const larkEntry = path.join(root, "fake-lark.js");
  const codexEntry = path.join(root, "fake-codex.js");
  await mkdir(repository);
  t.after(() => rm(root, { recursive: true, force: true }));

  const [major, minor, patch] = SUPPORTED_LARK_CLI_VERSION.split(".").map(Number);
  const mismatched = `${major}.${minor}.${patch + 1}`;
  await writeFile(larkEntry, `
if (process.argv.includes("--version")) console.log("lark-cli version ${mismatched}");
`);
  await writeFile(codexEntry, `
if (process.argv.includes("--version")) console.log("codex-cli ${SUPPORTED_CODEX_VERSION}");
`);

  const config = baseConfig(repository);
  const checks = await runDoctor({
    config,
    larkTool: {
      command: process.execPath,
      prefixArgs: [larkEntry],
      displayName: "lark-cli",
    },
    codexTool: {
      command: process.execPath,
      prefixArgs: [codexEntry],
      displayName: "Codex",
    },
  });

  const larkVersion = checks.find((check) => check.name === "lark-cli");
  assert.equal(larkVersion.ok, false);
  assert.match(larkVersion.detail, new RegExp(`Unsupported Feishu CLI version ${mismatched.replaceAll(".", "\\.")}`));
});
