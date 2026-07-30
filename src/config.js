import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOXES = new Set(["read-only", "workspace-write"]);
const APPROVAL_POLICIES = new Set(["never"]);
const MESSAGE_TYPES = new Set(["text", "post"]);
const REPOSITORY_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;
const MODEL_PROVIDER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Invalid configuration: ${message}`);
  }
}

function normalizeStringArray(value, name, { allowEmpty = true } = {}) {
  assert(Array.isArray(value), `${name} must be an array`);
  const normalized = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  assert(allowEmpty || normalized.length > 0, `${name} must not be empty`);
  return normalized;
}

export function defaultDataDirectory() {
  const stateRoot = process.platform === "win32"
    ? process.env.LOCALAPPDATA ?? os.homedir()
    : process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(stateRoot, "feishu-codex-bridge");
}

export function canonicalConfigPath(dataDirectory = defaultDataDirectory()) {
  return path.join(path.resolve(dataDirectory), "config", "bridge.config.json");
}

function samePath(left, right) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === "win32"
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function comparableConfig(config) {
  const { configPath: _configPath, ...comparable } = config;
  return comparable;
}

function configDigest(config) {
  return createHash("sha256")
    .update(JSON.stringify(comparableConfig(config)))
    .digest("hex");
}

async function fileDigest(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function inspectCanonicalConfig({
  configPath = canonicalConfigPath(),
  shadowConfigPath = null,
} = {}) {
  const absoluteConfigPath = path.resolve(configPath);
  const config = await loadConfig(absoluteConfigPath);
  const expectedPath = canonicalConfigPath(config.dataDirectory);
  if (!samePath(absoluteConfigPath, expectedPath)) {
    throw new Error(
      `Production configuration must use the canonical path: ${expectedPath}`,
    );
  }

  const sourceSha256 = await fileDigest(absoluteConfigPath);
  const absoluteShadowPath = shadowConfigPath ? path.resolve(shadowConfigPath) : null;
  if (absoluteShadowPath && !samePath(absoluteShadowPath, absoluteConfigPath)) {
    let shadow;
    try {
      shadow = await loadConfig(absoluteShadowPath);
    } catch (error) {
      if (!/Configuration not found:/.test(error.message)) throw error;
    }
    if (shadow && configDigest(shadow) !== configDigest(config)) {
      throw new Error(
        `Configuration drift detected between canonical ${absoluteConfigPath} `
        + `and workspace shadow ${absoluteShadowPath}`,
      );
    }
  }

  return {
    config,
    configPath: absoluteConfigPath,
    expectedPath,
    sourceSha256,
    shadowConfigPath: absoluteShadowPath,
  };
}

export async function assertConfigSourceUnchanged(configPath, expectedSha256) {
  const actualSha256 = await fileDigest(path.resolve(configPath));
  if (actualSha256 !== expectedSha256) {
    throw new Error("Canonical configuration changed during deployment; retry from preflight");
  }
  return actualSha256;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function loadConfig(configPath = process.env.FEISHU_CODEX_CONFIG ?? "bridge.config.json") {
  const absolutePath = path.resolve(configPath);
  let raw;
  try {
    raw = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Configuration not found: ${absolutePath}. Copy bridge.config.example.json to bridge.config.json.`);
    }
    throw new Error(`Cannot read configuration ${absolutePath}: ${error.message}`);
  }
  return normalizeConfig(raw, absolutePath);
}

