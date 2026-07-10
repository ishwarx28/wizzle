import type { ToolApprovalRequest } from "../types/workspace";

/** Which approval (if any) should be shown for the selected session. */
export function resolveVisibleToolApproval(
  selectedSessionId: string | null | undefined,
  pendingBySessionId: Record<string, ToolApprovalRequest>,
): ToolApprovalRequest | null {
  if (!selectedSessionId) {
    return null;
  }

  return pendingBySessionId[selectedSessionId] ?? null;
}

/** Whether switching sessions should keep a pending approval waiter alive. */
export function shouldKeepApprovalOnSessionSwitch() {
  return true;
}
