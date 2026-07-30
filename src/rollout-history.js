import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const THREAD_ID = /^[a-f0-9]{8}-[a-f0-9-]{27}$/i;

async function findRollout(directory, suffix) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) return entryPath;
    if (entry.isDirectory()) {
      const found = await findRollout(entryPath, suffix);
      if (found) return found;
    }
  }
  return null;
}

export async function rolloutForkCutoff(threadId, {
  codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
} = {}) {
  if (!THREAD_ID.test(threadId)) return null;
  const suffix = `${threadId.toLowerCase()}.jsonl`;
  let rolloutPath = null;
  for (const directory of ["sessions", "archived_sessions"]) {
    rolloutPath = await findRollout(path.join(codexHome, directory), suffix);
    if (rolloutPath) break;
  }
  if (!rolloutPath) return null;

  const turns = [];
  const byId = new Map();
  const lines = (await readFile(rolloutPath, "utf8")).split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "event_msg") continue;
    const event = record.payload;
    const turnId = event?.turn_id;
    if (!turnId) continue;
    if (event.type === "task_started") {
      if (!byId.has(turnId)) {
        const turn = { id: turnId, terminal: false };
        turns.push(turn);
        byId.set(turnId, turn);
      }
    } else if (event.type === "task_complete" || event.type === "turn_aborted") {
      const turn = byId.get(turnId);
      if (turn) turn.terminal = true;
    }
  }

  const oldestResidualIndex = turns.findIndex((turn) => !turn.terminal);
  if (oldestResidualIndex < 0) return { rolloutPath, hasResidual: false, lastTurnId: null };
  for (let index = oldestResidualIndex - 1; index >= 0; index -= 1) {
    if (turns[index].terminal) {
      return { rolloutPath, hasResidual: true, lastTurnId: turns[index].id };
    }
  }
  return { rolloutPath, hasResidual: true, lastTurnId: null };
}
