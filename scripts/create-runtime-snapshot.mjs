import path from "node:path";
import {
  canonicalConfigPath,
  inspectCanonicalConfig,
} from "../src/config.js";
import { createRuntimeSnapshot } from "../src/runtime-snapshot.js";

let configPath = canonicalConfigPath();
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === "--config" && process.argv[index + 1]) {
    configPath = process.argv[index + 1];
    index += 1;
  } else {
    throw new Error(`Unknown argument: ${process.argv[index]}`);
  }
}

const inspected = await inspectCanonicalConfig({
  configPath,
  shadowConfigPath: path.resolve("bridge.config.json"),
});
const snapshot = await createRuntimeSnapshot({
  configPath: inspected.configPath,
});
if (snapshot.configSourceSha256 !== inspected.sourceSha256) {
  throw new Error("Canonical configuration changed before snapshot creation");
}
console.log(JSON.stringify(snapshot, null, 2));
