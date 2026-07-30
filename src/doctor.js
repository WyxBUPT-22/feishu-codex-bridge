import { access } from "node:fs/promises";
import { requireSupportedCodexVersion } from "./codex-version.js";
import { collectCommand } from "./process-utils.js";
import { machineEnvironment } from "./lark-client.js";
import { requireSupportedLarkCliVersion } from "./lark-version.js";
import { startIsolatedAppServer } from "./isolated-app-server.js";
import { HookApprovalServer } from "./hook-approval-server.js";

function profileArgs(config) {
  return config.lark.profile ? ["--profile", config.lark.profile] : [];
}

export async function stopDoctorResources(client, hookServer) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => client?.stop()),
    Promise.resolve().then(() => hookServer?.stop()),
  ]);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Doctor resource cleanup failed");
  }
}

export async function runDoctor({ config, larkTool, codexTool }) {
  const checks = [];
  async function check(name, task) {
    try {
      const detail = await task();
      checks.push({ name, ok: true, detail });
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
    }
  }

  await check("configuration", async () => config.configPath);
  for (const [alias, repository] of Object.entries(config.repositories)) {
    await check(`repository:${alias}`, async () => {
      await access(repository.path);
      return repository.path;
    });
  }
  await check("lark-cli", async () => {
    return requireSupportedLarkCliVersion(larkTool, {
      env: machineEnvironment(),
    });
  });
  await check("lark-config", async () => {
    await collectCommand(
      larkTool,
      [...profileArgs(config), "config", "show"],
      { env: machineEnvironment(), timeoutMs: 15_000 },
    );
    return "configured";
  });
  await check("codex-auth", async () => {
    const result = await collectCommand(codexTool, ["login", "status"], {
      timeoutMs: 15_000,
      allowFailure: true,
    });
    if (result.code !== 0) {
      throw new Error((result.stderr || result.stdout).trim() || "Codex is not authenticated");
    }
    return "authenticated";
  });
  await check("codex-cli", async () => {
    return requireSupportedCodexVersion(codexTool);
  });
  if (config.codex.appServer.enabled) {
    await check("codex-app-server", async () => {
      const cwd = config.repositories[config.defaultRepository].path;
      const hookServer = new HookApprovalServer(async () => ({
        approved: false,
        reason: "doctor probe only",
      }), { logger: { error() {} } });
      const hookEndpoint = await hookServer.start();
      let client;
      let operationError = null;
      try {
        client = await startIsolatedAppServer(codexTool, {
          cwd: process.cwd(),
          repositoryPath: cwd,
          hookEndpoint,
        });
        const threads = await client.listThreads({ cwd, limit: 1 });
        return `ready; ${threads.data.length} recent thread(s) sampled; remote capabilities isolated; approval hook active`;
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        try {
          await stopDoctorResources(client, hookServer);
        } catch (cleanupError) {
          if (!operationError) throw cleanupError;
          if (operationError instanceof Error && operationError.cause === undefined) {
            operationError.cause = cleanupError;
          }
        }
      }
    });
  }
  checks.push({
    name: "codex-read-isolation",
    ok: true,
    warning: true,
    detail: "workspace-write restricts writes, not reads; use a separate OS user or container for strong credential isolation",
  });
  return checks;
}

export function formatDoctor(checks) {
  return checks
    .map((check) => `${check.warning ? "WARN" : check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`)
    .join("\n");
}
