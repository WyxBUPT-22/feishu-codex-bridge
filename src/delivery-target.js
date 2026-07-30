export const MAIN_CONTEXT_ID = "main";

export function normalizeContextId(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : MAIN_CONTEXT_ID;
}

function deliveryTarget(target) {
  const chatId = target?.chatId;
  if (typeof chatId !== "string" || chatId.trim().length === 0) {
    throw new TypeError("Delivery target chatId is required");
  }
  return {
    chatId: chatId.trim(),
    contextId: normalizeContextId(target?.contextId),
  };
}

export function canSendApprovalCardToTarget(lark, target) {
  const { contextId } = deliveryTarget(target);
  return contextId === MAIN_CONTEXT_ID
    ? typeof lark?.sendApprovalCard === "function"
    : typeof lark?.replyApprovalCard === "function";
}

export function canSendCardToTarget(lark, target) {
  const { contextId } = deliveryTarget(target);
  return contextId === MAIN_CONTEXT_ID
    ? typeof lark?.sendCard === "function"
    : typeof lark?.replyCard === "function";
}

export async function sendTextToTarget(lark, target, text, idempotencyKey) {
  const { chatId, contextId } = deliveryTarget(target);
  if (contextId === MAIN_CONTEXT_ID) {
    return lark.sendText(chatId, text, idempotencyKey);
  }
  return lark.replyText(
    contextId,
    text,
    idempotencyKey,
    { replyInThread: true },
  );
}

export async function sendApprovalCardToTarget(lark, target, card, idempotencyKey) {
  const { chatId, contextId } = deliveryTarget(target);
  if (contextId === MAIN_CONTEXT_ID) {
    return lark.sendApprovalCard(chatId, card, idempotencyKey);
  }
  return lark.replyApprovalCard(
    contextId,
    card,
    idempotencyKey,
    { replyInThread: true },
  );
}


export async function sendCardToTarget(lark, target, card, idempotencyKey) {
  const { chatId, contextId } = deliveryTarget(target);
  if (contextId === MAIN_CONTEXT_ID) {
    return lark.sendCard(chatId, card, idempotencyKey);
  }
  return lark.replyCard(
    contextId,
    card,
    idempotencyKey,
    { replyInThread: true },
  );
}
