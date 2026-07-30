import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SUPPORTED_LARK_CLI_VERSION,
  assertSupportedLarkCliVersion,
  parseLarkCliVersion,
  requireSupportedLarkCliVersion,
} from "../src/lark-version.js";

test("parses and accepts only the audited Feishu CLI version", () => {
  const output = `lark-cli version ${SUPPORTED_LARK_CLI_VERSION}`;
  assert.equal(parseLarkCliVersion(`${output}\n`), SUPPORTED_LARK_CLI_VERSION);
  assert.equal(assertSupportedLarkCliVersion(output), `lark-cli ${SUPPORTED_LARK_CLI_VERSION}`);
});

test("executes the CLI version check and rejects a mismatched binary", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-lark-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "fake-lark.js");
  const tool = {
    command: process.execPath,
    prefixArgs: [entry],
    displayName: "lark-cli",
  };
  await writeFile(entry, `console.log("lark-cli version ${SUPPORTED_LARK_CLI_VERSION}");\n`);
  assert.equal(
    await requireSupportedLarkCliVersion(tool),
    `lark-cli ${SUPPORTED_LARK_CLI_VERSION}`,
  );

  const [major, minor, patch] = SUPPORTED_LARK_CLI_VERSION.split(".").map(Number);
  const mismatched = `${major}.${minor}.${patch + 1}`;
  await writeFile(entry, `console.log("lark-cli version ${mismatched}");\n`);
  await assert.rejects(
    requireSupportedLarkCliVersion(tool),
    new RegExp(`Unsupported Feishu CLI version ${mismatched.replaceAll(".", "\\.")}`),
  );
});

test("fails closed for missing, older, newer, or prerelease Feishu CLI versions", () => {
  const [major, minor, patch] = SUPPORTED_LARK_CLI_VERSION.split(".").map(Number);
  const differentPatch = patch > 0 ? patch - 1 : patch + 1;
  for (const output of [
    "",
    `lark ${SUPPORTED_LARK_CLI_VERSION}`,
    `lark-cli version ${major}.${minor}.${differentPatch}`,
    "lark-cli version 999.999.999",
    `lark-cli version ${SUPPORTED_LARK_CLI_VERSION}-beta.1`,
  ]) {
    assert.throws(
      () => assertSupportedLarkCliVersion(output),
      /Unable to determine|Unsupported Feishu CLI version/,
    );
  }
});
