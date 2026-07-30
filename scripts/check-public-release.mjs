#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const forbiddenTrackedNames = new Set([".env", "auth.json", "bridge.config.json"]);
const ignoredDirectories = new Set([".agents", ".git", "coverage", "node_modules"]);
const scanExtensions = new Set([
  ".cmd", ".js", ".json", ".md", ".mjs", ".ps1", ".toml", ".yaml", ".yml",
]);

async function fallbackFiles(root, directory = root) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await fallbackFiles(root, absolute));
    else if (entry.isFile() && entry.name !== "bridge.config.json") {
      output.push(path.relative(root, absolute));
    }
  }
  return output;
}

async function publicFiles(root) {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = output.split("\0").filter(Boolean);
    if (files.length > 0) return files;
  } catch {
    // Source archives may not contain Git metadata.
  }
  return fallbackFiles(root);
}

function containsRealIdentifier(content, pattern) {
  return [...content.matchAll(pattern)].some(([value]) => (
    !/(?:allowed|example|operator|other|replace|test|your)/i.test(value)
  ));
}

export function containsKnownPrivateMarker(content) {
  return /_mycollegelife|shuai[\s_-]*api/i.test(content);
}

const codexThreadIdPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const syntheticThreadIdPattern = /^01900000-0000-7000-8000-00000000000[0-9a-f]$/i;

export function containsPossibleRealCodexThreadId(content) {
  return [...content.matchAll(codexThreadIdPattern)]
    .some(([value]) => !syntheticThreadIdPattern.test(value));
}

export async function checkPublicRelease({
  root = process.cwd(),
  username = os.userInfo().username,
} = {}) {
  const findings = [];
  const normalizedUsername = username.toLowerCase();
  for (const relative of await publicFiles(root)) {
    const portable = relative.replaceAll("\\", "/");
    if (forbiddenTrackedNames.has(path.basename(relative).toLowerCase())) {
      findings.push(`${portable}: private file must not be tracked`);
      continue;
    }
    if (!scanExtensions.has(path.extname(relative).toLowerCase())) continue;
    const content = await readFile(path.join(root, relative), "utf8");
    const normalizedContent = content.replaceAll("\\", "/").toLowerCase();

    if (normalizedContent.includes(`c:/users/${normalizedUsername}/`)) {
      findings.push(`${portable}: contains the current Windows user path`);
    }
    if (portable !== "scripts/check-public-release.mjs"
      && containsKnownPrivateMarker(content)) {
      findings.push(`${portable}: contains a known private machine or provider marker`);
    }
    if (containsRealIdentifier(content, /\bcli_[a-z0-9]{16,}\b/gi)
      || containsRealIdentifier(content, /\bou_[a-z0-9_-]{24,}\b/gi)
      || containsRealIdentifier(content, /\b(?:sk|sess)-[a-z0-9_-]{16,}\b/gi)) {
      findings.push(`${portable}: contains a possible real credential or Feishu identifier`);
    }
    if (containsPossibleRealCodexThreadId(content)) {
      findings.push(`${portable}: contains a possible real Codex thread ID`);
    }
  }
  return findings;
}

async function main() {
  const findings = await checkPublicRelease();
  if (findings.length > 0) {
    console.error("Public release check failed:\n" + findings.map((item) => `- ${item}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Public release check passed.");
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exitCode = 1;
  });
}
