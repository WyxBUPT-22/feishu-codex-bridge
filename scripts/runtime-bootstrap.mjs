#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createReadStream,
} from "node:fs";
import {
  lstat,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MANIFEST_NAME = "runtime-manifest.json";
const MANIFEST_LIMIT_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const REQUIRED_FILES = [
  "package.json",
  "bridge.config.json",
  "src/main.js",
];
const COMMANDS = new Set(["start", "doctor", "stop"]);

function usage() {
  return "Usage: node runtime-bootstrap.mjs --runtime <absolute-path> --manifest-sha256 <64hex> -- <start|doctor|stop> --config <absolute-path>";
}

function fail(message) {
  throw new Error(message);
}

function samePath(left, right) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === "win32"
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || argv.indexOf("--", separator + 1) >= 0) fail(usage());

  let runtimeDirectory = null;
  let manifestSha256 = null;
  for (let index = 0; index < separator; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--runtime" && value && !runtimeDirectory) {
      runtimeDirectory = value;
      index += 1;
    } else if (option === "--manifest-sha256" && value && !manifestSha256) {
      manifestSha256 = value;
      index += 1;
    } else {
      fail(usage());
    }
  }

  if (!runtimeDirectory || !path.isAbsolute(runtimeDirectory)) {
    fail("Runtime bootstrap requires an absolute --runtime path");
  }
  if (!manifestSha256 || !SHA256_PATTERN.test(manifestSha256)) {
    fail("Runtime bootstrap requires a 64-hex --manifest-sha256 value");
  }

  const forwarded = argv.slice(separator + 1);
  if (forwarded.length !== 3 || !COMMANDS.has(forwarded[0])
    || forwarded[1] !== "--config" || !path.isAbsolute(forwarded[2])) {
    fail(usage());
  }

  const absoluteRuntime = path.resolve(runtimeDirectory);
  const expectedConfig = path.join(absoluteRuntime, "bridge.config.json");
  if (!samePath(forwarded[2], expectedConfig)) {
    fail("Runtime bootstrap only accepts the verified runtime configuration");
  }

  return {
    runtimeDirectory: absoluteRuntime,
    manifestSha256: manifestSha256.toLowerCase(),
    forwarded: [forwarded[0], "--config", expectedConfig],
  };
}

function validRelativePath(relative) {
  if (typeof relative !== "string" || relative.length === 0
    || relative.includes("\\") || relative.includes("\0")) return false;
  const normalized = path.posix.normalize(relative);
  return normalized === relative && !path.posix.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith("../");
}

function allowedRuntimeFile(relative) {
  return relative === "package.json" || relative === "bridge.config.json"
    || (relative.startsWith("src/") && relative.length > "src/".length);
}

function expectedDirectories(files) {
  const directories = new Set();
  for (const relative of files) {
    let directory = path.posix.dirname(relative);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories].sort();
}

async function sha256File(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("Runtime snapshot contains a non-regular file");
  }
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(digest.digest("hex")));
  });
}

async function snapshotEntries(runtimeDirectory) {
  const files = [];
  const directories = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const fullPath = path.join(directory, entry.name);
      const metadata = await lstat(fullPath);
      if (metadata.isSymbolicLink()) {
        fail(`Runtime snapshot contains a symbolic link or reparse point: ${relative}`);
      }
      if (metadata.isDirectory()) {
        directories.push(relative);
        await visit(fullPath, relative);
      } else if (metadata.isFile()) {
        files.push(relative);
      } else {
        fail(`Runtime snapshot contains a non-regular entry: ${relative}`);
      }
    }
  }
  await visit(runtimeDirectory);
  return { files: files.sort(), directories: directories.sort() };
}

function parseManifest(raw) {
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch {
    fail("Runtime manifest is not valid JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || manifest.version !== 1 || !manifest.files
    || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    fail("Runtime manifest has an invalid structure");
  }

  const expected = Object.keys(manifest.files).sort();
  if (REQUIRED_FILES.some((relative) => !expected.includes(relative))) {
    fail("Runtime manifest is missing a required file");
  }
  for (const relative of expected) {
    if (!validRelativePath(relative) || !allowedRuntimeFile(relative)
      || typeof manifest.files[relative] !== "string"
      || !/^[a-f0-9]{64}$/.test(manifest.files[relative])) {
      fail("Runtime manifest contains an invalid file entry");
    }
  }
  return { manifest, expected };
}

async function verifyRuntime({ runtimeDirectory, manifestSha256 }) {
  const rootMetadata = await lstat(runtimeDirectory).catch(() => null);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("Runtime path must be a regular directory, not a link or reparse point");
  }

  const manifestPath = path.join(runtimeDirectory, MANIFEST_NAME);
  const manifestMetadata = await lstat(manifestPath).catch(() => null);
  if (!manifestMetadata?.isFile() || manifestMetadata.isSymbolicLink()) {
    fail("Runtime manifest must be a regular file");
  }
  if (manifestMetadata.size > MANIFEST_LIMIT_BYTES) {
    fail("Runtime manifest is too large");
  }

  const rawManifest = await readFile(manifestPath);
  const actualManifestSha256 = createHash("sha256").update(rawManifest).digest();
  const expectedManifestSha256 = Buffer.from(manifestSha256, "hex");
  if (!timingSafeEqual(actualManifestSha256, expectedManifestSha256)) {
    fail("Runtime manifest does not match the externally trusted SHA-256");
  }

  const { manifest, expected } = parseManifest(rawManifest);
  const entries = await snapshotEntries(runtimeDirectory);
  const actualFiles = entries.files.filter((relative) => relative !== MANIFEST_NAME);
  if (entries.files.filter((relative) => relative === MANIFEST_NAME).length !== 1
    || JSON.stringify(actualFiles) !== JSON.stringify(expected)
    || JSON.stringify(entries.directories) !== JSON.stringify(expectedDirectories(expected))) {
    fail("Runtime snapshot file set does not match its manifest");
  }

  for (const relative of expected) {
    const filePath = path.join(runtimeDirectory, ...relative.split("/"));
    const digest = await sha256File(filePath);
    if (digest !== manifest.files[relative]) {
      fail(`Runtime snapshot hash mismatch: ${relative}`);
    }
  }
  return path.join(runtimeDirectory, "src", "main.js");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mainPath = await verifyRuntime(options);
  process.argv = [process.execPath, mainPath, ...options.forwarded];
  await import(pathToFileURL(mainPath).href);
}

main().catch((error) => {
  console.error(`Runtime bootstrap refused to start: ${error?.message ?? "unknown error"}`);
  process.exitCode = 1;
});
