(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {
  WIZZLE_CONTEXT_SAFETY_PERCENT: "5",
  WIZZLE_FRONTEND_LOG_MODE: "off",
  WIZZLE_OUTPUT_RESERVED_PERCENT: "10",
};

export {};

import type { Message, ModelReasoningConfig } from "../../types/workspace.ts";

const {
  buildEmergencyFinalizationRequest,
  EMERGENCY_FINAL_MAX_OUTPUT_TOKENS,
  hasUsableEmergencyFinalContent,
  resolveEmergencyFinalizationBudget,
  resolveEmergencyReasoningSelection,
  shouldAcceptBufferedMaxStepFinal,
} = await import("./emergency-finalization.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function message(input: Partial<Message> & Pick<Message, "id" | "role">): Message {
  return {
    content: "",
    createdAtLabel: "now",
    status: "done",
    turnId: "active-turn",
    ...input,
  };
}

function main() {
  assert(
    EMERGENCY_FINAL_MAX_OUTPUT_TOKENS === 6_144,
    "emergency output ceiling stays at 6K",
  );
  assert(
    resolveEmergencyFinalizationBudget({ maxContextTokens: 50_000 }).maxOutputTokens ===
      5_000,
    "50K context uses its smaller 10% reserve",
  );
  assert(
    resolveEmergencyFinalizationBudget({ maxContextTokens: 128_000 }).maxOutputTokens ===
      6_144,
    "large contexts cap the emergency response at 6K",
  );
  assert(
    resolveEmergencyFinalizationBudget({
      maxContextTokens: 128_000,
      maxOutputTokens: 4_000,
    }).maxOutputTokens === 4_000,
    "model output limits remain authoritative",
  );

  const reasoning: ModelReasoningConfig = {
    defaultVariantId: "default",
    variants: [
      { id: "default", inputs: [], label: "Default", request: [] },
      { id: "max", inputs: [], label: "Max", request: [] },
      { id: "none", inputs: [], label: "Off", request: [] },
    ],
  };
  assert(
    resolveEmergencyReasoningSelection(reasoning)?.variantId === "none",
    "emergency finalization prefers a declared off variant",
  );
  assert(
    resolveEmergencyReasoningSelection({
      defaultVariantId: "default",
      variants: reasoning.variants.slice(0, 2),
    })?.variantId === "default",
    "provider default is used when reasoning cannot be disabled",
  );
  assert(
    resolveEmergencyReasoningSelection({
      variants: [{ id: "high", inputs: [], label: "High", request: [] }],
    }) === undefined,
    "an arbitrary reasoning effort is never forced",
  );

  const huge = "x".repeat(500_000);
  const history: Message[] = [
    message({ content: "Implement the requested fix", id: "user", role: "user" }),
    ...Array.from({ length: 45 }, (_, index) =>
      message({
        content: JSON.stringify({ combinedOutput: `${index}:${huge}` }),
        id: `tool-${index}`,
        role: "tool" as const,
        toolCallId: `call-${index}`,
        toolName: index % 2 === 0 ? "shell" : "read",
      }),
    ),
  ];
  const request = buildEmergencyFinalizationRequest({
    compactedContext: {
      compactedTurnIds: ["old-turn"],
      summary: huge,
      tokens: 100_000,
      updatedAtMs: Date.now(),
    },
    currentTurnId: "active-turn",
    history,
    maxContextTokens: 128_000,
    previewFileMap: new Map(),
    systemPrompt: "Return a concise current status. Do not call tools.",
    planInstruction: `Continue the unfinished implementation-plan step. ${huge}`,
  });
  assert(
    request.estimatedInputTokens <= request.budget.inputTokens,
    "primary emergency projection always fits its input budget",
  );
  assert(
    request.retryEstimatedInputTokens <= 12_000,
    "semantic retry uses the smaller input projection",
  );
  assert(
    request.conversation.every((entry) => entry.role === "system" || entry.role === "user"),
    "emergency replay contains no provider tool protocol messages",
  );
  const projected = request.conversation.map((entry) => entry.content).join("\n");
  assert(projected.includes("Implement the requested fix"), "latest user request is retained");
  assert(projected.includes("Tool result"), "recent tool state is retained as text");
  assert(!projected.includes(huge), "huge raw output is never replayed verbatim");

  assert(hasUsableEmergencyFinalContent("Completed the work."), "normal final is usable");
  assert(
    !hasUsableEmergencyFinalContent("<tool_call>shell</tool_call>"),
    "raw tool syntax is not accepted as a final",
  );
  assert(
    shouldAcceptBufferedMaxStepFinal({
      content: "Completed the current portion; two plan steps remain.",
      injectedResponseCount: 0,
      isLastStep: true,
      requiredJoinPending: false,
    }),
    "a valid buffered final is kept at the step boundary",
  );
  assert(
    !shouldAcceptBufferedMaxStepFinal({
      content: "Stale summary",
      injectedResponseCount: 1,
      isLastStep: true,
      requiredJoinPending: false,
    }),
    "newly injected results require a fresh emergency final",
  );

  console.log("emergency-finalization tests passed");
}

main();
