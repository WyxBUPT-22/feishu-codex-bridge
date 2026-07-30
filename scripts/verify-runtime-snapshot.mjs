import { verifyRuntimeSnapshot } from "../src/runtime-snapshot.js";

let runtimeDirectory = null;
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === "--runtime" && process.argv[index + 1]) {
    runtimeDirectory = process.argv[index + 1];
    index += 1;
  } else {
    throw new Error(`Unknown argument: ${process.argv[index]}`);
  }
}

if (!runtimeDirectory) throw new Error("Usage: npm run verify-snapshot -- --runtime <directory>");
console.log(JSON.stringify(await verifyRuntimeSnapshot({ runtimeDirectory }), null, 2));
