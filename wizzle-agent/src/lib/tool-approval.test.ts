import {
  createToolApprovalBatchRequest,
  createToolApprovalRequest,
} from "./tool-approval.ts";

type RequestInput = Parameters<typeof createToolApprovalRequest>[0];

const defaults = {
  projectRoot: "/workspace/project",
  sessionId: "session-1",
  toolCallId: "call-1",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function approvalRequest(
  input: Pick<RequestInput, "arguments" | "permissionMode" | "toolName">,
) {
  return createToolApprovalRequest({
    ...defaults,
    ...input,
  });
}

async function main() {
  const describedCommand = await approvalRequest({
    arguments: JSON.stringify({
      command: "npm test",
      description: "Run the test suite.",
    }),
    permissionMode: "manual-approve",
    toolName: "bash",
  });
  assert(describedCommand?.description === "Run the test suite.", "preserves bash description");

  for (const command of [
    "pwd",
    "ls -la",
    "find . -type f",
    "find ./lib -type f | sort",
    "find ./lib -type f | grep '.env' | sort",
    "grep TODO src/main.ts",
    "grep 'TODO.*' src/main.ts",
    "sort package.json",
  ]) {
    const request = await approvalRequest({
      arguments: JSON.stringify({ command }),
      permissionMode: "manual-approve",
      toolName: "bash",
    });
    assert(request === null, `manual mode should allow whitelisted command: ${command}`);
  }

  const unsafeFind = await approvalRequest({
    arguments: JSON.stringify({ command: "find . -delete" }),
    permissionMode: "manual-approve",
    toolName: "bash",
  });
  assert(
    unsafeFind?.warning?.kind === "dangerous-command",
    "manual mode asks before find mutations",
  );

  const hiddenSearch = await approvalRequest({
    arguments: JSON.stringify({ command: "rg --hidden TOKEN ." }),
    permissionMode: "manual-approve",
    toolName: "bash",
  });
  assert(hiddenSearch !== null, "manual mode asks before searches that can read hidden files");

  const globRead = await approvalRequest({
    arguments: JSON.stringify({ command: "cat *.txt" }),
    permissionMode: "manual-approve",
    toolName: "bash",
  });
  assert(globRead !== null, "shell globs require approval because they can traverse symlinks");

  const commandSubstitution = await approvalRequest({
    arguments: JSON.stringify({ command: 'ls "$(printf src)"' }),
    permissionMode: "manual-approve",
    toolName: "bash",
  });
  assert(commandSubstitution !== null, "command substitutions are not whitelisted");

  const ordinaryCommand = await approvalRequest({
    arguments: JSON.stringify({ command: "npm test" }),
    permissionMode: "full-access",
    toolName: "bash",
  });
  assert(ordinaryCommand === null, "full access allows non-whitelisted shell commands");

  const privilegedRead = await approvalRequest({
    arguments: JSON.stringify({ command: "sudo ls" }),
    permissionMode: "full-access",
    toolName: "bash",
  });
  assert(
    privilegedRead === null,
    "full access delegates catastrophic command blocking to the native runner",
  );

  const outputWritingSort = await approvalRequest({
    arguments: JSON.stringify({ command: "sort input.txt -o output.txt" }),
    permissionMode: "manual-approve",
    toolName: "bash",
  });
  assert(outputWritingSort !== null, "commands with write modes are not whitelisted");

  const outsideCommand = await approvalRequest({
    arguments: JSON.stringify({ command: "ls /etc" }),
    permissionMode: "full-access",
    toolName: "bash",
  });
  assert(outsideCommand === null, "full access allows shell commands with external paths");

  const manualOutsideCommand = await approvalRequest({
    arguments: JSON.stringify({ command: "ls /etc" }),
    permissionMode: "manual-approve",
    toolName: "bash",
  });
  assert(
    manualOutsideCommand?.warning?.kind === "external-path",
    "manual mode asks before shell commands with external paths",
  );

  const manualPipelineOutsideCommand = await approvalRequest({
    arguments: JSON.stringify({ command: "find . -type f | cat /etc/hosts" }),
    permissionMode: "manual-approve",
    toolName: "bash",
  });
  assert(
    manualPipelineOutsideCommand?.warning?.kind === "external-path",
    "manual mode checks paths in every inspection pipeline stage",
  );

  const outsideCwd = await approvalRequest({
    arguments: JSON.stringify({ command: "ls", cwd: "/etc" }),
    permissionMode: "full-access",
    toolName: "bash",
  });
  assert(outsideCwd === null, "full access allows an external shell cwd");

  const dynamicTarget = await approvalRequest({
    arguments: JSON.stringify({ command: "ls $WIZZLE_TARGET" }),
    permissionMode: "full-access",
    toolName: "bash",
  });
  assert(dynamicTarget === null, "full access allows shell path variables");

  const dangerousCommand = await approvalRequest({
    arguments: JSON.stringify({ command: "rm -rf ." }),
    permissionMode: "full-access",
    toolName: "bash",
  });
  assert(dangerousCommand === null, "full access allows deletion inside the project");

  const sensitiveRead = await approvalRequest({
    arguments: JSON.stringify({ path: ".env.production" }),
    permissionMode: "full-access",
    toolName: "read",
  });
  assert(sensitiveRead?.warning?.kind === "sensitive-path", "sensitive reads require approval");

  const projectRead = await approvalRequest({
    arguments: JSON.stringify({ path: "src/main.ts" }),
    permissionMode: "manual-approve",
    toolName: "read",
  });
  assert(projectRead === null, "manual mode allows ordinary reads inside the project");

  const manualExternalRead = await approvalRequest({
    arguments: JSON.stringify({ path: "/etc/hosts" }),
    permissionMode: "manual-approve",
    toolName: "read",
  });
  assert(manualExternalRead?.warning?.kind === "external-path", "manual mode asks for external reads");

  const fullExternalRead = await approvalRequest({
    arguments: JSON.stringify({ path: "/etc/hosts" }),
    permissionMode: "full-access",
    toolName: "read",
  });
  assert(fullExternalRead === null, "full access allows ordinary external reads");

  const fullProjectWrite = await approvalRequest({
    arguments: JSON.stringify({ path: "src/generated.ts" }),
    permissionMode: "full-access",
    toolName: "write",
  });
  assert(fullProjectWrite === null, "full access allows in-project writes");

  const manualProjectWrite = await approvalRequest({
    arguments: JSON.stringify({ path: "src/generated.ts" }),
    permissionMode: "manual-approve",
    toolName: "write",
  });
  assert(manualProjectWrite !== null, "manual mode asks for in-project writes");

  const fullExternalWrite = await approvalRequest({
    arguments: JSON.stringify({ path: "/tmp/generated.ts" }),
    permissionMode: "full-access",
    toolName: "write",
  });
  assert(fullExternalWrite?.warning?.kind === "external-path", "external writes require approval");

  const sensitiveProjectWrite = await approvalRequest({
    arguments: JSON.stringify({ path: ".env.local" }),
    permissionMode: "full-access",
    toolName: "write",
  });
  assert(sensitiveProjectWrite === null, "full access does not prompt for in-project writes by name");

  const batchItems = ["one.txt", "two.txt", "three.txt"].map((path, index) => ({
    path,
    sessionId: defaults.sessionId,
    summary: `Read ${path}`,
    timeout: "1 minute",
    toolCallId: `batch-${index}`,
    toolName: "read" as const,
  }));
  const batchRequest = createToolApprovalBatchRequest(batchItems);
  assert(batchRequest.batchRequests?.length === 3, "groups approval requests from one tool batch");
  assert(batchRequest.toolCallId === "batch-0", "uses the first call to identify the batch prompt");
  assert(
    batchRequest.summary === "Wizzle wants to run 3 tool calls.",
    "summarizes the grouped approval",
  );
  assert(
    createToolApprovalBatchRequest([batchItems[0]]) === batchItems[0],
    "keeps a single approval request unchanged",
  );
  assertThrows(
    () =>
      createToolApprovalBatchRequest([
        batchItems[0],
        { ...batchItems[1], sessionId: "session-2" },
      ]),
    "rejects approval batches that span sessions",
  );

  console.log("tool-approval tests passed");
}

function assertThrows(callback: () => unknown, message: string) {
  try {
    callback();
  } catch {
    return;
  }

  throw new Error(message);
}

main().catch((error: unknown) => {
  console.error(error);
  throw error;
});
