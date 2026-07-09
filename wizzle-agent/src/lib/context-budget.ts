import {
  buildChatMessages,
  collectDuplicateReadReplayMessageIds,
  type ChatRequestMessage,
  type OpenAIChatToolCall,
  type OpenAIContentPart,
  type ProxyToolDefinition,
} from "./chat-stream";
import {
  resolveCompactedContextTokens,
  resolveHealthyContextPercent,
  resolveOutputReservedPercent,
} from "./env";
import type {
  CompactedContextRecord,
  Message,
  ModelCapability,
  PersistedTurnSummaryRecord,
  PreviewFile,
  ReplayCapabilityMode,
} from "../types/workspace";

export const FALLBACK_CONTEXT_LIMIT = 128_000;
export const TOTAL_CONTEXT_LIMIT = FALLBACK_CONTEXT_LIMIT;
export const REPLAY_ESTIMATOR_VERSION = 4;

const UNKNOWN_TOKENIZER_MULTIPLIER = 1.15;
const MESSAGE_OVERHEAD_TOKENS = 6;
const CONTENT_PART_OVERHEAD_TOKENS = 4;
const TOOL_CALL_OVERHEAD_TOKENS = 24;
const TOOL_RESULT_OVERHEAD_TOKENS = 12;
const TOOL_DEFINITION_OVERHEAD_TOKENS = 32;
const SYSTEM_MESSAGE_OVERHEAD_TOKENS = 8;
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
  tokenizerKind: string;
  toolDefsHash: string;
};

export type ReplaySelectionResult = {
  budget: {
    compactedContextTokens: number;
    healthyTarget: number;
    inputBudget: number;
    maxContext: number;
  };
  blocks: ReplayBlock[];
  compactedSummaryTokens: number;
  droppedTurnIds: string[];
  estimatedTokens: number;
  messages: Message[];
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

export function estimateTextTokens(
  text: string,
  options: {
    tokenizerKind?: string | null;
  } = {},
) {
  if (!text) {
    return 0;
  }

  const baseTokens = Math.ceil(text.length / 3.5);

  return options.tokenizerKind?.trim()
    ? baseTokens
    : Math.ceil(baseTokens * UNKNOWN_TOKENIZER_MULTIPLIER);
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
  tokenizerKind?: string | null;
  tools?: ProxyToolDefinition[];
}): PromptTokenCacheKeyData {
  return {
    selectedModelUuid: options.selectedModelUuid,
    systemPromptHash: stableHash(options.systemPrompt),
    tokenizerKind: options.tokenizerKind?.trim() || "heuristic",
    toolDefsHash: stableHash(JSON.stringify(options.tools ?? [])),
  };
}

function estimateToolCallTokens(
  toolCall: OpenAIChatToolCall,
  tokenizerKind?: string | null,
) {
  return (
    TOOL_CALL_OVERHEAD_TOKENS +
    estimateTextTokens(toolCall.id, { tokenizerKind }) +
    estimateTextTokens(toolCall.function.name, { tokenizerKind }) +
    estimateTextTokens(toolCall.function.arguments, { tokenizerKind })
  );
}

function estimateContentPartTokens(
  part: OpenAIContentPart,
  tokenizerKind?: string | null,
) {
  if (part.type === "text") {
    return CONTENT_PART_OVERHEAD_TOKENS + estimateTextTokens(part.text, { tokenizerKind });
  }

  return CONTENT_PART_OVERHEAD_TOKENS + IMAGE_PART_TOKEN_ESTIMATE;
}

export function estimateChatMessageTokens(
  message: ChatRequestMessage,
  tokenizerKind?: string | null,
) {
  let tokens =
    MESSAGE_OVERHEAD_TOKENS +
    estimateTextTokens(message.role, { tokenizerKind }) +
    (message.tool_call_id
      ? estimateTextTokens(message.tool_call_id, { tokenizerKind }) + TOOL_RESULT_OVERHEAD_TOKENS
      : 0);

  if (typeof message.content === "string") {
    tokens += estimateTextTokens(message.content, { tokenizerKind });
  } else if (Array.isArray(message.content)) {
    tokens += message.content.reduce(
      (total, part) => total + estimateContentPartTokens(part, tokenizerKind),
      0,
    );
  }

  tokens += (message.tool_calls ?? []).reduce(
    (total, toolCall) => total + estimateToolCallTokens(toolCall, tokenizerKind),
    0,
  );

  return tokens;
}

function estimateToolDefinitionTokens(
  tools: ProxyToolDefinition[],
  tokenizerKind?: string | null,
) {
  if (tools.length === 0) {
    return 0;
  }

  return tools.reduce(
    (total, tool) =>
      total +
      TOOL_DEFINITION_OVERHEAD_TOKENS +
      estimateTextTokens(JSON.stringify(tool), { tokenizerKind }),
    0,
  );
}

export function estimateChatMessagesTokens(
  messages: ChatRequestMessage[],
  tokenizerKind?: string | null,
) {
  return messages.reduce(
    (total, message) => total + estimateChatMessageTokens(message, tokenizerKind),
    0,
  );
}

