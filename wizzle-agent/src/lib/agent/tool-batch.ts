import type { ToolCall } from "../../types/workspace";

const TERMINAL_TOOL_STATUSES = new Set(["done", "error", "interrupted"]);

/** Context selection is safe only after every call in the emitted batch is terminal. */
export function findIncompleteToolCallIds(toolCalls: readonly ToolCall[]) {
  return toolCalls
    .filter((toolCall) => !toolCall.status || !TERMINAL_TOOL_STATUSES.has(toolCall.status))
    .map((toolCall) => toolCall.id);
}
