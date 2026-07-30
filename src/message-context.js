const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]+$/;

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function messageItem(response) {
  const candidates = [
    response?.data?.items?.[0],
    response?.items?.[0],
    response?.data?.data?.items?.[0],
    response?.data?.item,
    response?.item,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === "object") ?? null;
}

function messageText(item) {
  const raw = optionalString(item?.body?.content);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.text === "string" ? parsed.text : null;
  } catch {
    return null;
  }
}

function mentionKeys(item) {
  if (!Array.isArray(item?.mentions)) return [];
  return [...new Set(item.mentions
    .map((mention) => optionalString(mention?.key))
    .filter(Boolean))];
}

export function assertLarkMessageId(messageId) {
  if (typeof messageId !== "string" || !MESSAGE_ID_PATTERN.test(messageId)) {
    throw new TypeError("Feishu message id is invalid");
  }
  return messageId;
}

export function extractMessageContext(response, expectedMessageId = null) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Feishu message detail response is not a JSON object");
  }
  if (typeof response.code === "number" && response.code !== 0) {
    throw new Error(
      `Feishu message detail request failed: ${response.msg || `code ${response.code}`}`,
    );
  }

  const item = messageItem(response);
  if (!item) {
    throw new Error("Feishu message detail response did not contain a message");
  }

  const messageId = optionalString(item.message_id);
  const chatId = optionalString(item.chat_id);
  if (!messageId) {
    throw new Error("Feishu message detail response did not contain message_id");
  }
  if (expectedMessageId != null && messageId !== expectedMessageId) {
    throw new Error(
      `Feishu message detail returned ${messageId} instead of ${expectedMessageId}`,
    );
  }
  if (!chatId) {
    throw new Error("Feishu message detail response did not contain chat_id");
  }

  const result = {
    messageId,
    chatId,
    threadId: optionalString(item.thread_id),
    rootId: optionalString(item.root_id),
    parentId: optionalString(item.parent_id),
  };
  const text = messageText(item);
  const mentions = mentionKeys(item);
  if (text != null) result.text = text;
  if (mentions.length > 0) result.mentionKeys = mentions;
  return result;
}