export function estimateConversationTokens(options: {
  messages: ChatRequestMessage[];
  tokenizerKind?: string | null;
  tools?: ProxyToolDefinition[];
}) {
  return (
    REQUEST_OVERHEAD_TOKENS +
    estimateToolDefinitionTokens(options.tools ?? [], options.tokenizerKind) +
    estimateChatMessagesTokens(options.messages, options.tokenizerKind)
  );
}

function resolveReplayCapabilityMode(modelCapabilities: ModelCapability[]): ReplayCapabilityMode {
  return modelCapabilities.includes("image") ? "imageCapable" : "textOnly";
}

function isMessageCompleted(message: Message) {
  return message.status !== "streaming";
}

function canReuseTurnSummary(block: ReplayBlock, summary: PersistedTurnSummaryRecord | null) {
  if (!summary || !block.turnId) {
    return false;
  }

  if (summary.estimatorVersion !== REPLAY_ESTIMATOR_VERSION) {
    return false;
  }

  if (summary.turnId !== block.turnId) {
    return false;
  }

  if (summary.messageIds.length !== block.messages.length) {
    return false;
  }

  return summary.messageIds.every((messageId, index) => block.messages[index]?.id === messageId);
}

export function buildReplayBlocks(history: Message[], currentTurnId?: string) {
  const blocks: ReplayBlock[] = [];

  for (const message of history) {
    const blockKey = message.turnId ?? message.id;
    const previousBlock = blocks[blocks.length - 1];

    if ((previousBlock?.turnId ?? previousBlock?.blockId) === blockKey) {
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
      turnId: message.turnId ?? null,
    });
  }

  return blocks;
}

function estimateReplayBlock(options: {
  block: ReplayBlock;
  cachedEstimateByBlockId?: Map<string, ReplayBlockEstimate>;
  duplicateReadMessageIds?: ReadonlySet<string>;
  modelCapabilities: ModelCapability[];
  previewFileMap: Map<string, PreviewFile>;
  tokenizerKind?: string | null;
}) {
  const duplicateReadIdsInBlock = options.block.messages
    .filter((message) => options.duplicateReadMessageIds?.has(message.id))
    .map((message) => message.id)
    .join(",");
  const cacheKey = [
    options.block.blockId,
    resolveReplayCapabilityMode(options.modelCapabilities),
    options.tokenizerKind ?? "heuristic",
    options.block.messages.map((message) => message.id).join(","),
    duplicateReadIdsInBlock,
  ].join(":");
  const cachedEstimate = options.cachedEstimateByBlockId?.get(cacheKey);

  if (cachedEstimate) {
    return cachedEstimate;
  }

  const replayMessages = buildChatMessages(
    options.block.messages,
    options.previewFileMap,
    options.modelCapabilities,
    {
      duplicateReadMessageIds: options.duplicateReadMessageIds,
    },
  );
  const estimate = {
    replayMessageCount: replayMessages.length,
    tokens: estimateChatMessagesTokens(replayMessages, options.tokenizerKind),
  };

  options.cachedEstimateByBlockId?.set(cacheKey, estimate);
  return estimate;
}

function getCachedTurnSummaryEstimate(options: {
  block: ReplayBlock;
  duplicateReadMessageIds?: ReadonlySet<string>;
  modelCapabilities: ModelCapability[];
  turnSummaryByTurnId: Map<string, PersistedTurnSummaryRecord>;
}) {
  const turnId = options.block.turnId;

  if (!turnId) {
    return null;
  }

  const summary = options.turnSummaryByTurnId.get(turnId) ?? null;

  if (
    options.block.messages.some((message) => options.duplicateReadMessageIds?.has(message.id)) ||
    !summary ||
    !canReuseTurnSummary(options.block, summary)
  ) {
    return null;
  }

  return resolveReplayCapabilityMode(options.modelCapabilities) === "imageCapable"
    ? {
        replayMessageCount: summary.replayMessageCountImageCapable,
        tokens: summary.estimatedTokensImageCapable,
      }
    : {
        replayMessageCount: summary.replayMessageCountTextOnly,
        tokens: summary.estimatedTokensTextOnly,
      };
}

function normalizeContextLimit(maxContextTokens?: number | null) {
  if (!Number.isFinite(maxContextTokens) || !maxContextTokens || maxContextTokens < 1) {
    return FALLBACK_CONTEXT_LIMIT;
  }

  return Math.floor(maxContextTokens);
}

export function resolveMaxReplayInput(maxContextTokens = FALLBACK_CONTEXT_LIMIT, maxOutputTokens?: number | null) {
  const maxContext = normalizeContextLimit(maxContextTokens);
  const reservedPercent = resolveOutputReservedPercent();
  const reservedByPercent = Math.ceil(maxContext * (reservedPercent / 100));
  const reservedTokens =
    typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
      ? Math.min(Math.floor(maxOutputTokens), reservedByPercent)
      : reservedByPercent;

  return Math.max(0, maxContext - reservedTokens);
}