export function normalizeConfig(raw, configPath = path.resolve("bridge.config.json")) {
  assert(raw && typeof raw === "object", "root must be an object");
  assert(raw.version === 1, "version must be 1");
  assert(raw.lark && typeof raw.lark === "object", "lark is required");

  const allowedSenders = normalizeStringArray(raw.lark.allowedSenders, "lark.allowedSenders", {
    allowEmpty: false,
  });
  assert(
    allowedSenders.every((id) => /^ou_[a-zA-Z0-9_-]+$/.test(id)),
    "every lark.allowedSenders entry must be an ou_ open_id",
  );
  const allowedChats = normalizeStringArray(raw.lark.allowedChats ?? [], "lark.allowedChats");
  assert(
    allowedChats.every((id) => /^oc_[a-zA-Z0-9_-]+$/.test(id)),
    "every lark.allowedChats entry must be an oc_ chat_id",
  );
  const workbenchChats = normalizeStringArray(
    raw.lark.workbenchChats ?? [],
    "lark.workbenchChats",
  );
  assert(
    workbenchChats.every((id) => /^oc_[a-zA-Z0-9_-]+$/.test(id)),
    "every lark.workbenchChats entry must be an oc_ chat_id",
  );
  assert(
    workbenchChats.every((id) => allowedChats.includes(id)),
    "every lark.workbenchChats entry must also appear in lark.allowedChats",
  );

  assert(raw.repositories && typeof raw.repositories === "object", "repositories is required");
  const repositories = {};
  for (const [alias, repository] of Object.entries(raw.repositories)) {
    assert(REPOSITORY_ALIAS.test(alias), `invalid repository alias: ${alias}`);
    assert(repository && typeof repository.path === "string", `repositories.${alias}.path is required`);
    assert(path.isAbsolute(repository.path), `repositories.${alias}.path must be absolute`);
    const repositoryPath = path.resolve(repository.path);
    repositories[alias] = { path: repositoryPath };
  }
  assert(Object.keys(repositories).length > 0, "at least one repository is required");
  assert(repositories[raw.defaultRepository], "defaultRepository must name a configured repository");

  const p2pOnly = raw.lark.p2pOnly !== false;
  assert(
    p2pOnly || workbenchChats.length > 0,
    "lark.workbenchChats must not be empty when p2pOnly is false",
  );
  const allowedMessageTypes = normalizeStringArray(
    raw.lark.allowedMessageTypes ?? ["text", "post"],
    "lark.allowedMessageTypes",
    { allowEmpty: false },
  );
  assert(
    allowedMessageTypes.every((type) => MESSAGE_TYPES.has(type)),
    "lark.allowedMessageTypes may only contain text or post",
  );

  const sandbox = raw.codex?.sandbox ?? "workspace-write";
  const approvalPolicy = raw.codex?.approvalPolicy ?? "never";
  assert(SANDBOXES.has(sandbox), "codex.sandbox must be read-only or workspace-write");
  assert(APPROVAL_POLICIES.has(approvalPolicy), "codex.approvalPolicy must be never for remote operation");

  const provider = raw.codex?.provider ?? null;
  if (provider) {
    assert(provider && typeof provider === "object", "codex.provider must be an object");
    assert(MODEL_PROVIDER_NAME.test(provider.id), "codex.provider.id is invalid");
    assert(typeof provider.name === "string" && provider.name.trim(), "codex.provider.name is required");
    let providerUrl;
    try {
      providerUrl = new URL(provider.baseUrl);
    } catch {
      throw new Error("Invalid configuration: codex.provider.baseUrl must be a valid URL");
    }
    assert(providerUrl.protocol === "https:", "codex.provider.baseUrl must use https");
    assert(provider.wireApi === "responses", "codex.provider.wireApi must be responses");
    assert(provider.requiresOpenAIAuth === true, "codex.provider.requiresOpenAIAuth must be true");
  }

  const baseDirectory = path.dirname(configPath);
  const dataDirectory = raw.dataDirectory
    ? path.resolve(baseDirectory, raw.dataDirectory)
    : defaultDataDirectory();
  for (const [alias, repository] of Object.entries(repositories)) {
    assert(
      !isWithin(repository.path, dataDirectory),
      `dataDirectory must be outside managed repository ${alias}`,
    );
  }
  const maxRuntimeMinutes = Number(raw.codex?.maxRuntimeMinutes ?? 60);
  const concurrency = Number(raw.queue?.concurrency ?? 1);
  const maxPromptChars = Number(raw.limits?.maxPromptChars ?? 8000);
  const maxReplyChars = Number(raw.limits?.maxReplyChars ?? 12000);
  const processedMessageLimit = Number(raw.limits?.processedMessageLimit ?? 2000);
  const storedJobLimit = Number(raw.limits?.storedJobLimit ?? 500);
  const desktopSyncPollIntervalMs = Number(raw.desktopSync?.pollIntervalMs ?? 5_000);
  const maxMessageAgeMinutes = Number(raw.lark.maxMessageAgeMinutes ?? 10);
  const appServerEnabled = raw.codex?.appServer?.enabled !== false;
  if (raw.runtimeSnapshot != null) {
    assert(raw.runtimeSnapshot && typeof raw.runtimeSnapshot === "object", "runtimeSnapshot must be an object");
    assert(raw.runtimeSnapshot.required === true, "runtimeSnapshot.required must be true when present");
  }

  assert(Number.isFinite(maxRuntimeMinutes) && maxRuntimeMinutes >= 1, "codex.maxRuntimeMinutes must be positive");
  assert(Number.isInteger(concurrency) && concurrency === 1, "queue.concurrency must be 1 for remote operation");
  assert(Number.isInteger(maxPromptChars) && maxPromptChars >= 100, "limits.maxPromptChars is too small");
  assert(Number.isInteger(maxReplyChars) && maxReplyChars >= 500, "limits.maxReplyChars is too small");
  assert(Number.isInteger(processedMessageLimit) && processedMessageLimit >= 100, "limits.processedMessageLimit is too small");
  assert(Number.isInteger(storedJobLimit) && storedJobLimit >= 100, "limits.storedJobLimit is too small");
  assert(
    Number.isInteger(desktopSyncPollIntervalMs)
      && desktopSyncPollIntervalMs >= 1_000
      && desktopSyncPollIntervalMs <= 60_000,
    "desktopSync.pollIntervalMs must be an integer between 1000 and 60000",
  );
  assert(Number.isFinite(maxMessageAgeMinutes) && maxMessageAgeMinutes >= 1, "lark.maxMessageAgeMinutes must be positive");

  return {
    version: 1,
    configPath,
    dataDirectory,
    lark: {
      profile: raw.lark.profile ? String(raw.lark.profile) : null,
      allowedSenders,
      allowedChats,
      workbenchChats,
      p2pOnly,
      allowedMessageTypes,
      maxMessageAgeMinutes,
    },
    repositories,
    defaultRepository: raw.defaultRepository,
    codex: {
      sandbox,
      approvalPolicy,
      model: raw.codex?.model ? String(raw.codex.model) : null,
      provider: provider
        ? {
            id: provider.id,
            name: provider.name.trim(),
            baseUrl: provider.baseUrl,
            wireApi: provider.wireApi,
            requiresOpenAIAuth: true,
          }
        : null,
      maxRuntimeMinutes,
      entry: raw.codex?.entry ? String(raw.codex.entry) : null,
      appServer: { enabled: appServerEnabled },
    },
    larkCliEntry: raw.larkCliEntry ? String(raw.larkCliEntry) : null,
    runtimeSnapshot: { required: raw.runtimeSnapshot?.required === true },
    queue: { concurrency },
    desktopSync: { pollIntervalMs: desktopSyncPollIntervalMs },
    limits: { maxPromptChars, maxReplyChars, processedMessageLimit, storedJobLimit },
  };
}
