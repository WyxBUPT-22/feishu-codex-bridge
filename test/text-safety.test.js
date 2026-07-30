import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText } from "../src/text-safety.js";

test("redacts common credential shapes from mobile replies", () => {
  const value = redactSensitiveText("app_secret=abc123 token\nAuthorization: Bearer secret-token\nsk-abcdef123456789");
  assert.doesNotMatch(value, /abc123|secret-token|sk-abcdef/);
  assert.match(value, /\[REDACTED\]/);
});
