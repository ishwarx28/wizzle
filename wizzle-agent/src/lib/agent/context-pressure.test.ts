(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {
  WIZZLE_FRONTEND_LOG_MODE: "off",
};

export {};

import type { Message } from "../../types/workspace.ts";

const {
  CONTEXT_CONTINUE_PROMPT,
  CONTEXT_PRESSURE_FINAL_NUDGE,
  CONTEXT_PRESSURE_SYSTEM_PROMPT,
  extractUserAndFinalMessages,
  pickFinalAssistantMessage,
  shouldEnterContextPressure,
  stripToolRoleMessages,
} = await import("./context-pressure.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(CONTEXT_PRESSURE_SYSTEM_PROMPT.split("\n").length <= 5, "short system ≤5 lines");
  assert(
    CONTEXT_PRESSURE_FINAL_NUDGE.includes("last user request / task"),
    "nudge wording",
  );
  assert(CONTEXT_CONTINUE_PROMPT.includes("Continue previous task"), "continue prompt");

  assert(
    shouldEnterContextPressure({ usedToolsInTurn: true, code: "current_message_too_large" }),
    "pressure after tools on active overflow",
  );
  assert(
    !shouldEnterContextPressure({ usedToolsInTurn: false, code: "current_message_too_large" }),
    "no pressure before tools",
  );
  assert(
    !shouldEnterContextPressure({
      usedToolsInTurn: true,
      code: "system_tool_prompt_too_large",
    }),
    "no pressure for fixed-cost overflow",
  );

  const messages: Message[] = [
    {
      content: "find bugs",
      createdAtLabel: "now",
      id: "u1",
      role: "user",
      status: "done",
      turnId: "t1",
    },
    {
      assistantPhase: "working",
      content: "looking…",
      createdAtLabel: "now",
      id: "a1",
      role: "assistant",
      status: "done",
      turnId: "t1",
    },
    {
      content: "tool out",
      createdAtLabel: "now",
      id: "tool1",
      role: "tool",
      status: "done",
      turnId: "t1",
    },
    {
      assistantPhase: "final",
      content: "Found 3 issues: A, B, C",
      createdAtLabel: "now",
      id: "a2",
      role: "assistant",
      status: "done",
      turnId: "t1",
    },
  ];

  const pair = extractUserAndFinalMessages(messages);
  assert(pair.length === 2, "user + final");
  assert(pair[0]?.role === "user" && pair[0].content === "find bugs", "user kept");
  assert(pair[1]?.id === "a2" && !pair[1]?.toolCalls, "final only, no tools");
  assert(pickFinalAssistantMessage(messages)?.id === "a2", "picks final phase");

  const slim = stripToolRoleMessages(messages);
  assert(slim.every((message) => message.role !== "tool"), "strip tools");
  assert(slim.length === 3, "three non-tool messages");

  assert(
    extractUserAndFinalMessages([
      {
        content: "only user",
        createdAtLabel: "now",
        id: "u-only",
        role: "user",
        status: "done",
        turnId: "t-empty",
      },
    ]).length === 0,
    "skip without usable final",
  );

  console.log("context-pressure tests passed");
}

main();
