import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_HOOK_MATCHER,
  assertIsolatedConfig,
  assertIsolatedHookList,
  isolationArgs,
} from "../src/app-server-isolation.js";

const expectedHook = {
  hookCommand: "node /isolated/pre-tool-approval-hook.mjs endpoint",
  hookCommandWindows: "cmd.exe /c C:\\isolated\\pre-tool-approval-hook.cmd",
  hookTimeoutSeconds: 330,
};

test("clears external capability tables before the first app-server starts", () => {
  const args = isolationArgs(expectedHook);
  assert.ok(args.includes("mcp_servers={}"));
  assert.ok(args.includes("plugins={}"));
  assert.ok(args.includes("marketplaces={}"));
  assert.ok(args.includes("apps={}"));
  assert.ok(args.includes("hooks={}"));
  assert.ok(args.includes("allow_login_shell=false"));
  assert.ok(args.includes("tools.web_search=false"));
  assert.ok(args.includes("orchestrator.skills.enabled=false"));
  assert.ok(args.includes("orchestrator.mcp.enabled=false"));
  assert.ok(args.includes("apps._default.enabled=false"));
  assert.ok(args.includes("features.hooks=true"));
  assert.ok(args.some((value) => value.startsWith("hooks.PreToolUse=")));
});

test("accepts a fully isolated effective configuration", () => {
  assert.doesNotThrow(() => assertIsolatedConfig({
    mcp_servers: {},
    plugins: {},
    marketplaces: {},
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    },
    notify: [],
    allow_login_shell: false,
    tools: { web_search: null },
    hooks: {
      PreToolUse: [{
        matcher: APPROVAL_HOOK_MATCHER,
        hooks: [{
          type: "command",
          command: expectedHook.hookCommand,
          commandWindows: expectedHook.hookCommandWindows,
          timeout: expectedHook.hookTimeoutSeconds,
        }],
      }],
    },
    web_search: "disabled",
    include_apps_instructions: false,
    skills: { include_instructions: false },
    orchestrator: { skills: { enabled: false }, mcp: { enabled: false } },
    features: {
      apps: false,
      auth_elicitation: false,
      browser_use: false,
      computer_use: false,
      hooks: true,
      image_generation: false,
      in_app_browser: false,
      multi_agent: false,
      multi_agent_v2: false,
      plugins: false,
      remote_plugin: false,
      request_permissions_tool: false,
      tool_suggest: false,
      workspace_dependencies: false,
    },
  }, expectedHook));
});

test("accepts exactly one enabled discovered approval hook", () => {
  assert.doesNotThrow(() => assertIsolatedHookList({
    data: [{
      cwd: "C:\\repo",
      warnings: [],
      errors: [],
      hooks: [{
        eventName: "preToolUse",
        handlerType: "command",
        matcher: APPROVAL_HOOK_MATCHER,
        command: expectedHook.hookCommandWindows,
        timeoutSec: expectedHook.hookTimeoutSeconds,
        enabled: true,
        source: "sessionFlags",
        isManaged: false,
        trustStatus: "trusted",
        currentHash: "abc123",
      }],
    }],
  }, expectedHook));
});

test("rejects inactive, modified, or additional hooks", () => {
  for (const hook of [
    { enabled: false, trustStatus: "untrusted" },
    { enabled: true, trustStatus: "modified" },
  ]) {
    assert.throws(() => assertIsolatedHookList({
      data: [{
        warnings: [], errors: [],
        hooks: [{
          eventName: "preToolUse",
          handlerType: "command",
          matcher: APPROVAL_HOOK_MATCHER,
          command: expectedHook.hookCommandWindows,
          timeoutSec: expectedHook.hookTimeoutSeconds,
          currentHash: "hash",
          source: "sessionFlags",
          isManaged: false,
          ...hook,
        }],
      }],
    }, expectedHook), /approval hook is not active/);
  }
  assert.throws(() => assertIsolatedHookList({ data: [] }, expectedHook), /discovery mismatch/);
});

test("rejects any external capability remaining after isolation", () => {
  assert.throws(() => assertIsolatedConfig({
    mcp_servers: { unsafe: { enabled: false } },
    plugins: {},
    marketplaces: {},
    apps: { _default: { enabled: false } },
    skills: { include_instructions: false },
    orchestrator: { skills: { enabled: false }, mcp: { enabled: false } },
    features: {},
    web_search: "disabled",
  }, expectedHook), /MCP servers not empty/);
});

test("fails closed when a disabled capability field is absent", () => {
  assert.throws(() => assertIsolatedConfig({}, expectedHook), /MCP servers not empty/);
});
