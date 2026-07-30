import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfigSourceUnchanged, normalizeConfig } from "./config.js";

const DEFAULT_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

async function filesUnder(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
      else throw new Error(`Runtime snapshot contains a non-regular entry: ${fullPath}`);
    }
  }
  await visit(directory);
  return files.sort();
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function runtimeSourceFingerprint({ sourceRoot = DEFAULT_SOURCE_ROOT } = {}) {
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const sourceFiles = [
    path.join(absoluteSourceRoot, "package.json"),
    path.join(absoluteSourceRoot, "scripts", "runtime-bootstrap.mjs"),
    ...await filesUnder(path.join(absoluteSourceRoot, "src")),
  ];
  const digest = createHash("sha256");
  for (const filePath of sourceFiles.sort()) {
    const relative = path.relative(absoluteSourceRoot, filePath).split(path.sep).join("/");
    digest.update(relative);
    digest.update("\0");
    digest.update(await readFile(filePath));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function installRuntimeBootstrap(sourceRoot, dataDirectory) {
  const sourcePath = path.join(sourceRoot, "scripts", "runtime-bootstrap.mjs");
  const bootstrapSha256 = await sha256(sourcePath);
  const bootstrapDirectory = path.join(dataDirectory, "bootstrap");
  await mkdir(bootstrapDirectory, { recursive: true });
  const bootstrapPath = path.join(
    bootstrapDirectory,
    `runtime-bootstrap-${bootstrapSha256.slice(0, 16)}.mjs`,
  );
  try {
    await copyFile(sourcePath, bootstrapPath, fsConstants.COPYFILE_EXCL);
    await chmod(bootstrapPath, 0o700);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const metadata = await lstat(bootstrapPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || await sha256(bootstrapPath) !== bootstrapSha256) {
      throw new Error(`Existing runtime bootstrap is not the trusted file: ${bootstrapPath}`);
    }
  }
  return { bootstrapPath, bootstrapSha256 };
}

function relocatedConfig(raw, normalized, originalConfigPath) {
  const next = structuredClone(raw);
  next.dataDirectory = normalized.dataDirectory;
  next.runtimeSnapshot = { required: true };
  for (const [alias, repository] of Object.entries(normalized.repositories)) {
    next.repositories[alias].path = repository.path;
  }
  const configDirectory = path.dirname(originalConfigPath);
  if (next.codex?.entry && !path.isAbsolute(next.codex.entry)) {
    next.codex.entry = path.resolve(configDirectory, next.codex.entry);
  }
  if (next.larkCliEntry && !path.isAbsolute(next.larkCliEntry)) {
    next.larkCliEntry = path.resolve(configDirectory, next.larkCliEntry);
  }
  return next;
}

function validManifestRelativePath(relative) {
  if (typeof relative !== "string" || relative.length === 0 || relative.includes("\\")) return false;
  const normalized = path.posix.normalize(relative);
  return normalized === relative && !path.posix.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith("../");
}

function allowedRuntimeFile(relative) {
  return relative === "package.json" || relative === "bridge.config.json"
    || relative.startsWith("src/");
}

export async function verifyRuntimeSnapshot({ runtimeDirectory }) {
  const absoluteRuntimeDirectory = path.resolve(runtimeDirectory);
  const manifestPath = path.join(absoluteRuntimeDirectory, "runtime-manifest.json");
  const manifestRaw = await readFile(manifestPath);
  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  if (manifest?.version !== 1 || !manifest.files || typeof manifest.files !== "object") {
    throw new Error("Invalid runtime snapshot manifest");
  }
  if (manifest.configSourceSha256 != null
    && !/^[a-f0-9]{64}$/.test(manifest.configSourceSha256)) {
    throw new Error("Invalid runtime snapshot configuration digest");
  }
  if (manifest.sourceSha256 != null && !/^[a-f0-9]{64}$/.test(manifest.sourceSha256)) {
    throw new Error("Invalid runtime snapshot source digest");
  }
  const expected = Object.keys(manifest.files).sort();
  const requiredFiles = ["package.json", "bridge.config.json", "src/main.js"];
  if (requiredFiles.some((relative) => !expected.includes(relative))
    || expected.some((relative) => (
    !validManifestRelativePath(relative) || !allowedRuntimeFile(relative)
    || !/^[a-f0-9]{64}$/.test(manifest.files[relative])
    ))) {
    throw new Error("Runtime snapshot manifest contains an invalid file entry");
  }
  const actual = (await filesUnder(absoluteRuntimeDirectory))
    .map((filePath) => path.relative(absoluteRuntimeDirectory, filePath).split(path.sep).join("/"))
    .filter((relative) => relative !== "runtime-manifest.json")
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Runtime snapshot file set does not match its manifest");
  }
  for (const relative of expected) {
    const digest = await sha256(path.join(absoluteRuntimeDirectory, ...relative.split("/")));
    if (digest !== manifest.files[relative]) {
      throw new Error(`Runtime snapshot hash mismatch: ${relative}`);
    }
  }
  return {
    runtimeDirectory: absoluteRuntimeDirectory,
    manifestPath,
    manifestSha256: createHash("sha256").update(manifestRaw).digest("hex"),
    fileCount: expected.length,
    createdAt: manifest.createdAt ?? null,
    sourceRoot: manifest.sourceRoot ?? null,
    sourceSha256: manifest.sourceSha256 ?? null,
    configSource: manifest.configSource ?? null,
    configSourceSha256: manifest.configSourceSha256 ?? null,
  };
}

export async function createRuntimeSnapshot({
  configPath = "bridge.config.json",
  sourceRoot = DEFAULT_SOURCE_ROOT,
  now = new Date(),
} = {}) {
  const originalConfigPath = path.resolve(configPath);
  let rawConfigBytes;
  let rawConfig;
  try {
    rawConfigBytes = await readFile(originalConfigPath);
    rawConfig = JSON.parse(rawConfigBytes.toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Configuration not found: ${originalConfigPath}`);
    }
    throw new Error(`Cannot read configuration ${originalConfigPath}: ${error.message}`);
  }
  const normalized = normalizeConfig(rawConfig, originalConfigPath);
  const configSourceSha256 = createHash("sha256").update(rawConfigBytes).digest("hex");
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const sourceSha256 = await runtimeSourceFingerprint({ sourceRoot: absoluteSourceRoot });
  const runtimeRoot = path.join(normalized.dataDirectory, "runtime");
  for (const repository of Object.values(normalized.repositories)) {
    if (within(repository.path, runtimeRoot)) {
      throw new Error(`Runtime snapshot directory is inside managed repository: ${repository.path}`);
    }
  }
  await mkdir(runtimeRoot, { recursive: true });
  const timestamp = now.toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "Z");
  const id = `${timestamp}-${randomBytes(4).toString("hex")}`;
  const destination = path.join(runtimeRoot, id);
  const staging = path.join(runtimeRoot, `.partial-${id}`);
  let published = false;
  if (!within(runtimeRoot, staging) || !within(runtimeRoot, destination)) {
    throw new Error("Runtime snapshot target escaped its managed directory");
  }

  try {
    await mkdir(staging);
    await Promise.all([
      cp(path.join(absoluteSourceRoot, "src"), path.join(staging, "src"), {
        recursive: true,
        errorOnExist: true,
        force: false,
      }),
      cp(path.join(absoluteSourceRoot, "package.json"), path.join(staging, "package.json"), {
        errorOnExist: true,
        force: false,
      }),
    ]);
    const runtimeConfig = relocatedConfig(rawConfig, normalized, originalConfigPath);
    await writeFile(
      path.join(staging, "bridge.config.json"),
      `${JSON.stringify(runtimeConfig, null, 2)}\n`,
      "utf8",
    );

    const manifestFiles = {};
    for (const filePath of await filesUnder(staging)) {
      const relative = path.relative(staging, filePath).split(path.sep).join("/");
      manifestFiles[relative] = await sha256(filePath);
    }
    const manifest = {
      version: 1,
      createdAt: now.toISOString(),
      sourceRoot: absoluteSourceRoot,
      sourceSha256,
      configSource: originalConfigPath,
      configSourceSha256,
      files: manifestFiles,
    };
    await writeFile(
      path.join(staging, "runtime-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await assertConfigSourceUnchanged(originalConfigPath, configSourceSha256);
    if (await runtimeSourceFingerprint({ sourceRoot: absoluteSourceRoot }) !== sourceSha256) {
      throw new Error("Runtime source changed while the snapshot was being created");
    }
    await rename(staging, destination);
    published = true;
    const verified = await verifyRuntimeSnapshot({ runtimeDirectory: destination });
    const bootstrap = await installRuntimeBootstrap(absoluteSourceRoot, normalized.dataDirectory);
    if (await runtimeSourceFingerprint({ sourceRoot: absoluteSourceRoot }) !== sourceSha256) {
      throw new Error("Runtime source changed before snapshot publication completed");
    }
    return {
      runtimeDirectory: destination,
      mainPath: path.join(destination, "src", "main.js"),
      configPath: path.join(destination, "bridge.config.json"),
      manifestPath: path.join(destination, "runtime-manifest.json"),
      manifestSha256: verified.manifestSha256,
      configSource: originalConfigPath,
      configSourceSha256,
      sourceSha256,
      ...bootstrap,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (published) await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
