import {
  buildDisplayMessages,
  getAssistantConversationContent,
  getMessageContent,
  resolveAssistantDurableContentFromParts,
  synchronizeMessageFromParts,
} from "./message-parts.ts";
import type { Message, MessagePart } from "../types/workspace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assistantWithActivityOnly(): Message {
  return {
    content: "",
    createdAtLabel: "now",
    createdAtMs: 1,
    id: "message-assistant-1",
    parts: [
      {
        content: "Looking at the file…",
        id: "p-activity",
        status: "done",
        type: "activity_content",
      },
      {
        id: "p-tool",
        input: "{}",
        name: "read",
        status: "done",
        toolCallId: "tc1",
        type: "tool_call",
      },
    ],
    role: "assistant",
    status: "done",
    turnId: "turn-1",
  };
}

function main() {
  const durable = resolveAssistantDurableContentFromParts([
    { content: "pre ", id: "a", type: "activity_content" },
    { content: "final", id: "c", type: "content" },
  ] as MessagePart[]);
  assert(durable === "pre final", "activity + content join");

  const message = assistantWithActivityOnly();
  synchronizeMessageFromParts(message);
  assert(
    message.content === "Looking at the file…",
    "sync folds activity into message.content (#49/#50)",
  );
  assert(
    getAssistantConversationContent(message) === "Looking at the file…",
    "conversation content includes activity (#51)",
  );
  assert(
    getMessageContent(message) === "",
    "final bubble content stays empty when only activity (no double-render)",
  );

  const withFinal: Message = {
    ...assistantWithActivityOnly(),
    id: "message-assistant-2",
    parts: [
      {
        content: "Working…",
        id: "p-a",
        status: "done",
        type: "activity_content",
      },
      {
        content: "Here is the answer.",
        id: "p-c",
        status: "done",
        type: "content",
      },
    ],
  };
  synchronizeMessageFromParts(withFinal);
  assert(
    withFinal.content === "Working…Here is the answer.",
    "sync joins activity then final",
  );
  assert(
    getMessageContent(withFinal) === "Here is the answer.",
    "final bubble only content parts",
  );
  assert(
    getAssistantConversationContent(withFinal) === "Working…Here is the answer.",
    "replay sees both",
  );

  const display = buildDisplayMessages([withFinal]);
  assert(display.length === 1, "one display message");
  assert(
    display[0]?.content === "Here is the answer.",
    "display bubble is final content only",
  );
  assert(
    display[0]?.parts.some((part) => part.type === "activity_content"),
    "activity part still on display for panel",
  );

  // After sync, empty content parts path still keeps durable content for no-parts consumers
  const anchorOnly: Message = {
    content: "legacy text",
    createdAtLabel: "now",
    id: "message-assistant-3",
    role: "assistant",
    status: "done",
  };
  assert(
    getAssistantConversationContent(anchorOnly) === "legacy text",
    "legacy no-parts falls back to content",
  );

  console.log("message-parts tests passed");
}

main();
