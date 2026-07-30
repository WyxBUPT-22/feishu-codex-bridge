import { createHash } from "node:crypto";
import { collectCommand, ProcessError } from "./process-utils.js";
import { assertLarkMessageId, extractMessageContext } from "./message-context.js";

function parseJson(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

export function sentMessageId(response) {
  const value = response?.data?.message_id ?? response?.message_id;
  return typeof value === "string" && /^om_[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null;
}

function cliError(error) {
  if (!(error instanceof ProcessError)) {
    return error;
  }
  const envelope = parseJson(error.details.stderr) ?? parseJson(error.details.stdout);
  const message = envelope?.error?.message ?? error.message;
  const wrapped = new Error(message);
  wrapped.name = "LarkCliError";
  wrapped.details = { ...error.details, envelope };
  return wrapped;
}

export function stableIdempotencyKey(seed) {
  const hash = createHash("sha256").update(String(seed)).digest("hex").slice(0, 32).split("");
  hash[12] = "4";
  hash[16] = "8";
  const value = hash.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function approvalCardUpdatePayload(token, card, operatorId) {
  if (typeof token !== "string" || token.length === 0 || token.length > 4_096) {
    throw new TypeError("Approval card update token is invalid");
  }
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw new TypeError("Approval card update must be a JSON object");
  }
  if (typeof operatorId !== "string" || operatorId.length === 0 || operatorId.length > 256) {
    throw new TypeError("Approval card update operator id is invalid");
  }
  return {
    token,
    card: {
      ...card,
      open_ids: [operatorId],
    },
  };
}

export function messageCardUpdatePayload(card) {
  assertCard(card);
  return { content: JSON.stringify(card) };
}

function replyInThreadArgs(options) {
  const replyInThread = typeof options === "boolean"
    ? options
    : options?.replyInThread === true;
  return replyInThread ? ["--reply-in-thread"] : [];
}

function assertCard(card) {
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw new TypeError("Approval card must be a JSON object");
  }
}

function normalizeOpenIds(openIds) {
  if (!Array.isArray(openIds)) {
    throw new TypeError("Feishu urgent recipients must be an array");
  }
  const normalized = [...new Set(openIds)];
  if (normalized.length === 0 || normalized.length > 200
    || normalized.some((openId) => (
      typeof openId !== "string" || !/^ou_[A-Za-z0-9_-]+$/.test(openId)
    ))) {
    throw new TypeError("Feishu urgent recipients must be 1-200 valid open_ids");
  }
  return normalized;
}

export class LarkClient {
  constructor(tool, config) {
    this.tool = tool;
    this.profile = config.lark.profile;
    this.cwd = process.cwd();
  }

  globalArgs() {
    return this.profile ? ["--profile", this.profile] : [];
  }

  async replyText(messageId, text, idempotencyKey, options = undefined) {
    const args = [
      ...this.globalArgs(),
      "im",
      "+messages-reply",
      "--as",
      "bot",
      "--message-id",
      messageId,
      "--text",
      text,
      ...replyInThreadArgs(options),
      "--idempotency-key",
      stableIdempotencyKey(idempotencyKey),
      "--json",
    ];
    try {
      const result = await collectCommand(this.tool, args, {
        cwd: this.cwd,
        env: machineEnvironment(),
        timeoutMs: 30_000,
      });
      return parseJson(result.stdout);
    } catch (error) {
      throw cliError(error);
    }
  }

  async replyCard(messageId, card, idempotencyKey, options = undefined) {
    assertCard(card);
    const args = [
      ...this.globalArgs(),
      "im",
      "+messages-reply",
      "--as",
      "bot",
      "--message-id",
      messageId,
      "--content",
      JSON.stringify(card),
      "--msg-type",
      "interactive",
      ...replyInThreadArgs(options),
      "--idempotency-key",
      stableIdempotencyKey(idempotencyKey),
      "--json",
    ];
    try {
      const result = await collectCommand(this.tool, args, {
        cwd: this.cwd,
        env: machineEnvironment(),
        timeoutMs: 30_000,
      });
      const response = parseJson(result.stdout);
      const repliedMessageId = sentMessageId(response);
      if (!repliedMessageId) {
        throw new Error("Feishu did not return the approval card reply message id");
      }
      return { messageId: repliedMessageId };
    } catch (error) {
      throw cliError(error);
    }
  }

  async replyApprovalCard(messageId, card, idempotencyKey, options = undefined) {
    return this.replyCard(messageId, card, idempotencyKey, options);
  }

  async sendText(chatId, text, idempotencyKey) {
    const args = [
      ...this.globalArgs(),
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--chat-id",
      chatId,
      "--text",
      text,
      "--idempotency-key",
      stableIdempotencyKey(idempotencyKey),
      "--json",
    ];
    try {
      const result = await collectCommand(this.tool, args, {
        cwd: this.cwd,
        env: machineEnvironment(),
        timeoutMs: 30_000,
      });
      return parseJson(result.stdout);
    } catch (error) {
      throw cliError(error);
    }
  }

  async sendCard(chatId, card, idempotencyKey) {
    assertCard(card);
    const args = [
      ...this.globalArgs(),
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--chat-id",
      chatId,
      "--content",
      JSON.stringify(card),
      "--msg-type",
      "interactive",
      "--idempotency-key",
      stableIdempotencyKey(idempotencyKey),
      "--json",
    ];
    try {
      const result = await collectCommand(this.tool, args, {
        cwd: this.cwd,
        env: machineEnvironment(),
        timeoutMs: 30_000,
      });
      const response = parseJson(result.stdout);
      const messageId = sentMessageId(response);
      if (!messageId) {
        throw new Error("Feishu did not return the approval card message id");
      }
      return { messageId };
    } catch (error) {
      throw cliError(error);
    }
  }

  async sendApprovalCard(chatId, card, idempotencyKey) {
    return this.sendCard(chatId, card, idempotencyKey);
  }

  async getMessageContext(messageId) {
    assertLarkMessageId(messageId);
    const args = [
      ...this.globalArgs(),
      "api",
      "GET",
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      "--as",
      "bot",
      "--json",
    ];
    try {
      const result = await collectCommand(this.tool, args, {
        cwd: this.cwd,
        env: machineEnvironment(),
        timeoutMs: 30_000,
      });
      const response = parseJson(result.stdout);
      if (!response) {
        throw new Error("Feishu message detail request returned invalid JSON");
      }
      return extractMessageContext(response, messageId);
    } catch (error) {
      throw cliError(error);
    }
  }

  async updateApprovalCard(token, card, operatorId) {
    const payload = approvalCardUpdatePayload(token, card, operatorId);
    const args = [
      ...this.globalArgs(),
      "api",
      "POST",
      "/open-apis/interactive/v1/card/update",
      "--as",
      "bot",
      "--data",
      JSON.stringify(payload),
      "--json",
    ];
    try {
      const result = await collectCommand(this.tool, args, {
        cwd: this.cwd,
        env: machineEnvironment(),
        timeoutMs: 30_000,
      });
      return parseJson(result.stdout);
    } catch (error) {
      throw cliError(error);
    }
  }

  async updateMessageCard(messageId, card) {
    assertLarkMessageId(messageId);
    const args = [
      ...this.globalArgs(),
      "api",
      "PATCH",
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      "--as",
      "bot",
      "--data",
      JSON.stringify(messageCardUpdatePayload(card)),
      "--json",
    ];
    try {
      const result = await collectCommand(this.tool, args, {
        cwd: this.cwd,
        env: machineEnvironment(),
        timeoutMs: 30_000,
      });
      const response = parseJson(result.stdout);
      if (!response) throw new Error("Feishu message card update returned invalid JSON");
      if (typeof response.code === "number" && response.code !== 0) {
        throw new Error(response.msg || `Feishu message card update failed: ${response.code}`);
      }
      return response;
    } catch (error) {
      throw cliError(error);
    }
  }

  async urgentApp(messageId, openIds) {
    assertLarkMessageId(messageId);
    const recipients = normalizeOpenIds(openIds);
    const args = [
      ...this.globalArgs(),
      "im",
      "messages",
      "urgent_app",
      "--as",
      "bot",
      "--message-id",
      messageId,
      "--user-id-type",
      "open_id",
      "--data",
      JSON.stringify({ user_id_list: recipients }),
      "--json",
    ];
    try {
      const result = await collectCommand(this.tool, args, {
        cwd: this.cwd,
        env: machineEnvironment(),
        timeoutMs: 15_000,
      });
      const response = parseJson(result.stdout);
      if (!response) throw new Error("Feishu urgent request returned invalid JSON");
      if (response.ok === false) {
        throw new Error(response.error?.message || "Feishu urgent request failed");
      }
      if (typeof response.code === "number" && response.code !== 0) {
        throw new Error(response.msg || `Feishu urgent request failed: ${response.code}`);
      }
      const invalid = response.invalid_user_id_list
        ?? response.data?.invalid_user_id_list
        ?? [];
      if (!Array.isArray(invalid)) {
        throw new Error("Feishu urgent response contained invalid recipient data");
      }
      if (recipients.some((openId) => invalid.includes(openId))) {
        throw new Error("Feishu rejected the urgent notification recipient");
      }
      return { invalidUserIds: invalid };
    } catch (error) {
      throw cliError(error);
    }
  }

  async status() {
    try {
      const result = await collectCommand(
        this.tool,
        [...this.globalArgs(), "event", "status", "--current", "--json"],
        { cwd: this.cwd, env: machineEnvironment(), timeoutMs: 20_000 },
      );
      return parseJson(result.stdout);
    } catch (error) {
      throw cliError(error);
    }
  }
}

export function machineEnvironment() {
  return {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    NO_COLOR: "1",
  };
}
