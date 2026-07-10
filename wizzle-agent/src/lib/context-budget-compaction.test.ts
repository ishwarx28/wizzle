import type { Message } from "../types/workspace.ts";

// vite injects this at build time; node tests need a stub before env.ts loads.
(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {
  WIZZLE_FRONTEND_LOG_MODE: "off",
  WIZZLE_FRONTEND_LOG_RETENTION_DAYS: "7",
};

const {
  buildReplayBlocks,
  estimateConversationTokens,
  isCompactableReplayBlock,
  selectReinflatedCompactedTurns,
  selectReplayHistoryWithinBudget,
} = await import("./context-budget.ts");
const {
  COMPACTION_SYSTEM_PROMPT,
  buildCompactionHistoryText,
  estimateCompactionRequestTokens,
  selectOldestCompactionBatch,
} = await import("./agent/compaction.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function makeUserMessage(options: {
  id: string;
  turnId: string;
  content: string;
}): Message {
  return {
    content: options.content,
    createdAtLabel: "now",
    createdAtMs: 1,
    id: options.id,
    role: "user",
    status: "done",
    turnId: options.turnId,
  };
}

function makeAssistantMessage(options: {
  id: string;
  turnId: string;
  content: string;
}): Message {
  return {
    content: options.content,
    createdAtLabel: "now",
    createdAtMs: 2,
    id: options.id,
    role: "assistant",
    status: "done",
    turnId: options.turnId,
  };
}

function pad(label: string, approxTokens: number) {
  // estimateTextTokens ≈ ceil(len / 3.5) with unknown-tokenizer multiplier 1.15
  const chars = Math.ceil(approxTokens * 3.5);
  return `${label}:${"x".repeat(Math.max(0, chars - label.length - 1))}`;
}

