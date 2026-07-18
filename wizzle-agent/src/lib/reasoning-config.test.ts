import type { Message, ModelReasoningConfig } from "../types/workspace.ts";

(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {
  WIZZLE_FRONTEND_LOG_MODE: "off",
  WIZZLE_FRONTEND_LOG_RETENTION_DAYS: "7",
};

const {
  attachReasoningReplaySource,
  automaticReasoningSelection,
  modelReasoningDropdownVariants,
  mergeReasoningReplayEntry,
  normalizeReasoningSelection,
  reasoningRecipeHash,
  reasoningReplayForModel,
  reasoningVariantDisplayLabel,
} = await import("./reasoning-config.ts");
const { buildChatMessages } = await import("./chat-stream.ts");
const { isCompactableReplayBlock } = await import("./context-budget.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const reasoning: ModelReasoningConfig = {
  defaultVariantId: "custom",
  replay: {
    capture: [
      {
        assistantMessagePath: "/reasoning_content",
        operation: "merge",
        responsePath: "/choices/0/delta/reasoning_content",
      },
    ],
    preserveExactly: true,
    scope: "active_tool_loop",
  },
  variants: [
    {
      id: "custom",
      inputs: [{ default: 1024, id: "budget", max: 8192, min: 512, type: "integer" }],
      label: "Custom",
      request: [
        { operation: "set", path: "/thinking/budget", value: { $input: "budget" } },
      ],
    },
  ],
};

function main() {
  const dropdownVariants = modelReasoningDropdownVariants({
    defaultVariantId: "default",
    variants: [
      { id: "default", inputs: [], label: "Provider default", request: [] },
      { id: "high", inputs: [], label: "High", request: [] },
      { id: "none", inputs: [], label: "None", request: [] },
      { id: "max", inputs: [], label: "Max", request: [] },
    ],
  });
  assert(
    dropdownVariants.map((variant) => variant.id).join(",") === "none,default,high,max",
    "reasoning dropdown puts supported off and provider-default choices first",
  );
  assert(
    reasoningVariantDisplayLabel(dropdownVariants[0]!) === "Off",
    "none-style disable variants use the consistent Off label",
  );
  assert(
    reasoningVariantDisplayLabel(dropdownVariants[1]!) === "Default",
    "provider-owned defaults use the concise Default label",
  );

  const selection = normalizeReasoningSelection("", reasoning);
  assert(selection.variantId === "custom", "first configured variant is the model default");
  assert(selection.inputs.budget === 1024, "missing input uses its declared default");
  assert(
    normalizeReasoningSelection(
      JSON.stringify({ inputs: { budget: 99_999 }, variantId: "custom" }),
      reasoning,
    ).inputs.budget === 1024,
    "out-of-range persisted input falls back to the model-declared default",
  );
  assert(
    automaticReasoningSelection(reasoning)?.inputs.budget === 1024,
    "detached helper calls use the model-declared first variant and input default",
  );

  const appendedOnce = mergeReasoningReplayEntry([], {
    assistantMessagePath: "/content",
    operation: "append",
    value: "a",
  });
  const appendedTwice = mergeReasoningReplayEntry(appendedOnce, {
    assistantMessagePath: "/content",
    operation: "append",
    value: "b",
  });
  assert(
    appendedTwice[0]?.value === "ab",
    "append capture joins streamed string fragments in order",
  );
  const appendedNull = mergeReasoningReplayEntry(appendedTwice, {
    assistantMessagePath: "/content",
    operation: "append",
    value: null,
  });
  assert(
    appendedNull === appendedTwice && appendedNull[0]?.value === "ab",
    "append capture ignores terminal null chunks without converting text to an array",
  );
  const prependedUndefined = mergeReasoningReplayEntry(appendedTwice, {
    assistantMessagePath: "/content",
    operation: "prepend",
    value: undefined,
  });
  assert(
    prependedUndefined === appendedTwice && prependedUndefined[0]?.value === "ab",
    "prepend capture ignores undefined chunks without converting text to an array",
  );
  assert(
    mergeReasoningReplayEntry([], {
      assistantMessagePath: "/content",
      operation: "append",
      value: null,
    }).length === 0 &&
      mergeReasoningReplayEntry([], {
        assistantMessagePath: "/content",
        operation: "prepend",
        value: undefined,
      }).length === 0,
    "nullish ordered chunks do not create empty replay entries",
  );
  const appendedObjects = mergeReasoningReplayEntry(
    mergeReasoningReplayEntry([], {
      assistantMessagePath: "/reasoning_details",
      operation: "append",
      value: { id: "a" },
    }),
    {
      assistantMessagePath: "/reasoning_details",
      operation: "append",
      value: { id: "b" },
    },
  );
  assert(
    Array.isArray(appendedObjects[0]?.value) && appendedObjects[0]?.value.length === 2,
    "append capture retains structured replay values as an ordered array",
  );
  const prependedObject = mergeReasoningReplayEntry(
    mergeReasoningReplayEntry([], {
      assistantMessagePath: "/reasoning_details",
      operation: "prepend",
      value: [{ id: "b" }, { id: "c" }],
    }),
    {
      assistantMessagePath: "/reasoning_details",
      operation: "prepend",
      value: { id: "a" },
    },
  );
  assert(
    Array.isArray(prependedObject[0]?.value) &&
      (prependedObject[0]?.value as Array<{ id: string }>).map((value) => value.id).join(",") ===
        "a,b,c",
    "prepend capture preserves structured array order",
  );

  const setTwice = mergeReasoningReplayEntry(
    mergeReasoningReplayEntry([], {
      assistantMessagePath: "/signature",
      operation: "set",
      value: "old",
    }),
    {
      assistantMessagePath: "/signature",
      operation: "set",
      value: "new",
    },
  );
  assert(setTwice[0]?.value === "new", "set capture keeps the latest streamed value");
  const setNull = mergeReasoningReplayEntry(setTwice, {
    assistantMessagePath: "/signature",
    operation: "set",
    value: null,
  });
  assert(
    setNull === setTwice && setNull[0]?.value === "new",
    "set capture ignores a terminal null chunk instead of erasing captured metadata",
  );

  const mergedDetails = mergeReasoningReplayEntry(
    mergeReasoningReplayEntry([], {
      assistantMessagePath: "/reasoning_details",
      operation: "merge",
      value: { signature: "opaque", status: "streaming" },
    }),
    {
      assistantMessagePath: "/reasoning_details",
      operation: "merge",
      value: { status: null },
    },
  );
  assert(
    JSON.stringify(mergedDetails[0]?.value) ===
      JSON.stringify({ signature: "opaque", status: null }),
    "merge capture preserves null nested inside provider-owned structured metadata",
  );
  const mergedNull = mergeReasoningReplayEntry(mergedDetails, {
    assistantMessagePath: "/reasoning_details",
    operation: "merge",
    value: null,
  });
  assert(
    mergedNull === mergedDetails && mergedNull[0]?.value === mergedDetails[0]?.value,
    "merge capture ignores a terminal null chunk instead of erasing captured metadata",
  );
  assert(
    ["set", "merge"].every(
      (operation) =>
        mergeReasoningReplayEntry([], {
          assistantMessagePath: "/reasoning_details",
          operation: operation as "set" | "merge",
          value: undefined,
        }).length === 0,
    ),
    "nullish set and merge chunks do not create empty replay entries",
  );

  const sourced = attachReasoningReplaySource({
    entries: [
      {
        assistantMessagePath: "/reasoning_content",
        operation: "merge",
        value: "opaque",
      },
    ],
    modelId: "model-a",
    reasoning,
  });
  assert(
    reasoningReplayForModel({ entries: sourced, modelId: "model-a", reasoning }).length === 1,
    "matching model and recipe may replay opaque metadata",
  );
  assert(
    reasoningReplayForModel({ entries: sourced, modelId: "model-b", reasoning }).length === 0,
    "model switch cannot replay another model's metadata",
  );
  assert(
    reasoningRecipeHash(reasoning) ===
      reasoningRecipeHash({
        replay: reasoning.replay,
        variants: reasoning.variants,
        defaultVariantId: reasoning.defaultVariantId,
      }),
    "recipe hash is independent of object key insertion order",
  );

  const assistant: Message = {
    content: "",
    createdAtLabel: "now",
    id: "assistant",
    parts: [
      {
        id: "tool-part",
        input: "{}",
        name: "read",
        status: "done",
        toolCallId: "call-1",
        type: "tool_call",
      },
    ],
    reasoningReplay: sourced,
    role: "assistant",
    status: "done",
    turnId: "turn-1",
  };
  const replay = buildChatMessages([assistant], new Map(), ["text"], {
    currentTurnId: "turn-1",
    modelId: "model-a",
    reasoning,
  });
  assert(
    "__wizzle_reasoning_replay" in (replay[0] ?? {}),
    "active tool-loop request contains matching required replay metadata",
  );
  const switched = buildChatMessages([assistant], new Map(), ["text"], {
    currentTurnId: "turn-1",
    modelId: "model-b",
    reasoning,
  });
  assert(
    !("__wizzle_reasoning_replay" in (switched[0] ?? {})),
    "active tool-loop request omits replay metadata after a model switch",
  );
  const toolTurnReplay: ModelReasoningConfig = {
    ...reasoning,
    replay: { ...reasoning.replay!, scope: "tool_call_turns" },
  };
  const toolTurnEntries = attachReasoningReplaySource({
    entries: sourced,
    modelId: "model-a",
    reasoning: toolTurnReplay,
  });
  assert(
    !isCompactableReplayBlock(
      {
        blockId: "turn-1",
        isActiveTurn: false,
        isCompleted: true,
        messages: [{ ...assistant, reasoningReplay: toolTurnEntries }],
        turnId: "turn-1",
      },
      "turn-2",
      toolTurnReplay,
      "model-a",
    ),
    "exact provider-required tool-turn replay remains verbatim",
  );
}

main();
console.log("reasoning config tests passed");
