(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {
  WIZZLE_FRONTEND_LOG_MODE: "off",
};

export {};

import type { Message } from "../../types/workspace.ts";

const { createTestRemoteConfig } = await import("../remote-config.test-fixture.ts");
const { installRemoteConfigForTests } = await import("../remote-config.ts");
installRemoteConfigForTests(createTestRemoteConfig());

const {
  CONTEXT_CONTINUE_PROMPT,
  containsRawToolSyntax,
  extractUserAndFinalMessages,
  persistPendingImplementationPlanForContextContinuation,
  pickFinalAssistantMessage,
  resolveContextPressureSystemPrompt,
  shouldAutoContinueAfterExceptionalFinish,
  shouldEnterContextPressure,
} = await import("./context-pressure.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const contextPressureSystemPrompt = resolveContextPressureSystemPrompt();
  assert(contextPressureSystemPrompt.split("\n").length <= 5, "short system ≤5 lines");
  assert(contextPressureSystemPrompt.includes("brief status"), "brief request is in system prompt");
  assert(contextPressureSystemPrompt.includes("Do not call tools"), "tools disabled by prompt");
  assert(CONTEXT_CONTINUE_PROMPT.includes("Continue previous task"), "continue prompt");
  assert(
    shouldAutoContinueAfterExceptionalFinish("context_pressure") &&
      shouldAutoContinueAfterExceptionalFinish("max_steps"),
    "both exceptional limits continue after settle and compaction",
  );
  assert(
    !shouldAutoContinueAfterExceptionalFinish("done") &&
      !shouldAutoContinueAfterExceptionalFinish("interrupted"),
    "normal completion and user interruption never auto-continue",
  );

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

  let persistCount = 0;
  assert(
    await persistPendingImplementationPlanForContextContinuation({
      hasPendingPlan: true,
      persistPlan: async () => {
        persistCount += 1;
      },
    }),
    "unfinished plan is preserved instead of blocking context continuation",
  );
  assert(persistCount === 1, "unfinished plan is persisted at the pressure boundary");
  assert(
    !(await persistPendingImplementationPlanForContextContinuation({
      hasPendingPlan: false,
      persistPlan: async () => {
        persistCount += 1;
      },
    })),
    "completed plan needs no pressure-boundary persistence",
  );
  assert(persistCount === 1, "completed plan does not trigger persistence");
  assert(
    !(await persistPendingImplementationPlanForContextContinuation({
      hasPendingPlan: true,
      persistPlan: async () => false,
    })),
    "failed plan persistence is reported instead of claimed as preserved",
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

  assert(
    containsRawToolSyntax(
      '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="read"><｜｜DSML｜｜parameter name="path">x</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>',
    ),
    "detect DSML tool syntax",
  );
  assert(containsRawToolSyntax("<tool_call>read</tool_call>"), "detect generic tool syntax");
  assert(!containsRawToolSyntax("Completed the requested review."), "allow normal brief text");

  const invalidFinalMessages: Message[] = [
    messages[0]!,
    messages[1]!,
    {
      assistantPhase: "final",
      content: "<tool_call>read</tool_call>",
      createdAtLabel: "now",
      id: "raw-final",
      role: "assistant",
      status: "done",
      turnId: "t1",
    },
  ];
  assert(
    pickFinalAssistantMessage(invalidFinalMessages) === null,
    "invalid explicit final does not fall back to working narration",
  );

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

await main();
