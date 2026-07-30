export function eventDedupeKey(event) {
  if (event?.type === "card.action.trigger") {
    return typeof event.event_id === "string" && event.event_id.length > 0
      ? `card:${event.event_id}`
      : null;
  }
  return event.message_id || event.id || event.event_id || null;
}

export function isWorkbenchChat(chatId, config) {
  return typeof chatId === "string"
    && config?.lark?.workbenchChats?.includes(chatId) === true;
}

export function isWorkbenchEvent(event, config) {
  return isWorkbenchChat(event?.chat_id, config);
}

export function eventTimestampMs(value) {
  let digits;
  if (typeof value === "string") {
    digits = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    digits = String(value);
  } else if (typeof value === "bigint") {
    digits = value.toString();
  } else {
    return Number.NaN;
  }
  if (digits.length === 0 || digits.length > 19 || !/^[1-9][0-9]*$/.test(digits)) {
    return Number.NaN;
  }

  const raw = BigInt(digits);
  let milliseconds;
  if (digits.length <= 10) {
    milliseconds = raw * 1_000n;
  } else if (digits.length <= 13) {
    milliseconds = raw;
  } else if (digits.length <= 16) {
    milliseconds = raw / 1_000n;
  } else {
    milliseconds = raw / 1_000_000n;
  }
  const timestamp = Number(milliseconds);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : Number.NaN;
}

function validTimestamp(event, config, now) {
  const timestampValue = event.type === "card.action.trigger"
    ? event.timestamp
    : event.create_time || event.timestamp;
  if (timestampValue === undefined || timestampValue === null || timestampValue === "") {
    return { accepted: false, reason: "missing_timestamp" };
  }
  const timestamp = eventTimestampMs(timestampValue);
  if (!Number.isFinite(timestamp)) {
    return { accepted: false, reason: "missing_timestamp" };
  }
  const ageMs = now - timestamp;
  if (ageMs > config.lark.maxMessageAgeMinutes * 60_000 || ageMs < -60_000) {
    return { accepted: false, reason: "stale_message" };
  }
  return { accepted: true };
}

function validateChatContext(event, config, { allowMissingType = false } = {}) {
  if (config.lark.allowedChats.length > 0 && !config.lark.allowedChats.includes(event.chat_id)) {
    return { accepted: false, reason: "chat_not_allowed" };
  }

  if (allowMissingType && (event.chat_type === undefined || event.chat_type === null)) {
    return { accepted: true };
  }
  if (event.chat_type === "p2p") return { accepted: true };
  if (config.lark.p2pOnly) return { accepted: false, reason: "p2p_only" };
  if (!isWorkbenchEvent(event, config)) {
    return { accepted: false, reason: "chat_not_allowed" };
  }
  return { accepted: true };
}

function validateCardAction(event, config, now) {
  if (!eventDedupeKey(event)) return { accepted: false, reason: "missing_event_id" };
  if (!config.lark.allowedSenders.includes(event.operator_id)) {
    return { accepted: false, reason: "sender_not_allowed" };
  }
  const chatPolicy = validateChatContext(event, config, { allowMissingType: true });
  if (!chatPolicy.accepted) return chatPolicy;
  if (event.host !== "im_message") return { accepted: false, reason: "unsupported_card_host" };
  if (event.action_tag !== "button") return { accepted: false, reason: "unsupported_card_action" };
  if (typeof event.message_id !== "string" || !/^om_[A-Za-z0-9_-]+$/.test(event.message_id)) {
    return { accepted: false, reason: "missing_message_id" };
  }
  if (typeof event.action_value !== "string" || event.action_value.length === 0) {
    return { accepted: false, reason: "missing_action_value" };
  }
  return validTimestamp(event, config, now);
}

export function validateEvent(event, config, now = Date.now()) {
  if (event?.type === "card.action.trigger") {
    return validateCardAction(event, config, now);
  }
  if (!event || event.type !== "im.message.receive_v1") {
    return { accepted: false, reason: "unsupported_event" };
  }
  if (!eventDedupeKey(event)) {
    return { accepted: false, reason: "missing_message_id" };
  }
  if (!config.lark.allowedSenders.includes(event.sender_id)) {
    return { accepted: false, reason: "sender_not_allowed" };
  }
  const chatPolicy = validateChatContext(event, config);
  if (!chatPolicy.accepted) return chatPolicy;
  if (!config.lark.allowedMessageTypes.includes(event.message_type)) {
    return { accepted: false, reason: "message_type_not_allowed" };
  }
  return validTimestamp(event, config, now);
}
