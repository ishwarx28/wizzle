import {
  buildChatMessages,
  collectDuplicateReadReplayMessageIds,
  type ChatRequestMessage,
  type OpenAIChatToolCall,
  type OpenAIContentPart,
  type ProxyToolDefinition,
} from "./chat-stream";
import {
  extractUserAndFinalMessages,
  MAX_REINFLATED_COMPACTED_TURNS,
} from "./agent/context-pressure";
import {
  resolveActiveTurnPressurePercent,
  resolveCompactedContextTokens,
  resolveCompactionTriggerPercent,
  resolveContextSafetyPercent,
  resolveOutputReservedPercent,
  resolvePostCompactionTargetPercent,
} from "./env";
import type {
  CompactedContextRecord,
  Message,
  ModelReasoningConfig,
  ModelCapability,
  PersistedTurnSummaryRecord,
  PreviewFile,
  ReplayCapabilityMode,
} from "../types/workspace";
import { reasoningReplayForModel, shouldReplayReasoning } from "./reasoning-config";

// Unknown catalog metadata must use a conservative budget instead of claiming 128k.
export const FALLBACK_CONTEXT_LIMIT = 128_000;
export const TOTAL_CONTEXT_LIMIT = FALLBACK_CONTEXT_LIMIT;
export const REPLAY_ESTIMATOR_VERSION = 5;

const MESSAGE_OVERHEAD_TOKENS = 6;
const CONTENT_PART_OVERHEAD_TOKENS = 4;
const TOOL_CALL_OVERHEAD_TOKENS = 24;
const TOOL_RESULT_OVERHEAD_TOKENS = 12;
const TOOL_DEFINITION_OVERHEAD_TOKENS = 32;
const IMAGE_PART_TOKEN_ESTIMATE = 1024;
const REQUEST_OVERHEAD_TOKENS = 24;

type ReplayBlockEstimate = {
  replayMessageCount: number;
  tokens: number;
};

export type ReplayBlock = {
  blockId: string;
  isActiveTurn: boolean;
  isCompleted: boolean;
  messages: Message[];
  turnId: string | null;
};

export type PromptTokenCacheKeyData = {
  selectedModelUuid: string;
  systemPromptHash: string;
  toolDefsHash: string;
};

export type ReplayBudget = {
  activeTurnPressure: number;
  compactedContextTokens: number;
  compactionTrigger: number;
  /** Compatibility alias for the post-compaction target. */
  healthyTarget: number;
  /** Maximum safe input after the response reserve and safety margin. */
  inputBudget: number;
  maxContext: number;
  postCompactionTarget: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
};

export type ContextBudgetSnapshot = {
  activeTurnId: string | null;
  budget: ReplayBudget;
  compactableTurnCount: number;
  compactionRequired: boolean;
  fixedTokens: number;
  optionalTokens: number;
  preCompactionTokens: number;
  requestTokens: number;
  selectedRequiredTokens: number;
  updatedAtMs: number;
};

export type ReplaySelectionResult = {
  budget: ReplayBudget;
  blocks: ReplayBlock[];
  compactedSummaryTokens: number;
  droppedTurnIds: string[];
  /** Required live usage only. Optional reinflated compacted turns are excluded. */
  estimatedTokens: number;
  messages: Message[];
  /** Actual request usage, including optional reinflated user+final pairs. */
  requestEstimatedTokens: number;
  /** Compacted turns reinflated as user+final only (newest-fit residual budget). */
  reinflatedTurnIds: string[];
  snapshot: ContextBudgetSnapshot;
};

export type TurnSummaryBuildResult = PersistedTurnSummaryRecord | null;

export type ReplayBudgetErrorCode =
  | "attachments_too_large"
  | "current_message_too_large"
  | "selected_model_context_too_small"
  | "system_tool_prompt_too_large";

export class ReplayBudgetError extends Error {
  code: ReplayBudgetErrorCode;

  constructor(code: ReplayBudgetErrorCode, message: string) {
    super(message);
    this.name = "ReplayBudgetError";
    this.code = code;
  }
}

export function isReplayBudgetError(error: unknown): error is ReplayBudgetError {
  return error instanceof ReplayBudgetError;
}

export function estimateTextTokens(text: string) {
  if (!text) {
    return 0;
  }

  return Math.ceil(Math.ceil(text.length / 3.5) * 1.15);
}

