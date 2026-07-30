import assert from "node:assert/strict";
import test from "node:test";
import { helpText, parseCommand } from "../src/commands.js";

test("parses task and continue commands", () => {
  assert.deepEqual(parseCommand("/task 修复登录测试"), {
    type: "task",
    prompt: "修复登录测试",
    resume: false,
  });
  assert.deepEqual(parseCommand(" /continue 继续处理\n并运行测试 "), {
    type: "task",
    prompt: "继续处理\n并运行测试",
    resume: true,
  });
  assert.deepEqual(parseCommand("/start study-methods 设计新的学习流程"), {
    type: "start",
    alias: "study-methods",
    prompt: "设计新的学习流程",
  });
});

test("parses session handoff commands", () => {
  assert.deepEqual(parseCommand("/sessions"), { type: "sessions" });
  assert.deepEqual(parseCommand("/attach 2"), { type: "attach", selector: "2" });
  assert.deepEqual(parseCommand("/fork 019f5b99"), { type: "fork", selector: "019f5b99" });
  assert.deepEqual(parseCommand("/detach"), { type: "detach" });
  assert.deepEqual(parseCommand("/takeover"), { type: "takeover", confirmation: null });
  assert.deepEqual(parseCommand("/takeover abc123"), { type: "takeover", confirmation: "abc123" });
  assert.deepEqual(parseCommand("/approve a1b2c3"), { type: "approve", code: "a1b2c3" });
  assert.deepEqual(parseCommand("/deny FFFFFF"), { type: "deny", code: "ffffff" });
});

test("parses approval mode query and updates", () => {
  assert.deepEqual(parseCommand("/approval"), { type: "approval", mode: null });
  assert.deepEqual(parseCommand("/approval strict"), { type: "approval", mode: "strict" });
  assert.deepEqual(parseCommand("/approval BALANCED"), { type: "approval", mode: "balanced" });
  assert.deepEqual(parseCommand("/approval auto"), { type: "approval", mode: "auto" });
  assert.deepEqual(parseCommand("/approval unsafe"), {
    type: "invalid",
    reason: "approval_mode_invalid",
  });
  assert.match(helpText(), /\/approval \[strict\|balanced\|auto\]/);
});

test("rejects free-form chat and missing arguments", () => {
  assert.deepEqual(parseCommand("rm -rf something"), {
    type: "invalid",
    reason: "command_required",
  });
  assert.deepEqual(parseCommand("/repo"), {
    type: "invalid",
    reason: "repository_required",
  });
  assert.deepEqual(parseCommand("/task"), {
    type: "invalid",
    reason: "prompt_required",
  });
  assert.deepEqual(parseCommand("/start study-methods"), {
    type: "invalid",
    reason: "start_arguments_required",
  });
  assert.deepEqual(parseCommand("/cancel not-a-job!"), {
    type: "invalid",
    reason: "job_id_invalid",
  });
});
