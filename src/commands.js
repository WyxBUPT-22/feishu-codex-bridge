const COMMAND_PATTERN = /^\/(\S+)(?:\s+([\s\S]*))?$/;

export function parseCommand(content) {
  const text = String(content ?? "").trim();
  const match = COMMAND_PATTERN.exec(text);
  if (!match) {
    return { type: "invalid", reason: "command_required" };
  }
  const name = match[1].toLowerCase();
  const argument = (match[2] ?? "").trim();
  switch (name) {
    case "help":
    case "status":
    case "repos":
    case "sessions":
      return { type: name };
    case "repo":
      return argument ? { type: "repo", alias: argument } : { type: "invalid", reason: "repository_required" };
    case "approval": {
      if (!argument) return { type: "approval", mode: null };
      const mode = argument.toLowerCase();
      return ["strict", "balanced", "auto"].includes(mode)
        ? { type: "approval", mode }
        : { type: "invalid", reason: "approval_mode_invalid" };
    }
    case "start": {
      const separator = argument.search(/\s/);
      if (separator < 1) {
        return { type: "invalid", reason: "start_arguments_required" };
      }
      const alias = argument.slice(0, separator).trim();
      const prompt = argument.slice(separator).trim();
      return alias && prompt
        ? { type: "start", alias, prompt }
        : { type: "invalid", reason: "start_arguments_required" };
    }
    case "new":
      return { type: "new" };
    case "detach":
      return { type: "detach" };
    case "attach":
    case "fork":
      return argument
        ? { type: name, selector: argument }
        : { type: "invalid", reason: "session_selector_required" };
    case "takeover":
      return argument
        ? { type: "takeover", confirmation: argument }
        : { type: "takeover", confirmation: null };
    case "approve":
    case "deny":
      return /^[a-f0-9]{6}$/i.test(argument)
        ? { type: name, code: argument.toLowerCase() }
        : { type: "invalid", reason: "approval_code_invalid" };
    case "task":
      return argument ? { type: "task", prompt: argument, resume: false } : { type: "invalid", reason: "prompt_required" };
    case "continue":
      return argument ? { type: "task", prompt: argument, resume: true } : { type: "invalid", reason: "prompt_required" };
    case "cancel":
      if (!argument) return { type: "cancel", jobId: null };
      return /^[a-f0-9]{4,32}$/i.test(argument)
        ? { type: "cancel", jobId: argument }
        : { type: "invalid", reason: "job_id_invalid" };
    default:
      return { type: "invalid", reason: "unknown_command", command: name };
  }
}

export function helpText() {
  return [
    "Codex 远程控制命令：",
    "工作台话题：用 /start <仓库> <任务> 开始；绑定后直接发送普通文字即可继续。",
    "/task <任务> — 在当前仓库开启新会话",
    "/continue <任务> — 继续当前仓库的上次会话",
    "/start <仓库> <任务> — 在新的飞书话题中选择仓库并开启会话",
    "/repo <别名> — 切换当前仓库",
    "/repos — 查看允许的仓库",
    "/sessions — 列出当前仓库的 Codex 会话",
    "/attach <编号> — 绑定电脑侧已有会话",
    "/detach — 解除当前会话绑定",
    "/fork <编号> — 从已有会话创建安全分支",
    "/takeover [确认码] — 显式接管冲突会话",
    "/approve <确认码> — 单次批准安全范围内的操作",
    "/deny <确认码> — 拒绝待确认操作",
    "/approval [strict|balanced|auto] — 查看或切换审批模式",
    "/status — 查看队列和当前任务",
    "/cancel [任务号] — 取消任务",
    "/new — 清除当前仓库的会话",
    "/help — 查看帮助",
  ].join("\n");
}
