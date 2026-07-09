import {
  resolvePostStreamAssistantAction,
  shouldFinalizeStreamingPartOnAssistantFinish,
} from "./assistant-stream-finish.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(
    resolvePostStreamAssistantAction({
      hadToolCallIntents: false,
      toolCallItemCount: 0,
    }).type === "finish_final",
    "no tools → finish final",
  );

  assert(
    resolvePostStreamAssistantAction({
      hadToolCallIntents: true,
      toolCallItemCount: 2,
    }).type === "sync_tools_then_finish_working",
    "tools → sync then finish working (#15)",
  );

  assert(
    resolvePostStreamAssistantAction({
      hadToolCallIntents: true,
      toolCallItemCount: 0,
    }).type === "malformed_tool_stream",
    "intents without items → malformed",
  );

  // Priority: items win over "intents only"
  assert(
    resolvePostStreamAssistantAction({
      hadToolCallIntents: false,
      toolCallItemCount: 1,
    }).type === "sync_tools_then_finish_working",
    "items alone still sync tools",
  );

  assert(
    shouldFinalizeStreamingPartOnAssistantFinish("content"),
    "content finalized",
  );
  assert(
    shouldFinalizeStreamingPartOnAssistantFinish("activity_content"),
    "activity finalized",
  );
  assert(
    !shouldFinalizeStreamingPartOnAssistantFinish("tool_call"),
    "tool_call not finalized as text stream",
  );
  assert(
    !shouldFinalizeStreamingPartOnAssistantFinish("tool_result"),
    "tool_result not finalized as text stream",
  );

  console.log("assistant-stream-finish tests passed");
}

main();
