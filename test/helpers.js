import path from "node:path";

export function baseConfig(repositoryPath = path.resolve(".")) {
  return {
    version: 1,
    configPath: path.join(repositoryPath, "bridge.config.json"),
    dataDirectory: path.join(repositoryPath, ".data"),
    lark: {
      profile: "test",
      allowedSenders: ["ou_allowed"],
      allowedChats: [],
      workbenchChats: [],
      p2pOnly: true,
      allowedMessageTypes: ["text", "post"],
      maxMessageAgeMinutes: 10,
    },
    repositories: { repo: { path: repositoryPath } },
    defaultRepository: "repo",
    codex: {
      sandbox: "workspace-write",
      approvalPolicy: "never",
      model: null,
      provider: null,
      maxRuntimeMinutes: 60,
      entry: null,
      appServer: { enabled: false },
    },
    larkCliEntry: null,
    queue: { concurrency: 1 },
    limits: {
      maxPromptChars: 8000,
      maxReplyChars: 12000,
      processedMessageLimit: 2000,
      storedJobLimit: 500,
    },
  };
}

export function messageEvent(overrides = {}) {
  const now = String(Date.now());
  return {
    type: "im.message.receive_v1",
    event_id: "evt_1",
    message_id: "om_1",
    chat_id: "oc_1",
    chat_type: "p2p",
    sender_id: "ou_allowed",
    message_type: "text",
    content: "/help",
    create_time: now,
    timestamp: now,
    ...overrides,
  };
}

export function cardActionEvent(overrides = {}) {
  const now = String(Date.now());
  return {
    type: "card.action.trigger",
    event_id: "evt_card_1",
    operator_id: "ou_allowed",
    message_id: "om_card1",
    chat_id: "oc_1",
    token: "card-update-token",
    host: "im_message",
    action_tag: "button",
    action_value: JSON.stringify({
      v: 1,
      kind: "codex_approval",
      decision: "approve",
      actionId: "a".repeat(32),
    }),
    timestamp: now,
    ...overrides,
  };
}
