import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const readme = await readFile(resolve("README.md"), "utf8");
const permissionTypes = await readFile(resolve("src/types/workspace.ts"), "utf8");

if (!readme.includes("`WIZZLE_CONFIG_URL`")) {
  throw new Error("README.md must document the remote configuration URL.");
}
if (!readme.includes("`manual-approve`")) {
  throw new Error("README.md must document the manual-approve permission mode.");
}
if (!permissionTypes.includes('"manual-approve"')) {
  throw new Error("The documented manual-approve permission mode is not defined in workspace types.");
}
if (readme.includes("src/lib/prompts/") || readme.includes("`ask`")) {
  throw new Error("README.md contains a stale bundled prompt path or permission name.");
}

console.log("Documentation consistency checks passed.");
