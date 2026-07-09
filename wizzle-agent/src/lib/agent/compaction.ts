import { invoke } from "@tauri-apps/api/core";

import {
  extractMessageText,
  sanitizeToolResultContentForReplay,
  type ChatRequestMessage,
} from "../chat-stream";
import {
  estimateConversationTokens,
  estimateTextTokens,
  resolveMaxReplayInput,
  type ReplayBlock,
} from "../context-budget";
import { getAssistantConversationContent, getMessageParts } from "../message-parts";
import type {
  CompactedContextRecord,
  Message,
  ModelId,
  PreviewFile,
  ProviderModelInfo,
} from "../../types/workspace";

export const COMPACTION_SYSTEM_PROMPT = `You are an anchored context summarization assistant for coding sessions.

Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.`;

const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

const REQUIRED_SUMMARY_HEADINGS = [
  "## Goal",
  "## Constraints & Preferences",
  "## Progress",
  "### Done",
  "### In Progress",
  "### Blocked",
  "## Key Decisions",
  "## Next Steps",
  "## Critical Context",
  "## Relevant Files",
];
const MAX_COMPACTION_TOOL_OUTPUT_CHARS = 2_000;

type ChatCompletionJson = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

function truncateMiddle(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return text;
  }

  const marker = `\n[Tool output truncated: omitted ${text.length - maxChars} chars]\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.65);
  const tail = Math.max(0, available - head);

  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

function serializeAttachmentReferences(message: Message, previewFileMap: Map<string, PreviewFile>) {
  return (message.linkedFileIds ?? [])
    .map((fileId) => previewFileMap.get(fileId))
    .filter((file): file is PreviewFile => Boolean(file))
    .map((file) => `[Attached ${file.kind}: ${file.name}]`);
}

function serializeMessageForCompaction(message: Message, previewFileMap: Map<string, PreviewFile>) {
  if (message.role === "user") {
    const attachments = serializeAttachmentReferences(message, previewFileMap);
    return [
      "USER:",
      message.content.trim(),
      ...attachments,
    ].filter(Boolean).join("\n");
  }

  if (message.role === "assistant") {
    const parts = getMessageParts(message).filter((part) => part.type !== "reasoning");
    const toolCalls = parts
      .filter((part) => part.type === "tool_call")
      .map((part) => {
        const input = part.input?.trim() || "{}";
        return `Tool call ${part.name ?? "unknown"} (${part.toolCallId ?? part.id}): ${input}`;
      });
    const content = getAssistantConversationContent(message).trim();

    return [
      "ASSISTANT:",
      content,
      ...toolCalls,
    ].filter(Boolean).join("\n");
  }

  const replayContent = sanitizeToolResultContentForReplay(message.content, {
    toolName: message.toolName,
  });

  return [
    `TOOL ${message.toolName ?? "unknown"} (${message.toolCallId ?? message.id}):`,
    truncateMiddle(replayContent, MAX_COMPACTION_TOOL_OUTPUT_CHARS),
  ].join("\n");
}

export function buildCompactionHistoryText(
  messages: Message[],
  previewFileMap: Map<string, PreviewFile>,
) {
  return messages
    .map((message) => serializeMessageForCompaction(message, previewFileMap).trim())
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function buildCompactionUserPrompt(options: {
  historyText: string;
  previousSummary?: string | null;
  stricter?: boolean;
}) {
  const anchorInstruction = options.previousSummary?.trim()
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        options.previousSummary.trim(),
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above.";
  const stricterInstruction = options.stricter
    ? "\n\nAdditional limit: make the bullets shorter while preserving every required heading."
    : "";

  return [
    "Conversation history:",
    "<conversation>",
    options.historyText.trim() || "(none)",
    "</conversation>",
    "",
    anchorInstruction,
    "",
    SUMMARY_TEMPLATE,
    stricterInstruction,
  ].join("\n");
}

export function hasRequiredSummaryHeadings(summary: string) {
  let lastIndex = -1;

  for (const heading of REQUIRED_SUMMARY_HEADINGS) {
    const index = summary.indexOf(heading);

    if (index <= lastIndex) {
      return false;
    }

    lastIndex = index;
  }

  return true;
}

function normalizeSummaryStructure(summary: string) {
  if (hasRequiredSummaryHeadings(summary)) {
    return summary.trim();
  }

  const sanitizedSummary = summary.trim() || "- (none)";

  return [
    "## Goal",
    "- Continue the coding session using the preserved context.",
    "",
    "## Constraints & Preferences",
    "- (none)",
    "",
    "## Progress",
    "### Done",
    sanitizedSummary,
    "",
    "### In Progress",
    "- (none)",
    "",
    "### Blocked",
    "- (none)",
    "",
    "## Key Decisions",
    "- (none)",
    "",
    "## Next Steps",
    "- (none)",
    "",
    "## Critical Context",
    "- (none)",
    "",
    "## Relevant Files",
    "- (none)",
  ].join("\n");
}

function truncateBullet(line: string, maxChars: number) {
  if (line.length <= maxChars || !line.trim().startsWith("-")) {
    return line;
  }

  return `${line.slice(0, Math.max(8, maxChars - 1)).trimEnd()}.`;
}

export function compressSummaryPreservingSections(summary: string, tokenLimit: number) {
  const normalized = normalizeSummaryStructure(summary);
  const maxChars = Math.max(1_000, Math.floor((tokenLimit * 3.5) / 1.15));

  if (normalized.length <= maxChars) {
    return normalized;
  }

  const headingSet = new Set(REQUIRED_SUMMARY_HEADINGS);
  const lines = normalized.split("\n");
  const headingLines = lines.filter((line) => headingSet.has(line.trim()));
  const contentLineCount = Math.max(1, lines.length - headingLines.length);
  const headingChars = headingLines.reduce((total, line) => total + line.length + 1, 0);
  const perContentLine = Math.max(
    24,
    Math.floor(Math.max(200, maxChars - headingChars) / contentLineCount),
  );
  const compressed = lines
    .map((line) => (headingSet.has(line.trim()) ? line : truncateBullet(line, perContentLine)))
    .join("\n")
    .trim();

  if (hasRequiredSummaryHeadings(compressed)) {
    return compressed;
  }

  return normalizeSummaryStructure(compressed);
}

function parseCompletionText(response: string) {
  try {
    return extractMessageText(JSON.parse(response) as ChatCompletionJson).trim();
  } catch {
    return response.trim();
  }
}

function resolveCompactionReasoningLevel(model: ProviderModelInfo) {
  if (model.reasoningLevels.includes("balanced")) {
    return "balanced";
  }

  return model.reasoningLevels[0] ?? "fast";
}

async function requestSummary(options: {
  chatId: string;
  maxTokens: number;
  model: ProviderModelInfo;
  projectId: string;
  userPrompt: string;
}) {
  const response = await invoke<string>("complete_provider_chat", {
    input: {
      modelUuid: options.model.id,
      projectId: options.projectId,
      chatId: options.chatId,
      reasoningLevel: resolveCompactionReasoningLevel(options.model),
      body: {
        model: options.model.id,
        stream: false,
        max_tokens: options.maxTokens,
        messages: [
          {
            role: "system",
            content: COMPACTION_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: options.userPrompt,
          },
        ] satisfies ChatRequestMessage[],
      },
    },
  });

  return parseCompletionText(response);
}

function isCompletedCandidateBlock(block: ReplayBlock, currentTurnId?: string) {
  if (!block.turnId || block.turnId === currentTurnId || block.isActiveTurn || !block.isCompleted) {
    return false;
  }

  return block.messages.every((message) => message.status === "done");
}

/**
 * Compaction-request budget only: COMPACTION_SYSTEM_PROMPT + user prompt
 * (history + template + previous summary). Does NOT count the agent system
 * prompt or tool definitions — those are not sent on the summarizer call.
 */
export function estimateCompactionRequestTokens(options: {
  historyText: string;
  previousSummary?: string | null;
  tokenizerKind?: string | null;
}) {
  const userPrompt = buildCompactionUserPrompt({
    historyText: options.historyText,
    previousSummary: options.previousSummary,
  });

  return estimateConversationTokens({
    messages: [
      {
        content: COMPACTION_SYSTEM_PROMPT,
        role: "system",
      },
      {
        content: userPrompt,
        role: "user",
      },
    ],
    tokenizerKind: options.tokenizerKind,
    tools: [],
  });
}

/**
 * Pack oldest → newer candidate turns into one summarizer call that fits the
 * compaction input budget (no agent system/tools). Always includes at least
 * the oldest candidate so the outer compact loop can make progress.
 */
export function selectOldestCompactionBatch(options: {
  blocks: ReplayBlock[];
  candidateTurnIds: string[];
  currentTurnId?: string;
  maxContext?: number | null;
  maxOutputTokens?: number | null;
  previousContext?: CompactedContextRecord | null;
  previewFileMap: Map<string, PreviewFile>;
  tokenLimit: number;
  tokenizerKind?: string | null;
}): string[] {
  const candidateOrder = options.candidateTurnIds.filter((turnId, index, all) => all.indexOf(turnId) === index);
  if (candidateOrder.length === 0) {
    return [];
  }

  const blockByTurnId = new Map<string, ReplayBlock>();
  for (const block of options.blocks) {
    if (
      block.turnId &&
      candidateOrder.includes(block.turnId) &&
      isCompletedCandidateBlock(block, options.currentTurnId)
    ) {
      blockByTurnId.set(block.turnId, block);
    }
  }

  const orderedTurnIds = candidateOrder.filter((turnId) => blockByTurnId.has(turnId));
  if (orderedTurnIds.length === 0) {
    return [];
  }

  // Reserve room for the summary output (same cap family as compactReplayBlocks).
  const reservedOutput = Math.min(
    options.tokenLimit * 2,
    typeof options.maxOutputTokens === "number" && Number.isFinite(options.maxOutputTokens) && options.maxOutputTokens > 0
      ? Math.floor(options.maxOutputTokens)
      : options.tokenLimit * 2,
  );
  const inputBudget = resolveMaxReplayInput(options.maxContext ?? undefined, reservedOutput);
  const previousSummary = options.previousContext?.summary ?? null;
  const batchTurnIds: string[] = [];

  for (const turnId of orderedTurnIds) {
    const nextBatch = [...batchTurnIds, turnId];
    const historyText = buildCompactionHistoryText(
      nextBatch.flatMap((id) => blockByTurnId.get(id)?.messages ?? []),
      options.previewFileMap,
    );
    const requestTokens = estimateCompactionRequestTokens({
      historyText,
      previousSummary,
      tokenizerKind: options.tokenizerKind,
    });

    if (requestTokens > inputBudget && batchTurnIds.length > 0) {
      break;
    }

    batchTurnIds.push(turnId);
    // Single oversized oldest turn: still force one turn so the loop progresses;
    // compactReplayBlocks / the model may still fail if truly impossible.
    if (requestTokens > inputBudget) {
      break;
    }
  }

  return batchTurnIds;
}

export async function compactReplayBlocks(options: {
  blocks: ReplayBlock[];
  chatId: string;
  currentTurnId?: string;
  droppedTurnIds: string[];
  model: ProviderModelInfo;
  previousContext?: CompactedContextRecord | null;
  projectId: string;
  previewFileMap: Map<string, PreviewFile>;
  tokenLimit: number;
}) {
  const droppedTurnIds = new Set(options.droppedTurnIds);
  const previousCompactedTurnIds = new Set(options.previousContext?.compactedTurnIds ?? []);
  const candidateBlocks = options.blocks.filter(
    (block) =>
      block.turnId &&
      droppedTurnIds.has(block.turnId) &&
      !previousCompactedTurnIds.has(block.turnId) &&
      isCompletedCandidateBlock(block, options.currentTurnId),
  );

  if (candidateBlocks.length === 0) {
    return null;
  }

  const historyText = buildCompactionHistoryText(
    candidateBlocks.flatMap((block) => block.messages),
    options.previewFileMap,
  );
  const maxTokens = Math.min(
    options.model.maxOutputTokens ?? options.tokenLimit * 2,
    options.tokenLimit * 2,
  );
  let summary = normalizeSummaryStructure(
    await requestSummary({
      chatId: options.chatId,
      maxTokens,
      model: options.model,
      projectId: options.projectId,
      userPrompt: buildCompactionUserPrompt({
        historyText,
        previousSummary: options.previousContext?.summary,
      }),
    }),
  );
  let tokens = estimateTextTokens(summary, {
    tokenizerKind: options.model.tokenizerKind,
  });

  if (tokens > options.tokenLimit) {
    summary = normalizeSummaryStructure(
      await requestSummary({
        chatId: options.chatId,
        maxTokens,
        model: options.model,
        projectId: options.projectId,
        userPrompt: buildCompactionUserPrompt({
          historyText,
          previousSummary: options.previousContext?.summary,
          stricter: true,
        }),
      }),
    );
    tokens = estimateTextTokens(summary, {
      tokenizerKind: options.model.tokenizerKind,
    });
  }

  if (tokens > options.tokenLimit) {
    summary = compressSummaryPreservingSections(summary, options.tokenLimit);
    tokens = estimateTextTokens(summary, {
      tokenizerKind: options.model.tokenizerKind,
    });
  }

  if (tokens > options.tokenLimit) {
    throw new Error("Conversation too long.");
  }

  return {
    compactedTurnIds: Array.from(
      new Set([
        ...(options.previousContext?.compactedTurnIds ?? []),
        ...candidateBlocks.map((block) => block.turnId).filter((turnId): turnId is string => Boolean(turnId)),
      ]),
    ),
    summary,
    tokens,
    updatedAtMs: Date.now(),
  } satisfies CompactedContextRecord;
}

export function buildCompactedContextMessage(summary: string): ChatRequestMessage {
  return {
    content: [
      "Compacted context from earlier completed turns.",
      "",
      summary,
    ].join("\n"),
    role: "system",
  };
}

export function resolveModelId(model: ProviderModelInfo): ModelId {
  return model.id;
}
