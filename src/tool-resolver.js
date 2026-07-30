import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TOOL_PATHS = {
  lark: {
    displayName: "lark-cli",
    windowsCandidates: [
      ["npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe"],
      ["npm", "node_modules", "@larksuite", "cli", "scripts", "run.js"],
    ],
    executable: "lark-cli",
  },
  codex: {
    displayName: "codex",
    windowsCandidates: [
      [
        "npm",
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        "x86_64-pc-windows-msvc",
        "bin",
        "codex.exe",
      ],
      ["npm", "node_modules", "@openai", "codex", "bin", "codex.js"],
    ],
    executable: "codex",
  },
};

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveTool(tool, override) {
  const definition = TOOL_PATHS[tool];
  if (!definition) {
    throw new Error(`Unknown tool: ${tool}`);
  }

  if (override) {
    const resolved = path.resolve(override);
    if (!(await exists(resolved))) {
      throw new Error(`${definition.displayName} entry does not exist: ${resolved}`);
    }
    return resolved.endsWith(".js")
      ? { command: process.execPath, prefixArgs: [resolved], displayName: definition.displayName }
      : { command: resolved, prefixArgs: [], displayName: definition.displayName };
  }

  if (process.platform === "win32" && process.env.APPDATA) {
    for (const candidate of definition.windowsCandidates) {
      const entry = path.join(process.env.APPDATA, ...candidate);
      if (await exists(entry)) {
        return entry.endsWith(".js")
          ? { command: process.execPath, prefixArgs: [entry], displayName: definition.displayName }
          : { command: entry, prefixArgs: [], displayName: definition.displayName };
      }
    }
  }

  return {
    command: definition.executable,
    prefixArgs: [],
    displayName: definition.displayName,
  };
}
