import { classifyDangerousCommand, createExternalPathWarning } from "./tool-path-risk.ts";

const projectRoot = "/workspace/project";

function assertEqual(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

const writeWarning = createExternalPathWarning({
  path: "/etc/outside.txt",
  permissionMode: "full-access",
  projectRoot,
  toolName: "write",
});
assertEqual(writeWarning?.kind, "external-path");

const shellWarning = createExternalPathWarning({
  command: "cat /etc/outside.txt",
  permissionMode: "full-access",
  projectRoot,
  toolName: "shell",
});
assertEqual(shellWarning?.kind, "external-path");

const shellTempWarning = createExternalPathWarning({
  command: "cat /tmp/outside.txt",
  permissionMode: "full-access",
  projectRoot,
  toolName: "shell",
});
assertEqual(shellTempWarning?.kind, "external-path");

const writeTempWarning = createExternalPathWarning({
  path: "/tmp/outside.txt",
  permissionMode: "full-access",
  projectRoot,
  toolName: "write",
});
assertEqual(writeTempWarning?.kind, "external-path");

const devRedirectWarning = createExternalPathWarning({
  command: "rg TODO src 2>/dev/null",
  permissionMode: "full-access",
  projectRoot,
  toolName: "shell",
});
assertEqual(devRedirectWarning, undefined);

const devPrefixWarning = createExternalPathWarning({
  command: "cat /dev/fd/1",
  permissionMode: "full-access",
  projectRoot,
  toolName: "shell",
});
assertEqual(devPrefixWarning, undefined);

const grepPatternWarning = createExternalPathWarning({
  command: "grep '/api/users' src/routes.ts",
  permissionMode: "full-access",
  projectRoot,
  toolName: "shell",
});
assertEqual(grepPatternWarning, undefined);

const sedPatternWarning = createExternalPathWarning({
  command: "sed -n '/api/users/p' src/routes.ts",
  permissionMode: "full-access",
  projectRoot,
  toolName: "shell",
});
assertEqual(sedPatternWarning, undefined);

const findPatternWarning = createExternalPathWarning({
  command: "find . -path '/tmp/*' -print",
  permissionMode: "full-access",
  projectRoot,
  toolName: "shell",
});
assertEqual(findPatternWarning, undefined);

const projectWarning = createExternalPathWarning({
  command: "rg TODO src",
  permissionMode: "full-access",
  projectRoot,
  toolName: "shell",
});
assertEqual(projectWarning, undefined);

const cwdInsideWarning = createExternalPathWarning({
  command: "cat ../README.md",
  cwd: "src",
  permissionMode: "full-access",
  projectRoot,
  toolName: "shell",
});
assertEqual(cwdInsideWarning, undefined);

const cwdOutsideWarning = createExternalPathWarning({
  command: "cat ../../outside.txt",
  cwd: "src",
  permissionMode: "full-access",
  projectRoot,
  toolName: "shell",
});
assertEqual(cwdOutsideWarning?.kind, "external-path");

const homeResolvedWarning = createExternalPathWarning({
  command: "cat $HOME/notes.txt",
  permissionMode: "full-access",
  projectRoot,
  resolvedPaths: [
    {
      expandedPath: "/Users/example/notes.txt",
      hasUnexpandedVariables: false,
      isInsideProjectRoot: false,
      rawPath: "$HOME/notes.txt",
      realPath: "/Users/example/notes.txt",
      resolvedPath: "/Users/example/notes.txt",
    },
  ],
  toolName: "shell",
});
assertEqual(homeResolvedWarning?.kind, "external-path");

const unknownVariableWarning = createExternalPathWarning({
  command: "cat $SECRET_DIR/notes.txt",
  permissionMode: "full-access",
  projectRoot,
  resolvedPaths: [
    {
      expandedPath: "$SECRET_DIR/notes.txt",
      hasUnexpandedVariables: true,
      rawPath: "$SECRET_DIR/notes.txt",
      resolvedPath: "/workspace/project/$SECRET_DIR/notes.txt",
    },
  ],
  toolName: "shell",
});
assertEqual(unknownVariableWarning?.kind, "external-path");

const unknownVariableSafeLookingWarning = createExternalPathWarning({
  command: "cat /tmp/$SECRET_DIR/notes.txt",
  permissionMode: "full-access",
  projectRoot,
  resolvedPaths: [
    {
      expandedPath: "/tmp/$SECRET_DIR/notes.txt",
      hasUnexpandedVariables: true,
      isSafeExternal: true,
      rawPath: "/tmp/$SECRET_DIR/notes.txt",
      resolvedPath: "/tmp/$SECRET_DIR/notes.txt",
    },
  ],
  toolName: "shell",
});
assertEqual(unknownVariableSafeLookingWarning?.kind, "external-path");

const complexVariableWarning = createExternalPathWarning({
  command: 'ls "${TARGET%/*}"',
  permissionMode: "full-access",
  projectRoot,
  resolvedPaths: [
    {
      expandedPath: "${TARGET%/*}",
      hasUnexpandedVariables: false,
      isInsideProjectRoot: true,
      rawPath: "${TARGET%/*}",
      resolvedPath: "/workspace/project/${TARGET%/*}",
    },
  ],
  toolName: "shell",
});
assertEqual(complexVariableWarning?.kind, "external-path");

const symlinkTargetWarning = createExternalPathWarning({
  path: "linked-file",
  permissionMode: "full-access",
  projectRoot,
  resolvedPaths: [
    {
      expandedPath: "linked-file",
      hasUnexpandedVariables: false,
      isInsideProjectRoot: false,
      rawPath: "linked-file",
      realPath: "/etc/passwd",
      resolvedPath: "/workspace/project/linked-file",
    },
  ],
  toolName: "edit",
});
assertEqual(symlinkTargetWarning?.kind, "external-path");

const sensitiveSymlinkReadWarning = createExternalPathWarning({
  path: "linked-config",
  permissionMode: "full-access",
  projectRoot,
  resolvedPaths: [
    {
      expandedPath: "linked-config",
      hasUnexpandedVariables: false,
      isInsideProjectRoot: false,
      rawPath: "linked-config",
      realPath: "/workspace/secrets/.env.production",
      resolvedPath: "/workspace/project/linked-config",
    },
  ],
  toolName: "read",
});
assertEqual(sensitiveSymlinkReadWarning?.kind, "sensitive-path");

const sensitiveShellSymlinkWarning = createExternalPathWarning({
  command: "cat linked-config",
  permissionMode: "full-access",
  projectRoot,
  resolvedPaths: [
    {
      expandedPath: "linked-config",
      hasUnexpandedVariables: false,
      isInsideProjectRoot: false,
      rawPath: "linked-config",
      realPath: "/workspace/secrets/.env.local",
      resolvedPath: "/workspace/project/linked-config",
    },
  ],
  toolName: "shell",
});
assertEqual(sensitiveShellSymlinkWarning?.kind, "sensitive-path");

const ordinaryExternalReadWarning = createExternalPathWarning({
  path: "/etc/hosts",
  permissionMode: "full-access",
  projectRoot,
  toolName: "read",
});
assertEqual(ordinaryExternalReadWarning, undefined);

for (const dangerousCommand of [
  "/bin/rm -rf ${TARGET:-/}",
  "command rm -rf .",
  "find . -exec rm -rf {} +",
  "sh -c 'rm -rf .'",
  "$DELETE_COMMAND -rf .",
  'ls "$(rm -rf .)"',
  "printf '%s\\0' build | xargs -0 rm -rf",
]) {
  assertEqual(typeof classifyDangerousCommand(dangerousCommand), "string");
}

console.log("tool path risk tests passed");
