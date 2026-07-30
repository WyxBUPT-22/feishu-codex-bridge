import assert from "node:assert/strict";
import test from "node:test";
import {
  containsKnownPrivateMarker,
  containsPossibleRealCodexThreadId,
} from "../scripts/check-public-release.mjs";

test("public release marker scan catches separator variants", () => {
  const privateProvider = ["shuai", "api", "codex"].join("_");
  assert.equal(containsKnownPrivateMarker(privateProvider), true);
  assert.equal(containsKnownPrivateMarker("example_provider"), false);
});

test("public release scan rejects realistic thread IDs but permits explicit fixtures", () => {
  const realistic = ["019fa3ca", "e78f", "7932", "8cb6", "a1367f40d7b6"].join("-");
  assert.equal(containsPossibleRealCodexThreadId(realistic), true);
  assert.equal(
    containsPossibleRealCodexThreadId("01900000-0000-7000-8000-000000000001"),
    false,
  );
});
