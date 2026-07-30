const BASE_OVERRIDES = [
  ["mcp_servers", "{}"],
  ["plugins", "{}"],
  ["marketplaces", "{}"],
  ["apps", "{}"],
  ["notify", "[]"],
  ["hooks", "{}"],
  ["allow_login_shell", "false"],
  ["tools.web_search", "false"],
  ["web_search", "\"disabled\""],
  ["include_apps_instructions", "false"],
  ["skills.include_instructions", "false"],
  ["orchestrator.skills.enabled", "false"],
  ["orchestrator.mcp.enabled", "false"],
  ["apps._default.enabled", "false"],
  ["apps._default.destructive_enabled", "false"],
  ["apps._default.open_world_enabled", "false"],
  ["features.apps", "false"],
  ["features.auth_elicitation", "false"],
  ["features.browser_use", "false"],
  ["features.computer_use", "false"],
  ["features.hooks", "false"],
  ["features.image_generation", "false"],
  ["features.in_app_browser", "false"],
  ["features.multi_agent", "false"],
  ["features.multi_agent_v2", "false"],
  ["features.plugins", "false"],
  ["features.remote_plugin", "false"],
  ["features.request_permissions_tool", "false"],
  ["features.tool_suggest", "false"],
  ["features.workspace_dependencies", "false"],
];

export const APPROVAL_HOOK_MATCHER = "^(?:Bash|bash|apply_patch|exec_command|shell|shell_command|unified_exec)$";

function configArgs(entries) {
  return entries.flatMap(([key, value]) => ["--config", `${key}=${value}`]);
}

function tomlString(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Hook command must be a non-empty string");
  }
  return JSON.stringify(value);
}

function emptyRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

export function isolationArgs({ hookCommand, hookCommandWindows = null, hookTimeoutSeconds }) {
  if (!Number.isSafeInteger(hookTimeoutSeconds) || hookTimeoutSeconds < 1) {
    throw new RangeError("Hook timeout must be a positive integer");
  }
  const handlerFields = [
    'type="command"',
    `command=${tomlString(hookCommand)}`,
    ...(hookCommandWindows ? [`command_windows=${tomlString(hookCommandWindows)}`] : []),
    `timeout=${hookTimeoutSeconds}`,
  ];
  const hookValue = `[{matcher=${tomlString(APPROVAL_HOOK_MATCHER)},hooks=[{${handlerFields.join(",")}}]}]`;
  return [
    ...configArgs(BASE_OVERRIDES),
    ...configArgs([
      ["features.hooks", "true"],
      ["hooks.PreToolUse", hookValue],
    ]),
  ];
}

function expectedHook(config, expected) {
  const eventNames = Object.entries(config?.hooks ?? {})
    .filter(([, groups]) => Array.isArray(groups) && groups.length > 0)
    .map(([eventName]) => eventName);
  if (eventNames.length !== 1 || eventNames[0] !== "PreToolUse") return false;
  const groups = config.hooks.PreToolUse;
  if (!Array.isArray(groups) || groups.length !== 1) return false;
  const group = groups[0];
  if (group?.matcher !== APPROVAL_HOOK_MATCHER
    || !Array.isArray(group.hooks) || group.hooks.length !== 1) return false;
  const handler = group.hooks[0];
  return handler?.type === "command"
    && handler.command === expected.hookCommand
    && (handler.commandWindows ?? null) === (expected.hookCommandWindows ?? null)
    && handler.timeout === expected.hookTimeoutSeconds;
}

export function assertIsolatedConfig(config, expected) {
  const violations = [];
  if (!emptyRecord(config?.mcp_servers)) violations.push("MCP servers not empty");
  if (!emptyRecord(config?.plugins)) violations.push("plugins not empty");
  if (!emptyRecord(config?.marketplaces)) violations.push("marketplaces not empty");
  const appNames = Object.keys(config?.apps ?? {}).filter((name) => name !== "_default");
  if (appNames.length > 0) violations.push(`apps present: ${appNames.join(", ")}`);
  if (!Array.isArray(config?.notify) || config.notify.length > 0) violations.push("notify not empty");
  if (config?.allow_login_shell !== false) violations.push("login shell enabled");
  if (config?.tools?.web_search !== null) violations.push("web search tool not disabled");
  if (config?.web_search !== "disabled") violations.push(`web_search=${config?.web_search}`);
  if (config?.include_apps_instructions !== false) violations.push("app instructions not disabled");
  if (config?.skills?.include_instructions !== false) violations.push("skill instructions");
  if (config?.orchestrator?.skills?.enabled !== false) violations.push("orchestrator skills");
  if (config?.orchestrator?.mcp?.enabled !== false) violations.push("orchestrator MCP");
  if (config?.apps?._default?.enabled !== false) violations.push("apps default");
  if (config?.apps?._default?.destructive_enabled !== false) violations.push("destructive apps default");
  if (config?.apps?._default?.open_world_enabled !== false) violations.push("open-world apps default");
  const disabledFeatures = [
    "apps",
    "auth_elicitation",
    "browser_use",
    "computer_use",
    "image_generation",
    "in_app_browser",
    "multi_agent",
    "multi_agent_v2",
    "plugins",
    "remote_plugin",
    "request_permissions_tool",
    "tool_suggest",
    "workspace_dependencies",
  ];
  const enabledFeatures = disabledFeatures.filter((feature) => config?.features?.[feature] !== false);
  if (enabledFeatures.length > 0) violations.push(`features: ${enabledFeatures.join(", ")}`);
  if (config?.features?.hooks !== true) violations.push("approval hook feature disabled");
  if (!expected || !expectedHook(config, expected)) violations.push("approval hook mismatch");
  if (violations.length > 0) {
    throw new Error(`Codex app-server isolation failed (${violations.join("; ")})`);
  }
}

export function assertIsolatedHookList(
  response,
  expected,
  { allowedTrustStatuses = ["trusted"] } = {},
) {
  const entries = response?.data;
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error("Codex app-server isolation failed (hook discovery mismatch)");
  }
  const entry = entries[0];
  if ((entry.errors?.length ?? 0) > 0 || (entry.warnings?.length ?? 0) > 0) {
    throw new Error("Codex app-server isolation failed (hook discovery reported errors)");
  }
  if (!Array.isArray(entry.hooks) || entry.hooks.length !== 1) {
    throw new Error("Codex app-server isolation failed (unexpected hook count)");
  }
  const hook = entry.hooks[0];
  const selectedCommand = expected.hookCommandWindows ?? expected.hookCommand;
  const validTrust = allowedTrustStatuses.includes(hook?.trustStatus);
  if (hook?.eventName !== "preToolUse"
    || hook.handlerType !== "command"
    || hook.matcher !== APPROVAL_HOOK_MATCHER
    || hook.command !== selectedCommand
    || Number(hook.timeoutSec) !== expected.hookTimeoutSeconds
    || hook.enabled !== true
    || hook.source !== "sessionFlags"
    || hook.isManaged !== false
    || !validTrust
    || typeof hook.currentHash !== "string" || hook.currentHash.length === 0) {
    throw new Error("Codex app-server isolation failed (approval hook is not active)");
  }
  return hook;
}
