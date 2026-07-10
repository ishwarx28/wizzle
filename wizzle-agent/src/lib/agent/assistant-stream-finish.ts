/**
 * Ordering for post-stream assistant finalization (#14 / #15).
 * Tool calls must land on the assistant message before the stream is finished
 * when the step intends tools — otherwise the message can persist as done
 * without tool_call parts.
 */

export type PostStreamAssistantAction =
  | { type: "finish_final" }
  | { type: "malformed_tool_stream" }
  | { type: "sync_tools_then_finish_working" };

export function resolvePostStreamAssistantAction(options: {
  hadToolCallIntents: boolean;
  toolCallItemCount: number;
}): PostStreamAssistantAction {
  if (options.toolCallItemCount > 0) {
    return { type: "sync_tools_then_finish_working" };
  }

  if (options.hadToolCallIntents) {
    return { type: "malformed_tool_stream" };
  }

  return { type: "finish_final" };
}

/** Parts that are text stream leftovers; tool_call / tool_result stay as-is. */
export function shouldFinalizeStreamingPartOnAssistantFinish(partType: string | undefined) {
  return (
    partType === "content" ||
    partType === "activity_content" ||
    partType === "reasoning"
  );
}
