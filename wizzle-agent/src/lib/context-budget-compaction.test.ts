import type { Message } from "../types/workspace.ts";

// vite injects this at build time; node tests need a stub before env.ts loads.
(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {
  WIZZLE_FRONTEND_LOG_MODE: "off",
  WIZZLE_FRONTEND_LOG_RETENTION_DAYS: "7",
};

const {
  buildReplayBlocks,
  estimateConversationTokens,
  selectReplayHistoryWithinBudget,
} = await import("./context-budget.ts");
const {
  COMPACTION_SYSTEM_PROMPT,
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

  console.log("context-budget-compaction tests passed");
}

main();
