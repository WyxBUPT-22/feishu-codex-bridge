import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export const APPROVAL_DISPOSITIONS = Object.freeze({
  AUTO_APPROVE: "auto_approve",
  MANUAL_APPROVAL: "manual_approval",
  DENY: "deny",
});

export const APPROVAL_RISKS = Object.freeze({
  LOW: "low",
  ELEVATED: "elevated",
  HIGH: "high",
  INVALID: "invalid",
});

const PATCH_HEADER = Object.freeze({
  Add: "add",
  Update: "update",
  Delete: "delete",
});

function result(disposition, risk, reason, operations = []) {
  return { disposition, risk, reason, operations };
}

function deny(reason) {
  return result(APPROVAL_DISPOSITIONS.DENY, APPROVAL_RISKS.INVALID, reason);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function filesystemPathKey(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathParts(patchPath) {
  if (typeof patchPath !== "string" || patchPath.length === 0 || patchPath.length > 1_024) {
    return null;
  }
  if (patchPath !== patchPath.trim() || /[\u0000-\u001f\u007f]/.test(patchPath)) return null;
  if (path.posix.isAbsolute(patchPath) || path.win32.isAbsolute(patchPath)
      || /^[\\/]/.test(patchPath) || patchPath.includes(":")) return null;

  const parts = patchPath.split(/[\\/]/);
  if (parts.some((part) => (
    part === "" || part === "." || part === ".."
      || /[<>"|?*]/.test(part)
      || /[ .]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
  ))) return null;
  return parts;
}

function parsePatch(patchText) {
  if (typeof patchText !== "string" || patchText.length === 0 || patchText.includes("\0")) {
    return { error: "invalid_patch_document" };
  }
  const normalized = patchText.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) return { error: "invalid_patch_document" };
  const document = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (document.endsWith("\n")) return { error: "invalid_patch_document" };
  const lines = document.split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    return { error: "invalid_patch_document" };
  }

  const operations = [];
  let current = null;
  const finish = () => {
    if (!current) return true;
    if (current.type === "add" && current.body.some((line) => !line.startsWith("+"))) {
      return false;
    }
    if (current.type === "delete" && current.body.length > 0) return false;
    const { body, ...operation } = current;
    operations.push(operation);
    current = null;
    return true;
  };

  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      if (!finish()) return { error: "invalid_patch_document" };
      const parts = pathParts(header[2]);
      if (!parts) return { error: "unsafe_patch_path" };
      current = { type: PATCH_HEADER[header[1]], path: header[2], parts, body: [] };
      continue;
    }

    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) {
      if (!current || current.type !== "update" || current.destination || current.body.length > 0) {
        return { error: "invalid_patch_document" };
      }
      const parts = pathParts(move[1]);
      if (!parts) return { error: "unsafe_patch_path" };
      current.type = "move";
      current.destination = move[1];
      current.destinationParts = parts;
      continue;
    }

    if (!current || (line.startsWith("*** ") && line !== "*** End of File")) {
      return { error: "invalid_patch_document" };
    }
    current.body.push(line);
  }

  if (!finish() || operations.length === 0) return { error: "invalid_patch_document" };
  return { operations };
}

function lstat(candidate) {
  try {
    return { exists: true, stats: lstatSync(candidate) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, stats: null };
    return { exists: null, stats: null };
  }
}

