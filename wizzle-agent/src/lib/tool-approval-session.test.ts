import {
  resolveVisibleToolApproval,
  shouldKeepApprovalOnSessionSwitch,
} from "./tool-approval-session.ts";
import type { ToolApprovalRequest } from "../types/workspace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function approval(sessionId: string, toolCallId: string): ToolApprovalRequest {
  return {
    sessionId,
    summary: "test",
    timeout: "30s",
    toolCallId,
    toolName: "bash",
  };
}

function main() {
  assert(shouldKeepApprovalOnSessionSwitch(), "keep approval across switches");

  const pending = {
    "session-a": approval("session-a", "call-1"),
    "session-b": approval("session-b", "call-2"),
  };

  assert(
    resolveVisibleToolApproval("session-a", pending)?.toolCallId === "call-1",
    "show session a approval",
  );
  assert(
    resolveVisibleToolApproval("session-b", pending)?.toolCallId === "call-2",
    "show session b approval",
  );
  assert(resolveVisibleToolApproval("session-c", pending) === null, "no approval for other");
  assert(resolveVisibleToolApproval(null, pending) === null, "no selection");

  console.log("tool-approval-session tests passed");
}

main();
