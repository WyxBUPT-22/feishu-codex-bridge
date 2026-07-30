import { PRE_TOOL_APPROVAL_METHOD } from "./approval-broker.js";

function commandText(request) {
  const input = request?.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  for (const key of ["command", "cmd"]) {
    if (typeof input[key] === "string" && input[key].trim()) return input[key];
  }
  return null;
}

export async function handleHookApproval(request, approvalBroker) {
  if (!approvalBroker || request?.hook_event_name !== "PreToolUse") {
    return { approved: false, reason: "approval service is not ready" };
  }
  const response = await approvalBroker.handle({
    method: PRE_TOOL_APPROVAL_METHOD,
    params: {
      threadId: request.session_id,
      turnId: request.turn_id,
      itemId: request.tool_use_id,
      cwd: request.cwd,
      toolName: request.tool_name,
      toolInput: request.tool_input,
      command: commandText(request),
    },
  });
  return response?.decision === "accept"
    ? { approved: true }
    : { approved: false, reason: "operation was not approved" };
}

export function isFailedApprovalHook(params) {
  return params?.run?.eventName === "preToolUse" && params.run.status === "failed";
}
