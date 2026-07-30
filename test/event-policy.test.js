import assert from "node:assert/strict";
import test from "node:test";
import {
  eventDedupeKey,
  eventTimestampMs,
  isWorkbenchChat,
  isWorkbenchEvent,
  validateEvent,
} from "../src/event-policy.js";
import { baseConfig, cardActionEvent, messageEvent } from "./helpers.js";

test("accepts current allowlisted private messages", () => {
  assert.deepEqual(validateEvent(messageEvent(), baseConfig()), { accepted: true });
});

test("uses message id as the primary dedupe key", () => {
  assert.equal(eventDedupeKey(messageEvent()), "om_1");
});

test("rejects unknown senders, groups, types and stale messages", () => {
  const config = baseConfig();
  assert.equal(validateEvent(messageEvent({ sender_id: "ou_other" }), config).reason, "sender_not_allowed");
  assert.equal(validateEvent(messageEvent({ chat_type: "group" }), config).reason, "p2p_only");
  assert.equal(validateEvent(messageEvent({ message_type: "file" }), config).reason, "message_type_not_allowed");
  assert.equal(
    validateEvent(messageEvent({ create_time: String(Date.now() - 11 * 60_000) }), config).reason,
    "stale_message",
  );
  assert.equal(validateEvent(messageEvent({ create_time: "", timestamp: "" }), config).reason, "missing_timestamp");
});

test("accepts only configured workbench group messages while preserving private messages", () => {
  const config = baseConfig();
  config.lark.allowedChats = ["oc_private", "oc_workbench", "oc_other_group"];
  config.lark.workbenchChats = ["oc_workbench"];
  config.lark.p2pOnly = false;

  assert.deepEqual(validateEvent(messageEvent({
    chat_id: "oc_workbench",
    chat_type: "group",
  }), config), { accepted: true });
  assert.equal(validateEvent(messageEvent({
    chat_id: "oc_other_group",
    chat_type: "group",
  }), config).reason, "chat_not_allowed");
  assert.deepEqual(validateEvent(messageEvent({
    chat_id: "oc_private",
    chat_type: "p2p",
  }), config), { accepted: true });

  assert.equal(isWorkbenchChat("oc_workbench", config), true);
  assert.equal(isWorkbenchChat("oc_private", config), false);
  assert.equal(isWorkbenchEvent(messageEvent({ chat_id: "oc_workbench" }), config), true);
});

test("accepts allowlisted approval card button events with event-id dedupe", () => {
  const event = cardActionEvent();
  assert.deepEqual(validateEvent(event, baseConfig()), { accepted: true });
  assert.equal(eventDedupeKey(event), "card:evt_card_1");
});

test("applies the workbench allowlist to group approval card callbacks", () => {
  const config = baseConfig();
  config.lark.allowedChats = ["oc_private", "oc_workbench", "oc_other_group"];
  config.lark.workbenchChats = ["oc_workbench"];
  config.lark.p2pOnly = false;

  assert.deepEqual(validateEvent(cardActionEvent({
    chat_id: "oc_workbench",
    chat_type: "group",
  }), config), { accepted: true });
  assert.equal(validateEvent(cardActionEvent({
    chat_id: "oc_other_group",
    chat_type: "group",
  }), config).reason, "chat_not_allowed");
  assert.deepEqual(validateEvent(cardActionEvent({
    chat_id: "oc_private",
    chat_type: "p2p",
  }), config), { accepted: true });
});

test("normalizes current epoch timestamps without accepting ambiguous values", () => {
  const now = Date.now();
  assert.equal(eventTimestampMs(String(Math.floor(now / 1_000))), Math.floor(now / 1_000) * 1_000);
  assert.equal(eventTimestampMs(String(now)), now);
  assert.equal(eventTimestampMs((BigInt(now) * 1_000n).toString()), now);
  assert.equal(eventTimestampMs((BigInt(now) * 1_000n + 999n).toString()), now);
  assert.equal(eventTimestampMs((BigInt(now) * 1_000_000n).toString()), now);
  assert.equal(eventTimestampMs((BigInt(now) * 1_000_000n + 999_999n).toString()), now);
  assert.equal(Number.isNaN(eventTimestampMs(`${now}.0`)), true);
  assert.equal(Number.isNaN(eventTimestampMs(`0${now}`)), true);
  assert.equal(Number.isNaN(eventTimestampMs(Number(BigInt(now) * 1_000_000n))), true);
  assert.equal(Number.isNaN(eventTimestampMs(`${now}0000000`)), true);
});

test("accepts card callback timestamps expressed in seconds or microseconds", () => {
  const now = Date.now();
  assert.deepEqual(validateEvent(cardActionEvent({
    timestamp: String(Math.floor(now / 1_000)),
  }), baseConfig(), now), { accepted: true });
  assert.deepEqual(validateEvent(cardActionEvent({
    timestamp: (BigInt(now) * 1_000n).toString(),
  }), baseConfig(), now), { accepted: true });
});

test("uses the card delivery timestamp instead of an unrelated create_time", () => {
  const now = Date.now();
  assert.deepEqual(validateEvent(cardActionEvent({
    create_time: String(now - 60 * 60_000),
    timestamp: (BigInt(now) * 1_000n).toString(),
  }), baseConfig(), now), { accepted: true });
  assert.equal(validateEvent(messageEvent({
    create_time: String(now - 60 * 60_000),
    timestamp: String(now),
  }), baseConfig(), now).reason, "stale_message");
  assert.equal(validateEvent(cardActionEvent({
    create_time: String(now),
    timestamp: "",
  }), baseConfig(), now).reason, "missing_timestamp");
});

test("rejects unsafe approval card actors, contexts, actions and timestamps", () => {
  const config = baseConfig();
  assert.equal(
    validateEvent(cardActionEvent({ operator_id: "ou_other" }), config).reason,
    "sender_not_allowed",
  );
  assert.equal(
    validateEvent(cardActionEvent({ host: "im_top_notice" }), config).reason,
    "unsupported_card_host",
  );
  assert.equal(
    validateEvent(cardActionEvent({ action_tag: "input" }), config).reason,
    "unsupported_card_action",
  );
  assert.equal(
    validateEvent(cardActionEvent({ event_id: "" }), config).reason,
    "missing_event_id",
  );
  assert.equal(
    validateEvent(cardActionEvent({ timestamp: String(Date.now() - 11 * 60_000) }), config).reason,
    "stale_message",
  );
});
