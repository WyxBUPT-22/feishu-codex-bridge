import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  APPROVAL_DISPOSITIONS,
  APPROVAL_RISKS,
  classifyApplyPatchApproval,
} from "../src/approval-risk.js";

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-risk-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.js"), "old\n");
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function classify(root, patch, toolInput = { command: patch }) {
  return classifyApplyPatchApproval({
    repositoryPath: root,
    params: { toolName: "apply_patch", cwd: root, toolInput },
  });
}

test("auto-approves canonical in-repository adds and updates", async (t) => {
  const root = await repository(t);
  const added = classify(root, [
    "*** Begin Patch",
    "*** Add File: src/new.js",
    "+new",
    "*** End Patch",
  ].join("\n"));
  assert.equal(added.disposition, APPROVAL_DISPOSITIONS.AUTO_APPROVE);
  assert.equal(added.risk, APPROVAL_RISKS.LOW);
  assert.equal(added.reason, "workspace_file_add");
  assert.deepEqual(added.operations, [{ type: "add", path: "src/new.js" }]);

  const updated = classify(root, [
    "*** Begin Patch",
    "*** Update File: src/main.js",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n"));
  assert.equal(updated.disposition, APPROVAL_DISPOSITIONS.AUTO_APPROVE);
  assert.equal(updated.reason, "workspace_file_update");
});

test("keeps delete, move, and mixed changes behind manual approval", async (t) => {
  const root = await repository(t);
  const deleted = classify(root, [
    "*** Begin Patch",
    "*** Delete File: src/main.js",
    "*** End Patch",
  ].join("\n"));
  assert.equal(deleted.disposition, APPROVAL_DISPOSITIONS.MANUAL_APPROVAL);
  assert.equal(deleted.risk, APPROVAL_RISKS.HIGH);

  const moved = classify(root, [
    "*** Begin Patch",
    "*** Update File: src/main.js",
    "*** Move to: src/renamed.js",
    "*** End Patch",
  ].join("\n"));
  assert.equal(moved.disposition, APPROVAL_DISPOSITIONS.MANUAL_APPROVAL);
  assert.equal(moved.risk, APPROVAL_RISKS.HIGH);

  const mixed = classify(root, [
    "*** Begin Patch",
    "*** Update File: src/main.js",
    "@@",
    "-old",
    "+new",
    "*** Add File: src/other.js",
    "+other",
    "*** End Patch",
  ].join("\n"));
  assert.equal(mixed.disposition, APPROVAL_DISPOSITIONS.MANUAL_APPROVAL);
  assert.equal(mixed.risk, APPROVAL_RISKS.ELEVATED);
});

test("denies noncanonical and malformed patch payloads", async (t) => {
  const root = await repository(t);
  for (const toolInput of [
    { input: "*** Begin Patch" },
    { patch: "*** Begin Patch" },
    { command: "*** Begin Patch", patch: "ignored" },
    { command: 42 },
  ]) {
    const classification = classify(root, toolInput.command, toolInput);
    assert.equal(classification.disposition, APPROVAL_DISPOSITIONS.DENY);
  }
  for (const patch of [
    "*** Add File: src/new.js\n+x",
    "*** Begin Patch\n*** End Patch",
    "*** Begin Patch\n*** Add File: src/new.js\nnot-added\n*** End Patch",
    "*** Begin Patch\n*** Delete File: src/main.js\n-content\n*** End Patch",
    "*** Begin Patch\n*** Unknown File: src/main.js\n*** End Patch",
  ]) {
    assert.equal(classify(root, patch).disposition, APPROVAL_DISPOSITIONS.DENY, patch);
  }
});

test("denies traversal, absolute, UNC, ADS, and ambiguous Windows paths", async (t) => {
  const root = await repository(t);
  const unsafe = [
    "../outside.js",
    "src/../outside.js",
    "/outside.js",
    "C:\\outside.js",
    "\\\\server\\share\\outside.js",
    "src/main.js:secret",
    "src//new.js",
    "src/new.js.",
    "src/CON.txt",
  ];
  for (const target of unsafe) {
    const patch = `*** Begin Patch\n*** Add File: ${target}\n+x\n*** End Patch`;
    const classification = classify(root, patch);
    assert.equal(classification.disposition, APPROVAL_DISPOSITIONS.DENY, target);
    assert.equal(classification.risk, APPROVAL_RISKS.INVALID, target);
  }
});

test("denies missing updates, existing adds, duplicate targets, and cwd escapes", async (t) => {
  const root = await repository(t);
  assert.equal(classify(root, [
    "*** Begin Patch",
    "*** Update File: src/missing.js",
    "@@",
    "+new",
    "*** End Patch",
  ].join("\n")).disposition, APPROVAL_DISPOSITIONS.DENY);
  assert.equal(classify(root, [
    "*** Begin Patch",
    "*** Add File: src/main.js",
    "+new",
    "*** End Patch",
  ].join("\n")).disposition, APPROVAL_DISPOSITIONS.DENY);
  assert.equal(classify(root, [
    "*** Begin Patch",
    "*** Update File: src/main.js",
    "@@",
    "-old",
    "+new",
    "*** Update File: src/main.js",
    "@@",
    "-new",
    "+newer",
    "*** End Patch",
  ].join("\n")).reason, "ambiguous_patch_targets");

  const escaped = classifyApplyPatchApproval({
    repositoryPath: root,
    params: {
      toolName: "apply_patch",
      cwd: path.dirname(root),
      toolInput: { command: "*** Begin Patch\n*** Add File: outside.js\n+x\n*** End Patch" },
    },
  });
  assert.equal(escaped.reason, "invalid_workspace_context");
});

test("denies patch targets reached through a symlink or junction", async (t) => {
  const root = await repository(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "feishu-codex-risk-outside-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(outside, { recursive: true, force: true });
  });
  try {
    await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`symlink unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const classification = classify(root, [
    "*** Begin Patch",
    "*** Add File: linked/new.js",
    "+new",
    "*** End Patch",
  ].join("\n"));
  assert.equal(classification.disposition, APPROVAL_DISPOSITIONS.DENY);
  assert.equal(classification.reason, "unverified_patch_target");
});
