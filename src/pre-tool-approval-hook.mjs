import net from "node:net";
import { writeSync } from "node:fs";
import {
  HOOK_CLIENT_TIMEOUT_MS,
  HOOK_IPC_MAX_BYTES,
  hookEndpointPath,
  isApprovalCapableTool,
} from "./hook-approval-server.js";

function emergencyBlock() {
  try {
    writeSync(2, "PreToolUse approval hook failed closed\n");
  } finally {
    process.exit(2);
  }
}

process.once("uncaughtException", emergencyBlock);
process.once("unhandledRejection", emergencyBlock);
process.stdout.once("error", emergencyBlock);
process.once("exit", (code) => {
  if (code === 0 || code === 2) return;
  try {
    writeSync(2, "PreToolUse approval hook exited unexpectedly\n");
  } finally {
    process.exitCode = 2;
  }
});

function safeReason(value, fallback) {
  const reason = typeof value === "string" ? value.trim() : "";
  return (reason || fallback).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2_000);
}

function hookOutput(approved, toolInput, reason) {
  const hookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision: approved ? "allow" : "deny",
  };
  if (approved) {
    hookSpecificOutput.updatedInput = toolInput;
  } else {
    hookSpecificOutput.permissionDecisionReason = safeReason(reason, "approval denied");
  }
  return { hookSpecificOutput };
}

function writeOutput(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > HOOK_IPC_MAX_BYTES) throw new Error("PreToolUse input exceeds size limit");
    chunks.push(data);
  }
  if (bytes === 0) throw new Error("PreToolUse input is empty");
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new Error("PreToolUse input is not valid JSON");
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)
      || request.hook_event_name !== "PreToolUse"
      || typeof request.session_id !== "string" || request.session_id.length === 0
      || typeof request.turn_id !== "string" || request.turn_id.length === 0
      || typeof request.tool_use_id !== "string" || request.tool_use_id.length === 0
      || typeof request.cwd !== "string" || request.cwd.length === 0
      || typeof request.tool_name !== "string"
      || !Object.prototype.hasOwnProperty.call(request, "tool_input")
      || request.tool_input === null || typeof request.tool_input !== "object"
      || Array.isArray(request.tool_input)) {
    throw new Error("PreToolUse input is malformed");
  }
  return request;
}

function approvalRequest(endpoint, request) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let response = null;
    let receivedLine = false;
    let settled = false;
    const socket = net.createConnection(hookEndpointPath(endpoint));
    const timer = setTimeout(() => fail(new Error("approval service timed out")), HOOK_CLIENT_TIMEOUT_MS);
    timer.unref?.();

    const cleanup = () => clearTimeout(timer);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const succeed = (response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };

    socket.once("connect", () => {
      let message;
      try {
        message = `${JSON.stringify(request)}\n`;
      } catch {
        fail(new Error("PreToolUse input cannot be serialized"));
        return;
      }
      if (Buffer.byteLength(message) > HOOK_IPC_MAX_BYTES) {
        fail(new Error("PreToolUse input exceeds size limit"));
        return;
      }
      socket.write(message, (error) => {
        if (error) fail(new Error("approval service write failed"));
      });
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      if (receivedLine) {
        fail(new Error("approval service returned multiple responses"));
        return;
      }
      if (buffer.length + chunk.length > HOOK_IPC_MAX_BYTES) {
        fail(new Error("approval response exceeds size limit"));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) {
        fail(new Error("approval service returned multiple responses"));
        return;
      }
      try {
        response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        fail(new Error("approval service returned invalid JSON"));
        return;
      }
      if (response === null || typeof response !== "object" || Array.isArray(response)) {
        fail(new Error("approval service returned an invalid response"));
        return;
      }
      receivedLine = true;
    });
    socket.once("error", () => fail(new Error("approval service is unavailable")));
    socket.once("end", () => {
      if (settled) return;
      if (receivedLine) succeed(response);
      else fail(new Error("approval service closed without a decision"));
    });
  });
}

async function main() {
  let request;
  try {
    request = await readInput();
  } catch (error) {
    writeOutput(hookOutput(false, null, error.message));
    return;
  }

  if (!isApprovalCapableTool(request.tool_name)) {
    writeOutput(hookOutput(false, null, "tool is not eligible for approval"));
    return;
  }
  const endpoint = process.argv[2];
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    writeOutput(hookOutput(false, null, "approval service endpoint is missing"));
    return;
  }

  try {
    const decision = await approvalRequest(endpoint, request);
    if (decision.approved === true) {
      writeOutput(hookOutput(true, request.tool_input));
    } else {
      writeOutput(hookOutput(false, null, decision.reason));
    }
  } catch (error) {
    writeOutput(hookOutput(false, null, error.message));
  }
}

try {
  await main();
} catch {
  try {
    writeOutput(hookOutput(false, null, "approval hook failed"));
  } catch {
    emergencyBlock();
  }
}
