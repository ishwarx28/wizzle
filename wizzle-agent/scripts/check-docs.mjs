import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const readme = await readFile(resolve("README.md"), "utf8");
const permissionTypes = await readFile(resolve("src/types/workspace.ts"), "utf8");

await access(resolve("src/lib/prompts/system-prompt.txt"));

if (!readme.includes("src/lib/prompts/system-prompt.txt")) {
  throw new Error("README.md must reference the current system prompt filename.");
}
if (!readme.includes("`manual-approve`")) {
  throw new Error("README.md must document the manual-approve permission mode.");
}
if (!permissionTypes.includes('"manual-approve"')) {
  throw new Error("The documented manual-approve permission mode is not defined in workspace types.");
}
if (readme.includes("system-prompt.md") || readme.includes("`ask`")) {
  throw new Error("README.md contains a stale prompt filename or permission name.");
}

console.log("Documentation consistency checks passed.");
