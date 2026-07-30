import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SUPPORTED_CODEX_VERSION,
  assertSupportedCodexVersion,
  parseCodexVersion,
  requireSupportedCodexVersion,
} from "../src/codex-version.js";

test("parses and accepts only the audited Codex CLI version", () => {
  assert.equal(parseCodexVersion("codex-cli 0.144.1\n"), SUPPORTED_CODEX_VERSION);
  assert.equal(assertSupportedCodexVersion("codex-cli 0.144.1"), "codex-cli 0.144.1");
});

test("executes the CLI version check and rejects a mismatched binary", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "fake-codex.js");
  const tool = {
    command: process.execPath,
    prefixArgs: [entry],
    displayName: "Codex",
  };
  await writeFile(entry, 'console.log("codex-cli 0.144.1");\n');
  assert.equal(await requireSupportedCodexVersion(tool), "codex-cli 0.144.1");
  await writeFile(entry, 'console.log("codex-cli 0.145.0");\n');
  await assert.rejects(
    requireSupportedCodexVersion(tool),
    /Unsupported Codex CLI version 0\.145\.0/,
  );
});

test("fails closed for missing, newer, older, or prerelease Codex versions", () => {
  for (const output of [
    "",
    "codex 0.144.1",
    "codex-cli 0.143.0",
    "codex-cli 0.145.0",
    "codex-cli 0.144.1-beta.1",
  ]) {
    assert.throws(
      () => assertSupportedCodexVersion(output),
      /Unable to determine|Unsupported Codex CLI version/,
    );
  }
});
