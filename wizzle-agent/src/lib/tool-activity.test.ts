import { buildActivitySegments } from "./tool-activity.ts";
import type { MessagePart } from "../types/workspace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function toolCall(id: string, parentPartId: string): MessagePart {
  return {
    id: `${parentPartId}-tool-call-${id}`,
    input: "{}",
    name: "read",
    parentPartId,
    status: "done",
    toolCallId: id,
    type: "tool_call",
  };
}

function toolResult(id: string, parentPartId: string): MessagePart {
  return {
    id: `message-tool-${id}-result`,
    output: "{}",
    parentPartId,
    status: "done",
    toolCallId: id,
    type: "tool_result",
  };
}

function main() {
  const splitSegments = buildActivitySegments([
    toolCall("call-1", "assistant-1"),
    toolResult("call-1", "assistant-1-tool-call-call-1"),
    toolCall("call-2", "assistant-2"),
    toolResult("call-2", "assistant-2-tool-call-call-2"),
  ]);

  assert(splitSegments.length === 2, "separate assistant tool batches split");
  assert(
    splitSegments.every((segment) => segment.type === "tool_group"),
    "both split segments are tool groups",
  );
  assert(
    splitSegments[0]?.type === "tool_group" &&
      splitSegments[0].runs.map((run) => run.id).join(",") === "call-1",
    "first split group has first call",
  );
  assert(
    splitSegments[1]?.type === "tool_group" &&
      splitSegments[1].runs.map((run) => run.id).join(",") === "call-2",
    "second split group has second call",
  );

  const monologueSegments = buildActivitySegments([
    toolCall("call-3", "assistant-3"),
    toolResult("call-3", "assistant-3-tool-call-call-3"),
    {
      content: "I found the config and will inspect the test next.",
      id: "assistant-4-activity",
      parentPartId: "assistant-4",
      status: "done",
      type: "activity_content",
    },
    toolCall("call-4", "assistant-4"),
  ]);

  assert(monologueSegments.length === 3, "monologue stays between tool groups");
  assert(monologueSegments[1]?.type === "part", "middle segment is activity content");
  assert(
    monologueSegments[1]?.type === "part" &&
      monologueSegments[1].part.content === "I found the config and will inspect the test next.",
    "activity content is preserved verbatim",
  );

  console.log("tool-activity tests passed");
}

main();