function resolveReplayBudget(options: {
  maxContext?: number | null;
  maxContextTokens?: number | null;
  maxOutputTokens?: number | null;
}) {
  const maxContext = normalizeContextLimit(options.maxContextTokens ?? options.maxContext);
  const inputBudget = resolveMaxReplayInput(maxContext, options.maxOutputTokens);

  return {
    compactedContextTokens: resolveCompactedContextTokens(),
    healthyTarget: Math.ceil(maxContext * (resolveHealthyContextPercent() / 100)),
    inputBudget,
    maxContext,
  };
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

function estimateCompactedSummaryTokens(
  compactedContext?: CompactedContextRecord | null,
  tokenizerKind?: string | null,
) {
  if (!compactedContext?.summary.trim()) {
    return 0;
  }

  return Math.max(
    compactedContext.tokens,
    SYSTEM_MESSAGE_OVERHEAD_TOKENS +
      estimateTextTokens(compactedContext.summary, { tokenizerKind }),
  );
}

export const MAX_REPLAY_INPUT = resolveMaxReplayInput(FALLBACK_CONTEXT_LIMIT);

/**
 * Live agent-turn budget only. Counts agent system prompt + tools + summary +
 * history. Compaction request sizing lives separately (no agent system/tools).
 *
 * When over budget, frees space by dropping the oldest completed non-compacted
 * turns first (oldest → newer). Newer completed turns and the active turn are
 * preferred for verbatim keep. Callers must compact `droppedTurnIds` (possibly
 * in multiple batches under the compaction input budget) before sending.
 */
export function selectReplayHistoryWithinBudget(options: {
  cachedEstimateByBlockId?: Map<string, ReplayBlockEstimate>;
  cacheKeyData?: PromptTokenCacheKeyData;
  compactedContext?: CompactedContextRecord | null;
  currentTurnId?: string;
  history: Message[];
  maxContext?: number | null;
  maxContextTokens?: number;
  maxOutputTokens?: number | null;
  modelCapabilities: ModelCapability[];
  previewFileMap: Map<string, PreviewFile>;
  selectedModelUuid?: string;
  systemPrompt: string;
  tokenizerKind?: string | null;
  tools?: ProxyToolDefinition[];
  turnSummaries?: PersistedTurnSummaryRecord[];
}) {
  const tokenizerKind = options.cacheKeyData?.tokenizerKind ?? options.tokenizerKind;
  const turnSummaryByTurnId = new Map(
    (options.turnSummaries ?? []).map((summary) => [summary.turnId, summary] as const),
  );
  const blocks = buildReplayBlocks(options.history, options.currentTurnId);
  const duplicateReadMessageIds = collectDuplicateReadReplayMessageIds(options.history);
  const compactedTurnIds = new Set(options.compactedContext?.compactedTurnIds ?? []);
  const budget = resolveReplayBudget({
    maxContext: options.maxContext,
    maxContextTokens: options.maxContextTokens,
    maxOutputTokens: options.maxOutputTokens,
  });
  const compactedSummaryTokens = estimateCompactedSummaryTokens(options.compactedContext, tokenizerKind);
  const fixedLiveTokens =
    REQUEST_OVERHEAD_TOKENS +
    SYSTEM_MESSAGE_OVERHEAD_TOKENS +
    estimateTextTokens(options.systemPrompt, { tokenizerKind }) +
    estimateToolDefinitionTokens(options.tools ?? [], tokenizerKind) +
    compactedSummaryTokens;

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
    (!block.isActiveTurn && block.isCompleted
      ? getCachedTurnSummaryEstimate({
          block,
          duplicateReadMessageIds,
          modelCapabilities: options.modelCapabilities,
          turnSummaryByTurnId,
        })
      : null) ??
    estimateReplayBlock({
      block,
      cachedEstimateByBlockId: options.cachedEstimateByBlockId,
      duplicateReadMessageIds,
      modelCapabilities: options.modelCapabilities,
      previewFileMap: options.previewFileMap,
      tokenizerKind,
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
    const isCompactable =
      Boolean(block.turnId) && block.isCompleted && !block.isActiveTurn;

    if (isCompactable) {
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

  // Prefer keeping newer completed turns. Drop oldest compactable first until live fits.
  let compactableTokens = compactableCandidates.reduce((total, entry) => total + entry.tokens, 0);
  const droppedTurnIds: string[] = [];
  let dropCount = 0;

  while (
    fixedLiveTokens + requiredTokens + compactableTokens > budget.inputBudget &&
    dropCount < compactableCandidates.length
  ) {
    const oldest = compactableCandidates[dropCount]!;
    droppedTurnIds.push(oldest.block.turnId!);
    compactableTokens -= oldest.tokens;
    dropCount += 1;
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

  return {
    blocks,
    budget,
    compactedSummaryTokens,
    droppedTurnIds,
    estimatedTokens,
    messages: includedBlocks.flatMap((block) => block.messages),
  } satisfies ReplaySelectionResult;
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
