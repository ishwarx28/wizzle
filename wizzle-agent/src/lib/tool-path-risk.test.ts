import { createExternalPathWarning } from "./tool-path-risk.ts";

const projectRoot = "/workspace/project";

function assertEqual(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

const writeWarning = createExternalPathWarning({
  path: "/tmp/outside.txt",
  permissionMode: "full-access",
  projectRoot,
  toolName: "write",
});
assertEqual(writeWarning?.kind, "external-path");

const bashWarning = createExternalPathWarning({
  command: "cat /tmp/outside.txt",
  permissionMode: "full-access",
  projectRoot,
  toolName: "bash",
});
assertEqual(bashWarning?.kind, "external-path");

const projectWarning = createExternalPathWarning({
  command: "rg TODO src",
  permissionMode: "full-access",
  projectRoot,
  toolName: "bash",
});
assertEqual(projectWarning, undefined);

console.log("tool path risk tests passed");