function stableHash(value: string) {
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

export function buildPromptTokenCacheKeyData(options: {
  selectedModelUuid: string;
  systemPrompt: string;
  tools?: ProxyToolDefinition[];
}): PromptTokenCacheKeyData {
  return {
    selectedModelUuid: options.selectedModelUuid,
    systemPromptHash: stableHash(options.systemPrompt),
    toolDefsHash: stableHash(JSON.stringify(options.tools ?? [])),
  };
}

function estimateToolCallTokens(toolCall: OpenAIChatToolCall) {
  return (
    TOOL_CALL_OVERHEAD_TOKENS +
    estimateTextTokens(toolCall.id) +
    estimateTextTokens(toolCall.function.name) +
    estimateTextTokens(toolCall.function.arguments)
  );
}

function estimateContentPartTokens(part: OpenAIContentPart) {
  if (part.type === "text") {
    return (
      CONTENT_PART_OVERHEAD_TOKENS +
      estimateTextTokens(part.text)
    );
  }

  return CONTENT_PART_OVERHEAD_TOKENS + IMAGE_PART_TOKEN_ESTIMATE;
}

export function estimateChatMessageTokens(
  message: ChatRequestMessage,
) {
  let tokens =
    MESSAGE_OVERHEAD_TOKENS +
    estimateTextTokens(message.role) +
    (message.tool_call_id
      ? estimateTextTokens(message.tool_call_id) +
        TOOL_RESULT_OVERHEAD_TOKENS
      : 0);

  if (typeof message.content === "string") {
    tokens += estimateTextTokens(message.content);
  } else if (Array.isArray(message.content)) {
    tokens += message.content.reduce(
      (total, part) =>
        total + estimateContentPartTokens(part),
      0,
    );
  }

  tokens += (message.tool_calls ?? []).reduce(
    (total, toolCall) =>
      total + estimateToolCallTokens(toolCall),
    0,
  );
  if (message.__wizzle_reasoning_replay?.length) {
    tokens += estimateTextTokens(JSON.stringify(message.__wizzle_reasoning_replay));
  }

  return tokens;
}

export function estimateToolDefinitionTokens(
  tools: ProxyToolDefinition[],
) {
  if (tools.length === 0) {
    return 0;
  }

  return tools.reduce(
    (total, tool) =>
      total +
      TOOL_DEFINITION_OVERHEAD_TOKENS +
      estimateTextTokens(JSON.stringify(tool)),
    0,
  );
}

export function estimateChatMessagesTokens(messages: ChatRequestMessage[]) {
  return messages.reduce(
    (total, message) =>
      total + estimateChatMessageTokens(message),
    0,
  );
}

export function estimateConversationTokens(options: {
  messages: ChatRequestMessage[];
  tools?: ProxyToolDefinition[];
}) {
  return (
    REQUEST_OVERHEAD_TOKENS +
    estimateToolDefinitionTokens(options.tools ?? []) +
    estimateChatMessagesTokens(options.messages)
  );
}

function resolveReplayCapabilityMode(modelCapabilities: ModelCapability[]): ReplayCapabilityMode {
  return modelCapabilities.includes("image") ? "imageCapable" : "textOnly";
}

function isMessageCompleted(message: Message) {
  return message.status !== "streaming";
}

/**
 * Historical turn eligible to leave live replay and enter the anchored summary.
 * Terminal turns only: done, error, interrupted (and legacy missing status).
 * Active / streaming turns must stay verbatim (#33 / #34).
 */
export function isCompactableReplayBlock(
  block: ReplayBlock,
  currentTurnId?: string,
  modelReasoning?: ModelReasoningConfig | null,
  modelId?: string,
) {
  if (!block.turnId || block.isActiveTurn || !block.isCompleted) {
    return false;
  }

  if (currentTurnId && block.turnId === currentTurnId) {
    return false;
  }

  if (
    modelReasoning?.replay?.preserveExactly &&
    block.messages.some(
      (message) => {
        const replay = reasoningReplayForModel({
          entries: message.reasoningReplay,
          modelId,
          reasoning: modelReasoning,
        });
        return (
          replay.length > 0 &&
          shouldReplayReasoning({
            currentTurnId,
            hasToolCalls:
              (message.toolCalls?.length ?? 0) > 0 ||
              (message.parts?.some((part) => part.type === "tool_call") ?? false),
            messageTurnId: message.turnId,
            reasoning: modelReasoning,
          })
        );
      },
    )
  ) {
    return false;
  }

  // Refuse mid-stream leftovers; allow done | error | interrupted | undefined.
  return block.messages.every((message) => message.status !== "streaming");
}

export function buildReplayBlocks(history: Message[], currentTurnId?: string) {
  const blocks: ReplayBlock[] = [];
  let legacyTurnId: string | null = null;

  for (const message of history) {
    if (message.turnId) {
      legacyTurnId = null;
    } else if (message.role === "user" || !legacyTurnId) {
      legacyTurnId = `legacy:${message.id}`;
    }
    const blockKey = message.turnId ?? legacyTurnId!;
    const previousBlock = blocks[blocks.length - 1];

    if (previousBlock?.blockId === blockKey) {
      previousBlock.messages.push(message);
      previousBlock.isCompleted = previousBlock.isCompleted && isMessageCompleted(message);
      previousBlock.isActiveTurn =
        previousBlock.isActiveTurn || (currentTurnId ? message.turnId === currentTurnId : false);
      continue;
    }

    blocks.push({
      blockId: blockKey,
      isActiveTurn: currentTurnId ? message.turnId === currentTurnId : false,
      isCompleted: isMessageCompleted(message),
      messages: [message],
      turnId: blockKey,
    });
  }

  return blocks;
}

function estimateReplayBlock(options: {
  block: ReplayBlock;
  cachedEstimateByBlockId?: Map<string, ReplayBlockEstimate>;
  duplicateReadMessageIds?: ReadonlySet<string>;
  modelCapabilities: ModelCapability[];
  modelId?: string;
  modelReasoning?: ModelReasoningConfig | null;
  previewFileMap: Map<string, PreviewFile>;
}) {
  const replayMessages = buildChatMessages(
    options.block.messages,
    options.previewFileMap,
    options.modelCapabilities,
    {
      duplicateReadMessageIds: options.duplicateReadMessageIds,
      currentTurnId: options.block.isActiveTurn ? options.block.turnId ?? undefined : undefined,
      modelId: options.modelId,
      reasoning: options.modelReasoning,
    },
  );
  const duplicateReadIdsInBlock = options.block.messages
    .filter((message) => options.duplicateReadMessageIds?.has(message.id))
    .map((message) => message.id)
    .join(",");
  const cacheKey = [
    options.block.blockId,
    resolveReplayCapabilityMode(options.modelCapabilities),
    stableHash(JSON.stringify(replayMessages)),
    duplicateReadIdsInBlock,
  ].join(":");
  const cachedEstimate = options.cachedEstimateByBlockId?.get(cacheKey);

  if (cachedEstimate) {
    return cachedEstimate;
  }

  const estimate = {
    replayMessageCount: replayMessages.length,
    tokens: estimateChatMessagesTokens(replayMessages),
  };

  options.cachedEstimateByBlockId?.set(cacheKey, estimate);
  return estimate;
}

function normalizeContextLimit(maxContextTokens?: number | null) {
  if (!Number.isFinite(maxContextTokens) || !maxContextTokens || maxContextTokens < 1) {
    return FALLBACK_CONTEXT_LIMIT;
  }

  return Math.floor(maxContextTokens);
}

export function resolveReservedOutputTokens(
  maxContextTokens = FALLBACK_CONTEXT_LIMIT,
  maxOutputTokens?: number | null,
) {
  const maxContext = normalizeContextLimit(maxContextTokens);
  const reservedPercent = resolveOutputReservedPercent();
  const reservedByPercent = Math.ceil(maxContext * (reservedPercent / 100));
  const reservedTokens =
    typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
      ? Math.min(Math.floor(maxOutputTokens), reservedByPercent)
      : reservedByPercent;

  return Math.min(maxContext - 1, Math.max(1, reservedTokens));
}

export function resolveMaxReplayInput(
  maxContextTokens = FALLBACK_CONTEXT_LIMIT,
  maxOutputTokens?: number | null,
) {
  const maxContext = normalizeContextLimit(maxContextTokens);
  const reservedOutputTokens = resolveReservedOutputTokens(maxContext, maxOutputTokens);
  const safetyMarginTokens = Math.ceil(maxContext * (resolveContextSafetyPercent() / 100));

  return Math.max(0, maxContext - reservedOutputTokens - safetyMarginTokens);
}

function resolveReplayBudget(options: {
  maxContext?: number | null;
  maxContextTokens?: number | null;
  maxOutputTokens?: number | null;
}) {
  const maxContext = normalizeContextLimit(options.maxContextTokens ?? options.maxContext);
  const reservedOutputTokens = resolveReservedOutputTokens(maxContext, options.maxOutputTokens);
  const safetyMarginTokens = Math.ceil(maxContext * (resolveContextSafetyPercent() / 100));
  const inputBudget = resolveMaxReplayInput(maxContext, options.maxOutputTokens);
  const configuredTarget = Math.floor(
    inputBudget * (resolvePostCompactionTargetPercent() / 100),
  );
  const configuredTrigger = Math.floor(
    inputBudget * (resolveCompactionTriggerPercent() / 100),
  );
  const postCompactionTarget = Math.max(
    0,
    Math.min(Math.max(0, inputBudget - 1), configuredTarget),
  );
  const compactionTrigger = Math.min(
    inputBudget,
    Math.max(postCompactionTarget + 1, configuredTrigger),
  );

  return {
    activeTurnPressure: Math.min(
      inputBudget,
      Math.max(
        compactionTrigger,
        Math.floor(inputBudget * (resolveActiveTurnPressurePercent() / 100)),
      ),
    ),
    compactedContextTokens: resolveCompactedContextTokens(),
    compactionTrigger,
    healthyTarget: postCompactionTarget,
    inputBudget,
    maxContext,
    postCompactionTarget,
    reservedOutputTokens,
    safetyMarginTokens,
  } satisfies ReplayBudget;
}

function hasReplayAttachments(block: ReplayBlock) {
  return block.messages.some((message) => (message.linkedFileIds?.length ?? 0) > 0);
}

function buildActiveBlockBudgetError(block: ReplayBlock) {
  if (hasReplayAttachments(block)) {
    return new ReplayBudgetError(
      "attachments_too_large",
      "The current message attachments are too large for the selected model context. Remove some attachments or choose a model with a larger context window.",
    );
  }

  return new ReplayBudgetError(
    "current_message_too_large",
    "The current message is too large for the selected model context. Shorten it or choose a model with a larger context window.",
  );
}

function estimateCompactedSummaryTokens(compactedContext?: CompactedContextRecord | null) {
  if (!compactedContext?.summary.trim()) {
    return 0;
  }

  return estimateChatMessageTokens(buildCompactedContextMessage(compactedContext.summary));
}

export function buildCompactedContextMessage(summary: string): ChatRequestMessage {
  return {
    content: ["Compacted context from earlier completed turns.", "", summary].join("\n"),
    role: "system",
  };
}

export const MAX_REPLAY_INPUT = resolveMaxReplayInput(FALLBACK_CONTEXT_LIMIT);

/** Select the exact next request shape and the compaction work needed to build it. */
export function selectReplayHistoryWithinBudget(options: {
  additionalMessages?: ChatRequestMessage[];
  cachedEstimateByBlockId?: Map<string, ReplayBlockEstimate>;
  cacheKeyData?: PromptTokenCacheKeyData;
  compactedContext?: CompactedContextRecord | null;
  currentTurnId?: string;
  /** Exceptional continuation compacts completed turns before contacting the provider. */
  forceCompaction?: boolean;
  history: Message[];
  maxContext?: number | null;
  maxContextTokens?: number;
  maxOutputTokens?: number | null;
  modelCapabilities: ModelCapability[];
  modelReasoning?: ModelReasoningConfig | null;
  previewFileMap: Map<string, PreviewFile>;
  selectedModelUuid?: string;
  systemPrompt: string;
  /** Exact cached count for the complete system chat message. */
  systemPromptTokens?: number;
  /** Exact cached count for all request tool definitions. */
  toolDefinitionTokens?: number;
  tools?: ProxyToolDefinition[];
  /** Retained for persisted-session compatibility; live content is always recounted. */
  turnSummaries?: PersistedTurnSummaryRecord[];
}) {
  const blocks = buildReplayBlocks(options.history, options.currentTurnId);
  const duplicateReadMessageIds = collectDuplicateReadReplayMessageIds(options.history);
  const compactedTurnIds = new Set(options.compactedContext?.compactedTurnIds ?? []);
  const budget = resolveReplayBudget({
    maxContext: options.maxContext,
    maxContextTokens: options.maxContextTokens,
    maxOutputTokens: options.maxOutputTokens,
  });
  const compactedSummaryTokens = estimateCompactedSummaryTokens(options.compactedContext);
  const systemPromptTokens =
    options.systemPromptTokens ??
    estimateChatMessageTokens({ content: options.systemPrompt, role: "system" });
  const toolDefinitionTokens =
    options.toolDefinitionTokens ??
    estimateToolDefinitionTokens(options.tools ?? []);
  const additionalMessageTokens = estimateChatMessagesTokens(options.additionalMessages ?? []);
  const fixedLiveTokens =
    REQUEST_OVERHEAD_TOKENS +
    systemPromptTokens +
    toolDefinitionTokens +
    compactedSummaryTokens +
    additionalMessageTokens;

  if (budget.maxContext < 1_024 || budget.inputBudget <= 0) {
    throw new ReplayBudgetError(
      "selected_model_context_too_small",
      "The selected model context window is too small for a coding session. Choose a model with a larger context window.",
    );
  }

  if (fixedLiveTokens >= budget.inputBudget) {
    throw new ReplayBudgetError(
      "system_tool_prompt_too_large",
      "The system prompt and tool definitions are too large for the selected model context. Choose a larger-context model.",
    );
  }

  const estimateBlock = (block: ReplayBlock) =>
    estimateReplayBlock({
      block,
      cachedEstimateByBlockId: options.cachedEstimateByBlockId,
      duplicateReadMessageIds,
      modelCapabilities: options.modelCapabilities,
      modelId: options.selectedModelUuid,
      modelReasoning: options.modelReasoning,
      previewFileMap: options.previewFileMap,
    });

  // Chronological candidates that can still appear verbatim in the live turn.
  type Candidate = { block: ReplayBlock; tokens: number };
  const requiredCandidates: Candidate[] = [];
  const compactableCandidates: Candidate[] = [];

  for (const block of blocks) {
    if (block.turnId && compactedTurnIds.has(block.turnId)) {
      continue;
    }

    const tokens = estimateBlock(block).tokens;

    if (
      isCompactableReplayBlock(
        block,
        options.currentTurnId,
        options.modelReasoning,
        options.selectedModelUuid,
      )
    ) {
      compactableCandidates.push({ block, tokens });
    } else {
      requiredCandidates.push({ block, tokens });
    }
  }

  const requiredTokens = requiredCandidates.reduce((total, entry) => total + entry.tokens, 0);
  if (fixedLiveTokens + requiredTokens > budget.inputBudget) {
    const activeBlock =
      requiredCandidates.find((entry) => entry.block.isActiveTurn)?.block ??
      requiredCandidates[requiredCandidates.length - 1]?.block ??
      blocks[blocks.length - 1];
    throw buildActiveBlockBudgetError(activeBlock ?? {
      blockId: "active",
      isActiveTurn: true,
      isCompleted: false,
      messages: [],
      turnId: options.currentTurnId ?? null,
    });
  }

  const compactableTokens = compactableCandidates.reduce(
    (total, entry) => total + entry.tokens,
    0,
  );
  const preCompactionTokens = fixedLiveTokens + requiredTokens + compactableTokens;
  const shouldCompact =
    compactableCandidates.length > 0 &&
    (options.forceCompaction === true || preCompactionTokens > budget.compactionTrigger);
  const droppedTurnIds = shouldCompact
    ? compactableCandidates.map((entry) => entry.block.turnId!)
    : [];

  if (
    compactableCandidates.length === 0 &&
    fixedLiveTokens + requiredTokens > budget.activeTurnPressure
  ) {
    const activeBlock =
      requiredCandidates.find((entry) => entry.block.isActiveTurn)?.block ??
      requiredCandidates[requiredCandidates.length - 1]?.block ??
      blocks[blocks.length - 1];
    throw buildActiveBlockBudgetError(
      activeBlock ?? {
        blockId: "active",
        isActiveTurn: true,
        isCompleted: false,
        messages: [],
        turnId: options.currentTurnId ?? null,
      },
    );
  }

  const droppedTurnIdSet = new Set(droppedTurnIds);
  const includedBlocks = blocks.filter((block) => {
    if (block.turnId && compactedTurnIds.has(block.turnId)) {
      return false;
    }
    if (block.turnId && droppedTurnIdSet.has(block.turnId)) {
      return false;
    }
    return true;
  });

  const estimatedTokens =
    fixedLiveTokens +
    includedBlocks.reduce((total, block) => total + estimateBlock(block).tokens, 0);

  // Never let optional overlap trigger compaction. It is added only after the
  // required request is below the low-water target and is removed first.
  const reinflate = shouldCompact
    ? { messages: [], tokens: 0, turnIds: [] }
    : selectReinflatedCompactedTurns({
        blocks,
        compactedTurnIds,
        estimateMessages: (messages) =>
          estimateChatMessagesTokens(
            buildChatMessages(messages, options.previewFileMap, options.modelCapabilities, {
              duplicateReadMessageIds,
            }),
          ),
        residualTokens: budget.postCompactionTarget - estimatedTokens,
      });

  const requestEstimatedTokens = estimatedTokens + reinflate.tokens;
  const snapshot: ContextBudgetSnapshot = {
    activeTurnId: options.currentTurnId ?? null,
    budget,
    compactableTurnCount: compactableCandidates.length,
    compactionRequired: shouldCompact,
    fixedTokens: fixedLiveTokens,
    optionalTokens: reinflate.tokens,
    preCompactionTokens,
    requestTokens: requestEstimatedTokens,
    selectedRequiredTokens: estimatedTokens,
    updatedAtMs: Date.now(),
  };

  return {
    blocks,
    budget,
    compactedSummaryTokens,
    droppedTurnIds,
    estimatedTokens,
    messages: [...reinflate.messages, ...includedBlocks.flatMap((block) => block.messages)],
    requestEstimatedTokens,
    reinflatedTurnIds: reinflate.turnIds,
    snapshot,
  } satisfies ReplaySelectionResult;
}

/**
 * Newest compacted turns first for fitting; emit chronological user+final pairs.
 * Skip turns without a usable final or whose pair does not fit.
 */
export function selectReinflatedCompactedTurns(options: {
  blocks: ReplayBlock[];
  compactedTurnIds: ReadonlySet<string>;
  estimateMessages: (messages: Message[]) => number;
  maxTurns?: number;
  residualTokens: number;
}): { messages: Message[]; tokens: number; turnIds: string[] } {
  const maxTurns = options.maxTurns ?? MAX_REINFLATED_COMPACTED_TURNS;
  if (options.residualTokens <= 0 || maxTurns < 1 || options.compactedTurnIds.size === 0) {
    return { messages: [], tokens: 0, turnIds: [] };
  }

  const compactedBlocks = options.blocks.filter(
    (block) => block.turnId && options.compactedTurnIds.has(block.turnId),
  );
  // Newest first among last maxTurns candidates in history order.
  const newestFirst = compactedBlocks.slice(-maxTurns).reverse();

  const selectedPairs: Message[][] = [];
  const selectedTurnIds: string[] = [];
  let remaining = options.residualTokens;
  let usedTokens = 0;

  for (const block of newestFirst) {
    const pair = extractUserAndFinalMessages(block.messages);
    if (pair.length === 0) {
      continue;
    }

    const tokens = options.estimateMessages(pair);
    if (tokens > remaining) {
      continue;
    }

    selectedPairs.push(pair);
    selectedTurnIds.push(block.turnId!);
    remaining -= tokens;
    usedTokens += tokens;
  }

  // Restore chronological order (oldest reinflated first).
  selectedPairs.reverse();
  selectedTurnIds.reverse();

  return {
    messages: selectedPairs.flat(),
    tokens: usedTokens,
    turnIds: selectedTurnIds,
  };
}

function buildTurnSummaryEstimate(
  messages: Message[],
  previewFileMap: Map<string, PreviewFile>,
  modelCapabilities: ModelCapability[],
) {
  const replayMessages = buildChatMessages(messages, previewFileMap, modelCapabilities);

  return {
    replayMessageCount: replayMessages.length,
    tokens: estimateChatMessagesTokens(replayMessages),
  };
}

export function buildTurnReplaySummary(options: {
  messages: Message[];
  previewFileMap: Map<string, PreviewFile>;
  turnId: string;
}): TurnSummaryBuildResult {
  if (options.messages.length === 0) {
    return null;
  }

  const textOnlyEstimate = buildTurnSummaryEstimate(
    options.messages,
    options.previewFileMap,
    ["text"],
  );
  const imageCapableEstimate = buildTurnSummaryEstimate(
    options.messages,
    options.previewFileMap,
    ["text", "image"],
  );
  const completedAtMs = options.messages.reduce(
    (latest, message) => Math.max(latest, message.completedAtMs ?? message.createdAtMs ?? 0),
    0,
  );

  return {
    completedAtMs,
    estimatedTokensImageCapable: imageCapableEstimate.tokens,
    estimatedTokensTextOnly: textOnlyEstimate.tokens,
    estimatorVersion: REPLAY_ESTIMATOR_VERSION,
    messageIds: options.messages.map((message) => message.id),
    replayMessageCountImageCapable: imageCapableEstimate.replayMessageCount,
    replayMessageCountTextOnly: textOnlyEstimate.replayMessageCount,
    turnId: options.turnId,
  };
}
