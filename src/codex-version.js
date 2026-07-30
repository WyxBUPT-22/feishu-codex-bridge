import { readFileSync } from "node:fs";
import { collectCommand } from "./process-utils.js";

const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const SUPPORTED_CODEX_VERSION = packageManifest.bridgeToolchain?.codex;

if (!/^\d+\.\d+\.\d+$/.test(SUPPORTED_CODEX_VERSION ?? "")) {
  throw new Error("package.json bridgeToolchain.codex must be an exact semantic version");
}

export function parseCodexVersion(output) {
  const text = String(output ?? "").trim();
  const match = /\bcodex-cli\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(text);
  if (!match) {
    throw new Error(`Unable to determine Codex CLI version from: ${text || "empty output"}`);
  }
  return match[1];
}

export function assertSupportedCodexVersion(output) {
  const version = parseCodexVersion(output);
  if (version !== SUPPORTED_CODEX_VERSION) {
    throw new Error(
      `Unsupported Codex CLI version ${version}; required exactly ${SUPPORTED_CODEX_VERSION}`,
    );
  }
  return `codex-cli ${version}`;
}

export async function requireSupportedCodexVersion(codexTool, { signal } = {}) {
  const result = await collectCommand(codexTool, ["--version"], {
    timeoutMs: 15_000,
    signal,
  });
  return assertSupportedCodexVersion(`${result.stdout}\n${result.stderr}`);
}
