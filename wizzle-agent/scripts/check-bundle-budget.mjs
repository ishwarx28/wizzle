import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_ENTRY_BYTES = 1_250_000;
const distDirectory = resolve("dist");
const indexHtml = await readFile(resolve(distDirectory, "index.html"), "utf8");
const entryPath = indexHtml.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];

if (!entryPath) {
  throw new Error("Could not find the JavaScript entry chunk in dist/index.html.");
}

const entryBytes = (await stat(resolve(distDirectory, entryPath.replace(/^\//, "")))).size;
if (entryBytes > MAX_ENTRY_BYTES) {
  throw new Error(
    `Entry chunk is ${entryBytes.toLocaleString()} bytes; budget is ${MAX_ENTRY_BYTES.toLocaleString()} bytes.`,
  );
}

console.log(
  `Entry chunk budget passed: ${entryBytes.toLocaleString()} / ${MAX_ENTRY_BYTES.toLocaleString()} bytes.`,
);