function main() {
  // --- Live selection: drop oldest first, keep newest + active ---
  const turnA = "turn-a";
  const turnB = "turn-b";
  const turnC = "turn-c";
  const turnActive = "turn-active";
  const history: Message[] = [
    makeUserMessage({ id: "u-a", turnId: turnA, content: pad("A", 400) }),
    makeAssistantMessage({ id: "a-a", turnId: turnA, content: pad("Aa", 400) }),
    makeUserMessage({ id: "u-b", turnId: turnB, content: pad("B", 400) }),
    makeAssistantMessage({ id: "a-b", turnId: turnB, content: pad("Bb", 400) }),
    makeUserMessage({ id: "u-c", turnId: turnC, content: pad("C", 400) }),
    makeAssistantMessage({ id: "a-c", turnId: turnC, content: pad("Cc", 400) }),
    makeUserMessage({ id: "u-d", turnId: turnActive, content: pad("D", 200) }),
  ];

  // Tiny window forces dropping older completed turns while keeping active.
  const selection = selectReplayHistoryWithinBudget({
    currentTurnId: turnActive,
    history,
    maxContext: 4_000,
    maxOutputTokens: 500,
    modelCapabilities: ["text"],
    previewFileMap: new Map(),
    systemPrompt: pad("SYS", 200),
    tools: [
      {
        type: "function",
        function: {
          name: "bash",
          description: pad("tool-desc", 300),
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });

  assert(selection.droppedTurnIds.length > 0, "should drop some older turns");
  assert(selection.droppedTurnIds[0] === turnA, "oldest completed turn dropped first");
  assert(!selection.droppedTurnIds.includes(turnActive), "active turn never dropped");
  assert(
    selection.messages.some((message) => message.turnId === turnActive),
    "active turn kept in live messages",
  );
  // Dropped ids are oldest → newer order
  for (let index = 1; index < selection.droppedTurnIds.length; index += 1) {
    const prev = selection.droppedTurnIds[index - 1]!;
    const next = selection.droppedTurnIds[index]!;
    const order = [turnA, turnB, turnC];
    assert(order.indexOf(prev) < order.indexOf(next), "droppedTurnIds oldest→newer");
  }

  // --- Compaction batch budget ignores agent tools (only compaction prompt) ---
  const blocks = buildReplayBlocks(history, turnActive);
  const hugeToolsEstimate = estimateConversationTokens({
    messages: [{ role: "system", content: COMPACTION_SYSTEM_PROMPT }],
    tools: [
      {
        type: "function",
        function: {
          name: "bash",
          description: pad("huge-tools", 20_000),
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });
  const compactOnlyEstimate = estimateCompactionRequestTokens({
    historyText: "short",
    previousSummary: null,
  });
  assert(
    compactOnlyEstimate < hugeToolsEstimate / 2,
    "compaction estimate must not include agent-scale tools",
  );

  const batch = selectOldestCompactionBatch({
    blocks,
    candidateTurnIds: selection.droppedTurnIds,
    currentTurnId: turnActive,
    maxContext: 128_000,
    maxOutputTokens: 8_192,
    previousContext: null,
    previewFileMap: new Map(),
    tokenLimit: 5_120,
  });
  assert(batch.length > 0, "batch packs at least oldest dropped turn");
  assert(batch[0] === selection.droppedTurnIds[0], "batch starts with oldest candidate");
  // Batch only contains ids from the candidate list, in the same relative order
  let lastIndex = -1;
  for (const turnId of batch) {
    const index = selection.droppedTurnIds.indexOf(turnId);
    assert(index > lastIndex, "batch preserves oldest→newer order");
    lastIndex = index;
  }

  // Already-compacted turns are skipped for live drop set
  const afterPartial = selectReplayHistoryWithinBudget({
    compactedContext: {
      compactedTurnIds: [turnA],
      summary: "Goal: keep going",
      tokens: 20,
      updatedAtMs: 1,
    },
    currentTurnId: turnActive,
    history,
    maxContext: 4_000,
    maxOutputTokens: 500,
    modelCapabilities: ["text"],
    previewFileMap: new Map(),
    systemPrompt: pad("SYS", 200),
    tools: [
      {
        type: "function",
        function: {
          name: "bash",
          description: pad("tool-desc", 300),
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });
  assert(!afterPartial.droppedTurnIds.includes(turnA), "already compacted not re-dropped");
  assert(
    afterPartial.droppedTurnIds.length === 0 || afterPartial.droppedTurnIds[0] === turnB,
    "next oldest non-compacted is first to drop",
  );

  // --- Residual reinflate: last compacted turns as user+final only ---
  const reinflateHistory: Message[] = [
    makeUserMessage({ id: "ru-a", turnId: turnA, content: "issue list please" }),
    makeAssistantMessage({ id: "ra-a", turnId: turnA, content: "Issues: 1, 2, 3" }),
    makeUserMessage({ id: "ru-b", turnId: turnB, content: "more" }),
    makeAssistantMessage({ id: "ra-b", turnId: turnB, content: "Issues: 4, 5" }),
    makeUserMessage({ id: "ru-c", turnId: turnC, content: "and more" }),
    makeAssistantMessage({ id: "ra-c", turnId: turnC, content: "Issues: 6" }),
    makeUserMessage({ id: "ru-d", turnId: turnActive, content: "continue work" }),
  ];
  // Insert tool noise into turn A — reinflate must ignore it.
  reinflateHistory.splice(2, 0, {
    content: "huge tool dump " + "x".repeat(200),
    createdAtLabel: "now",
    id: "tool-a",
    role: "tool",
    status: "done",
    turnId: turnA,
  });

  const reinflateSelection = selectReplayHistoryWithinBudget({
    compactedContext: {
      compactedTurnIds: [turnA, turnB, turnC],
      summary: "Identified several issues. Goal: keep fixing.",
      tokens: 40,
      updatedAtMs: 1,
    },
    currentTurnId: turnActive,
    history: reinflateHistory,
    maxContext: 128_000,
    maxOutputTokens: 1_000,
    modelCapabilities: ["text"],
    previewFileMap: new Map(),
    systemPrompt: "sys",
  });
  assert(
    reinflateSelection.reinflatedTurnIds.length >= 1,
    "reinflates at least one compacted turn when residual room",
  );
  assert(
    reinflateSelection.reinflatedTurnIds.length <= 5,
    "cap reinflate at 5",
  );
  assert(
    !reinflateSelection.messages.some((message) => message.role === "tool"),
    "reinflate excludes tool activity",
  );
  assert(
    reinflateSelection.messages.some((message) => message.content === "Issues: 1, 2, 3"),
    "reinflated final keeps concrete findings",
  );
  assert(
    reinflateSelection.messages.some((message) => message.turnId === turnActive),
    "live active turn still present",
  );

  const reinflateEmpty = selectReinflatedCompactedTurns({
    blocks: buildReplayBlocks(reinflateHistory, turnActive),
    compactedTurnIds: new Set([turnA, turnB, turnC]),
    estimateMessages: () => 10_000,
    residualTokens: 5,
  });
  assert(reinflateEmpty.turnIds.length === 0, "no reinflate when residual too small");

  // --- #34: interrupted / error historical turns are compactable and batchable ---
  const turnInterrupted = "turn-interrupted";
  const turnError = "turn-error";
  const interruptedHistory: Message[] = [
    {
      ...makeUserMessage({
        id: "u-int",
        turnId: turnInterrupted,
        content: pad("INT", 500),
      }),
      status: "done",
    },
    {
      ...makeAssistantMessage({
        id: "a-int",
        turnId: turnInterrupted,
        content: pad("INTA", 500),
      }),
      status: "interrupted",
    },
    {
      ...makeUserMessage({
        id: "u-err",
        turnId: turnError,
        content: pad("ERR", 500),
      }),
      status: "done",
    },
    {
      ...makeAssistantMessage({
        id: "a-err",
        turnId: turnError,
        content: pad("ERRA", 500),
      }),
      status: "error",
    },
    makeUserMessage({ id: "u-act2", turnId: turnActive, content: pad("ACT", 200) }),
  ];

  const interruptedBlocks = buildReplayBlocks(interruptedHistory, turnActive);
  const interruptedBlock = interruptedBlocks.find((block) => block.turnId === turnInterrupted);
  const errorBlock = interruptedBlocks.find((block) => block.turnId === turnError);
  assert(interruptedBlock, "interrupted block exists");
  assert(errorBlock, "error block exists");
  assert(
    isCompactableReplayBlock(interruptedBlock, turnActive),
    "interrupted turn is compactable for live drop",
  );
  assert(isCompactableReplayBlock(errorBlock, turnActive), "error turn is compactable for live drop");

  const interruptedSelection = selectReplayHistoryWithinBudget({
    currentTurnId: turnActive,
    history: interruptedHistory,
    maxContext: 3_500,
    maxOutputTokens: 500,
    modelCapabilities: ["text"],
    previewFileMap: new Map(),
    systemPrompt: pad("SYS", 200),
    tools: [
      {
        type: "function",
        function: {
          name: "bash",
          description: pad("tool-desc", 300),
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });
  assert(
    interruptedSelection.droppedTurnIds.includes(turnInterrupted),
    "interrupted turn can be dropped for live budget",
  );
  assert(
    interruptedSelection.droppedTurnIds.includes(turnError) ||
      interruptedSelection.droppedTurnIds[0] === turnInterrupted,
    "error/interrupted turns participate in drop order",
  );

  const interruptedBatch = selectOldestCompactionBatch({
    blocks: interruptedBlocks,
    candidateTurnIds: interruptedSelection.droppedTurnIds,
    currentTurnId: turnActive,
    maxContext: 128_000,
    maxOutputTokens: 8_192,
    previousContext: null,
    previewFileMap: new Map(),
    tokenLimit: 5_120,
  });
  assert(interruptedBatch.length > 0, "batch includes terminal non-done history (#34)");
  assert(
    interruptedBatch.every((turnId) => interruptedSelection.droppedTurnIds.includes(turnId)),
    "batch only uses live-dropped candidates (no silent omit)",
  );
  // Every live-dropped id must be batchable (same eligibility) so agent-runner can compact them.
  for (const turnId of interruptedSelection.droppedTurnIds) {
    const block = interruptedBlocks.find((entry) => entry.turnId === turnId);
    assert(block && isCompactableReplayBlock(block, turnActive), `dropped ${turnId} must be batchable`);
  }

  const historyText = buildCompactionHistoryText(
    interruptedBlocks
      .filter((block) => block.turnId === turnInterrupted || block.turnId === turnError)
      .flatMap((block) => block.messages),
    new Map(),
  );
  assert(historyText.includes("[status=interrupted]"), "summary text marks interrupted");
  assert(historyText.includes("[status=error]"), "summary text marks error");

  console.log("context-budget-compaction tests passed");
}

main();
