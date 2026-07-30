import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalCardUpdatePayload,
  LarkClient,
  messageCardUpdatePayload,
  sentMessageId,
  stableIdempotencyKey,
} from "../src/lark-client.js";
import { extractMessageContext } from "../src/message-context.js";

function scriptTool(source) {
  return {
    command: process.execPath,
    prefixArgs: ["-e", source, "--"],
    displayName: "fake-lark-cli",
  };
}

function clientForScript(source) {
  return new LarkClient(scriptTool(source), { lark: { profile: "test-profile" } });
}

test("creates deterministic UUID-shaped idempotency keys", () => {
  const first = stableIdempotencyKey("event:reply");
  assert.equal(first, stableIdempotencyKey("event:reply"));
  assert.notEqual(first, stableIdempotencyKey("event:other"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("accepts Feishu message ids only from supported response envelopes", () => {
  assert.equal(sentMessageId({ message_id: "om_x100abc123" }), "om_x100abc123");
  assert.equal(sentMessageId({ data: { message_id: "om_nested" } }), "om_nested");
  assert.equal(sentMessageId({ data: { data: { message_id: "om_too_deep" } } }), null);
  assert.equal(sentMessageId({ message_id: "bad" }), null);
  assert.equal(sentMessageId({ message_id: null }), null);
});

test("builds Card 1.0 delayed updates for the operator who clicked", () => {
  const card = { header: { template: "green" }, elements: [] };
  assert.deepEqual(
    approvalCardUpdatePayload("update-token", card, "ou_operator"),
    {
      token: "update-token",
      card: {
        header: { template: "green" },
        elements: [],
        open_ids: ["ou_operator"],
      },
    },
  );
  assert.equal(Object.hasOwn(card, "open_ids"), false);
  assert.throws(
    () => approvalCardUpdatePayload("update-token", card, ""),
    /operator id is invalid/,
  );
});

test("double-encodes a complete card for message PATCH updates", async () => {
  const card = { header: { title: { content: "Task" } }, elements: [] };
  assert.deepEqual(messageCardUpdatePayload(card), { content: JSON.stringify(card) });
  const verifier = String.raw`
    const args = process.argv.slice(1);
    if (!args.includes("PATCH") || !args.includes("/open-apis/im/v1/messages/om_control")) process.exit(2);
    const data = JSON.parse(args[args.indexOf("--data") + 1]);
    const card = JSON.parse(data.content);
    if (card.header?.title?.content !== "Task") process.exit(3);
    console.log(JSON.stringify({ code: 0, msg: "ok" }));
  `;
  assert.equal((await clientForScript(verifier).updateMessageCard("om_control", card)).code, 0);
  await assert.rejects(
    clientForScript(verifier).updateMessageCard("../unsafe", card),
    /message id is invalid/,
  );
});

test("sends an app urgent to exact open_id recipients on the original message", async () => {
  const verifier = String.raw`
    const args = process.argv.slice(1);
    const required = ["im", "messages", "urgent_app", "--as", "bot", "--message-id", "om_control", "--user-id-type", "open_id"];
    if (required.some((value) => !args.includes(value))) process.exit(2);
    const data = JSON.parse(args[args.indexOf("--data") + 1]);
    if (JSON.stringify(data.user_id_list) !== JSON.stringify(["ou_operator"])) process.exit(3);
    console.log(JSON.stringify({ invalid_user_id_list: [] }));
  `;
  const client = clientForScript(verifier);
  assert.deepEqual(
    await client.urgentApp("om_control", ["ou_operator", "ou_operator"]),
    { invalidUserIds: [] },
  );
  await assert.rejects(client.urgentApp("../unsafe", ["ou_operator"]), /message id is invalid/);
  await assert.rejects(client.urgentApp("om_control", ["bad-user"]), /valid open_ids/);
});

test("fails an app urgent when Feishu rejects the target user", async () => {
  const client = clientForScript(
    "console.log(JSON.stringify({ invalid_user_id_list: ['ou_operator'] }))",
  );
  await assert.rejects(
    client.urgentApp("om_control", ["ou_operator"]),
    /rejected the urgent notification recipient/,
  );
});

test("extracts thread routing metadata and preserves absent thread fields as null", () => {
  assert.deepEqual(
    extractMessageContext({
      code: 0,
      data: {
        items: [{
          message_id: "om_message",
          chat_id: "oc_chat",
          thread_id: "omt_thread",
          root_id: "om_root",
          parent_id: "om_parent",
        }],
      },
    }, "om_message"),
    {
      messageId: "om_message",
      chatId: "oc_chat",
      threadId: "omt_thread",
      rootId: "om_root",
      parentId: "om_parent",
    },
  );

  assert.deepEqual(
    extractMessageContext({ items: [{ message_id: "om_plain", chat_id: "oc_chat" }] }),
    {
      messageId: "om_plain",
      chatId: "oc_chat",
      threadId: null,
      rootId: null,
      parentId: null,
    },
  );
  assert.throws(
    () => extractMessageContext({ code: 0, data: { items: [] } }),
    /did not contain a message/,
  );
  assert.throws(
    () => extractMessageContext({ code: 999, msg: "permission denied" }),
    /permission denied/,
  );

  assert.deepEqual(
    extractMessageContext({
      data: {
        items: [{
          message_id: "om_mentioned",
          chat_id: "oc_chat",
          body: { content: JSON.stringify({ text: "@_user_1 /start repo 测试" }) },
          mentions: [{ key: "@_user_1", id: "ou_bot" }],
        }],
      },
    }),
    {
      messageId: "om_mentioned",
      chatId: "oc_chat",
      threadId: null,
      rootId: null,
      parentId: null,
      text: "@_user_1 /start repo 测试",
      mentionKeys: ["@_user_1"],
    },
  );
});

test("replyText keeps the old signature and optionally replies in the thread", async () => {
  const client = clientForScript(
    "console.log(JSON.stringify({ argv: process.argv.slice(1) }))",
  );

  const plain = await client.replyText("om_source", "hello", "plain-key");
  assert.equal(plain.argv.includes("--reply-in-thread"), false);

  const threaded = await client.replyText(
    "om_source",
    "hello thread",
    "thread-key",
    { replyInThread: true },
  );
  assert.equal(threaded.argv.includes("--reply-in-thread"), true);
  assert.deepEqual(
    threaded.argv.slice(threaded.argv.indexOf("--message-id"), threaded.argv.indexOf("--text")),
    ["--message-id", "om_source"],
  );

  const booleanOption = await client.replyText("om_source", "hello", "bool-key", true);
  assert.equal(booleanOption.argv.includes("--reply-in-thread"), true);
});

test("replies with an interactive approval card inside a thread", async () => {
  const verifier = String.raw`
    const args = process.argv.slice(1);
    const required = ["im", "+messages-reply", "--message-id", "om_source", "--msg-type", "interactive", "--reply-in-thread"];
    if (required.some((value) => !args.includes(value))) process.exit(2);
    const content = JSON.parse(args[args.indexOf("--content") + 1]);
    if (content.header?.title?.content !== "Approve?") process.exit(3);
    console.log(JSON.stringify({ data: { message_id: "om_card_reply" } }));
  `;
  const client = clientForScript(verifier);
  const result = await client.replyApprovalCard(
    "om_source",
    { header: { title: { content: "Approve?" } }, elements: [] },
    "approval-key",
    { replyInThread: true },
  );
  assert.deepEqual(result, { messageId: "om_card_reply" });
});

test("gets complete message routing context through the read-only message API", async () => {
  const verifier = String.raw`
    const args = process.argv.slice(1);
    const path = "/open-apis/im/v1/messages/om_source";
    if (!args.includes("api") || !args.includes("GET") || !args.includes(path)) process.exit(2);
    console.log(JSON.stringify({ code: 0, data: { items: [{
      message_id: "om_source",
      chat_id: "oc_chat",
      thread_id: "omt_thread",
      root_id: "om_root",
      parent_id: "om_parent"
    }] } }));
  `;
  const client = clientForScript(verifier);
  assert.deepEqual(await client.getMessageContext("om_source"), {
    messageId: "om_source",
    chatId: "oc_chat",
    threadId: "omt_thread",
    rootId: "om_root",
    parentId: "om_parent",
  });
  await assert.rejects(
    client.getMessageContext("../unsafe"),
    /message id is invalid/,
  );
});