function realpath(candidate) {
  try {
    return realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function inspectExistingComponents(root, candidate) {
  const relative = path.relative(root, candidate);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = root;
  let nearestExisting = root;
  let missing = false;
  let finalStats = lstat(root);
  if (finalStats.exists !== true || !finalStats.stats.isDirectory()
      || finalStats.stats.isSymbolicLink()) return null;

  for (const segment of segments) {
    current = path.join(current, segment);
    const entry = lstat(current);
    finalStats = entry;
    if (entry.exists === null) return null;
    if (entry.exists === false) {
      missing = true;
      continue;
    }
    if (missing || entry.stats.isSymbolicLink()) return null;
    nearestExisting = current;
    if (current !== candidate && !entry.stats.isDirectory()) return null;
  }
  return { final: finalStats, nearestExisting };
}

function validateTarget(context, parts, expectation) {
  const candidate = path.resolve(context.cwd, ...parts);
  if (!isWithin(context.repository, candidate)) return false;
  const inspection = inspectExistingComponents(context.repository, candidate);
  if (!inspection) return false;
  const nearestReal = realpath(inspection.nearestExisting);
  if (!nearestReal || !isWithin(context.repositoryReal, nearestReal)) return false;

  if (expectation === "absent") return inspection.final.exists === false;
  if (inspection.final.exists !== true || !inspection.final.stats.isFile()
      || inspection.final.stats.isSymbolicLink()) return false;
  // A hard-linked file can modify data reachable outside the repository.
  if (inspection.final.stats.nlink > 1) return false;
  const candidateReal = realpath(candidate);
  return Boolean(candidateReal && isWithin(context.repositoryReal, candidateReal));
}

function workspaceContext(repositoryPath, cwd) {
  if (typeof repositoryPath !== "string" || repositoryPath.trim().length === 0
      || typeof cwd !== "string" || cwd.trim().length === 0) return null;
  const repository = path.resolve(repositoryPath);
  const workingDirectory = path.resolve(cwd);
  if (!isWithin(repository, workingDirectory)) return null;

  const repositoryEntry = lstat(repository);
  const workingEntry = inspectExistingComponents(repository, workingDirectory);
  if (repositoryEntry.exists !== true || !repositoryEntry.stats.isDirectory()
      || repositoryEntry.stats.isSymbolicLink()
      || !workingEntry || workingEntry.final.exists !== true
      || !workingEntry.final.stats.isDirectory()) return null;
  const repositoryReal = realpath(repository);
  const workingReal = realpath(workingDirectory);
  if (!repositoryReal || !workingReal || !isWithin(repositoryReal, workingReal)) return null;
  return { repository, repositoryReal, cwd: workingDirectory };
}

/**
 * Classifies one canonical PreToolUse apply_patch request without throwing.
 * Strict mode can turn auto_approve into manual_approval; balanced mode may
 * accept only auto_approve. Invalid requests must always remain denied.
 */
export function classifyApplyPatchApproval({ params, repositoryPath } = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)
      || params.toolName !== "apply_patch") return deny("not_apply_patch");
  const input = params.toolInput;
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).length !== 1
      || !Object.prototype.hasOwnProperty.call(input, "command")) {
    return deny("noncanonical_patch_input");
  }

  const parsed = parsePatch(input.command);
  if (parsed.error) return deny(parsed.error);
  const context = workspaceContext(repositoryPath, params.cwd ?? repositoryPath);
  if (!context) return deny("invalid_workspace_context");

  const seen = new Set();
  for (const operation of parsed.operations) {
    const targets = [{ parts: operation.parts, expectation: operation.type === "add" ? "absent" : "file" }];
    if (operation.type === "move") {
      targets.push({ parts: operation.destinationParts, expectation: "absent" });
    }
    for (const target of targets) {
      const absolute = path.resolve(context.cwd, ...target.parts);
      const key = filesystemPathKey(absolute);
      if (seen.has(key)) return deny("ambiguous_patch_targets");
      seen.add(key);
      if (!validateTarget(context, target.parts, target.expectation)) {
        return deny("unverified_patch_target");
      }
    }
  }

  const operations = parsed.operations.map(({ parts, destinationParts, ...operation }) => operation);
  const types = new Set(operations.map((operation) => operation.type));
  if (types.size === 1 && (types.has("add") || types.has("update"))) {
    return result(
      APPROVAL_DISPOSITIONS.AUTO_APPROVE,
      APPROVAL_RISKS.LOW,
      types.has("add") ? "workspace_file_add" : "workspace_file_update",
      operations,
    );
  }
  if (types.has("delete") || types.has("move")) {
    return result(
      APPROVAL_DISPOSITIONS.MANUAL_APPROVAL,
      APPROVAL_RISKS.HIGH,
      "destructive_or_moving_patch",
      operations,
    );
  }
  return result(
    APPROVAL_DISPOSITIONS.MANUAL_APPROVAL,
    APPROVAL_RISKS.ELEVATED,
    "mixed_patch_operations",
    operations,
  );
}
