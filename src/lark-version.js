import { readFileSync } from "node:fs";
import { collectCommand } from "./process-utils.js";

const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const SUPPORTED_LARK_CLI_VERSION = packageManifest.bridgeToolchain?.larkCli;

if (!/^\d+\.\d+\.\d+$/.test(SUPPORTED_LARK_CLI_VERSION ?? "")) {
  throw new Error("package.json bridgeToolchain.larkCli must be an exact semantic version");
}

export function parseLarkCliVersion(output) {
  const text = String(output ?? "").trim();
  const match = /\blark-cli(?:\s+version)?\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(text);
  if (!match) {
    throw new Error(`Unable to determine Feishu CLI version from: ${text || "empty output"}`);
  }
  return match[1];
}

export function assertSupportedLarkCliVersion(output) {
  const version = parseLarkCliVersion(output);
  if (version !== SUPPORTED_LARK_CLI_VERSION) {
    throw new Error(
      `Unsupported Feishu CLI version ${version}; required exactly ${SUPPORTED_LARK_CLI_VERSION}`,
    );
  }
  return `lark-cli ${version}`;
}

export async function requireSupportedLarkCliVersion(larkTool, { signal, env } = {}) {
  const result = await collectCommand(larkTool, ["--version"], {
    env,
    timeoutMs: 15_000,
    signal,
  });
  return assertSupportedLarkCliVersion(`${result.stdout}\n${result.stderr}`);
}
