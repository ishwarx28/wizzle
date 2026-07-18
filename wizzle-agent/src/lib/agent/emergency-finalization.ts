import type {
  CompactedContextRecord,
  Message,
  ModelReasoningConfig,
  PreviewFile,
  ReasoningSelection,
} from "../../types/workspace";
import {
  estimateConversationTokens,
  FALLBACK_CONTEXT_LIMIT,
  resolveReservedOutputTokens,
} from "../context-budget";
import { resolveContextSafetyPercent } from "../env";
import {
  isReasoningOffVariant,
  modelReasoningVariants,
  normalizeReasoningSelection,
} from "../reasoning-config";
import {
  sanitizeToolResultContentForReplay,
  type ChatRequestMessage,
} from "../chat-stream";
import { containsRawToolSyntax } from "./context-pressure";

export const EMERGENCY_FINAL_MAX_OUTPUT_TOKENS = 6_144;

const EMERGENCY_FINAL_MAX_INPUT_TOKENS = 24_000;
const EMERGENCY_FINAL_RETRY_MAX_INPUT_TOKENS = 12_000;
const MAX_USER_REQUEST_CHARS = 32_000;
const MAX_PLAN_CHARS = 12_000;
const MAX_ACTIVITY_MESSAGE_CHARS = 8_000;
const MAX_COMPACTED_CONTEXT_CHARS = 16_000;
const MAX_DETAILED_ACTIVITY_MESSAGES = 30;
const MAX_RETRY_DETAILED_ACTIVITY_MESSAGES = 12;

export type EmergencyFinalizationBudget = {
  inputTokens: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  safetyMarginTokens: number;
};

export type EmergencyFinalizationRequest = {
  budget: EmergencyFinalizationBudget;
  conversation: ChatRequestMessage[];
  estimatedInputTokens: number;
  retryConversation: ChatRequestMessage[];
  retryEstimatedInputTokens: number;
};

type EmergencySection = {
  content: string;
  title: string;
};

function normalizeContextLimit(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : FALLBACK_CONTEXT_LIMIT;
}

export function resolveEmergencyFinalizationBudget(options: {
  maxContextTokens?: number | null;
  maxOutputTokens?: number | null;
}): EmergencyFinalizationBudget {
  const maxContextTokens = normalizeContextLimit(options.maxContextTokens);
  const reservedOutputTokens = resolveReservedOutputTokens(
    maxContextTokens,
    options.maxOutputTokens,
  );
  const maxOutputTokens = Math.min(
    EMERGENCY_FINAL_MAX_OUTPUT_TOKENS,
    reservedOutputTokens,
  );
  const safetyMarginTokens = Math.ceil(
    maxContextTokens * (resolveContextSafetyPercent() / 100),
  );

  return {
    inputTokens: Math.max(
      0,
      Math.min(
        EMERGENCY_FINAL_MAX_INPUT_TOKENS,
        maxContextTokens - maxOutputTokens - safetyMarginTokens,
      ),
    ),
    maxContextTokens,
    maxOutputTokens,
    safetyMarginTokens,
  };
}

export function resolveEmergencyReasoningSelection(
  reasoning?: ModelReasoningConfig | null,
): ReasoningSelection | undefined {
  const variants = modelReasoningVariants(reasoning);
  const offVariant = variants.find(isReasoningOffVariant);
  const defaultVariant =
    variants.find((variant) => variant.id === reasoning?.defaultVariantId) ??
    variants.find((variant) => variant.id.trim().toLowerCase() === "default");
  const selected = offVariant ?? defaultVariant;

  return selected
    ? normalizeReasoningSelection(selected.id, reasoning)
    : undefined;
}

export function hasUsableEmergencyFinalContent(content: string) {
  return Boolean(content.trim() && !containsRawToolSyntax(content));
}

export function shouldAcceptBufferedMaxStepFinal(options: {
  content: string;
  injectedResponseCount: number;
  isLastStep: boolean;
  requiredJoinPending: boolean;
}) {
  return (
    options.isLastStep &&
    !options.requiredJoinPending &&
    options.injectedResponseCount === 0 &&
    hasUsableEmergencyFinalContent(options.content)
  );
}

function truncateMiddle(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 0) {
    return "";
  }

  const marker = "\n\n[...content omitted from emergency replay...]\n\n";
  if (maxChars <= marker.length) {
    return value.slice(0, maxChars);
  }
  const remaining = maxChars - marker.length;
  const headLength = Math.ceil(remaining * 0.6);
  const tailLength = remaining - headLength;
  return `${value.slice(0, headLength)}${marker}${tailLength > 0 ? value.slice(-tailLength) : ""}`;
}

function selectCurrentTurnMessages(history: readonly Message[], currentTurnId: string) {
  const exact = history.filter((message) => message.turnId === currentTurnId);
  if (exact.length > 0) {
    return exact;
  }

  let latestUserIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  return latestUserIndex >= 0 ? history.slice(latestUserIndex) : history.slice(-1);
}

function formatToolCalls(message: Message) {
  const calls = message.toolCalls ?? [];
  if (calls.length === 0) {
    return "";
  }

  return calls
    .map((call) => {
      const input = truncateMiddle(call.input?.trim() ?? "", 2_000);
      const status = call.status?.trim() ? ` (${call.status})` : "";
      return `- ${call.name}${status}${input ? `: ${input}` : ""}`;
    })
    .join("\n");
}

function formatActivityMessage(message: Message) {
  if (message.role === "tool") {
    const name = message.toolName?.trim() || "tool";
    const status = message.status?.trim() ? ` · ${message.status}` : "";
    return [
      `[Tool result: ${name}${status}]`,
      truncateMiddle(
        sanitizeToolResultContentForReplay(message.content, {
          toolName: message.toolName,
        }).trim(),
        MAX_ACTIVITY_MESSAGE_CHARS,
      ),
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (message.role === "assistant") {
    const toolCalls = formatToolCalls(message);
    return [
      `[Assistant progress${message.assistantPhase ? ` · ${message.assistantPhase}` : ""}]`,
      truncateMiddle(message.content.trim(), MAX_ACTIVITY_MESSAGE_CHARS),
      toolCalls ? `Tool calls:\n${toolCalls}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "[Additional user message]",
    truncateMiddle(message.content.trim(), MAX_ACTIVITY_MESSAGE_CHARS),
  ]
    .filter(Boolean)
    .join("\n");
}

function formatActivityIndex(messages: readonly Message[]) {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return `- Tool ${message.toolName?.trim() || "unknown"}: ${message.status ?? "done"}`;
      }
      if (message.role === "assistant" && message.toolCalls?.length) {
        return `- Assistant requested: ${message.toolCalls.map((call) => call.name).join(", ")}`;
      }
      return `- ${message.role}${message.assistantPhase ? ` (${message.assistantPhase})` : ""}`;
    })
    .join("\n");
}

function formatAttachments(message: Message | undefined, previewFileMap: Map<string, PreviewFile>) {
  const attachments = (message?.linkedFileIds ?? [])
    .map((id) => previewFileMap.get(id))
    .filter((file): file is PreviewFile => Boolean(file));

  if (attachments.length === 0) {
    return "";
  }

  return attachments
    .map((file) => `- ${file.name}${file.path ? ` (${file.path})` : ""}`)
    .join("\n");
}

function buildSections(options: {
  compactedContext?: CompactedContextRecord | null;
  currentTurnId: string;
  detailedMessageLimit: number;
  history: readonly Message[];
  previewFileMap: Map<string, PreviewFile>;
  planInstruction?: string;
}): EmergencySection[] {
  const currentTurn = selectCurrentTurnMessages(options.history, options.currentTurnId);
  const firstUser = currentTurn.find((message) => message.role === "user");
  const remaining = currentTurn.filter((message) => message.id !== firstUser?.id);
  const detailed = remaining.slice(-options.detailedMessageLimit);
  const omitted = remaining.slice(0, Math.max(0, remaining.length - detailed.length));
  const attachments = formatAttachments(firstUser, options.previewFileMap);
  const sections: EmergencySection[] = [];

  if (firstUser?.content.trim() || attachments) {
    sections.push({
      content: [
        truncateMiddle(firstUser?.content.trim() ?? "", MAX_USER_REQUEST_CHARS),
        attachments ? `Attached files (contents omitted):\n${attachments}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      title: "Latest user request",
    });
  }

  if (options.planInstruction?.trim()) {
    sections.push({
      content: truncateMiddle(options.planInstruction.trim(), MAX_PLAN_CHARS),
      title: "Unfinished implementation plan",
    });
  }

  if (detailed.length > 0) {
    sections.push({
      content: detailed.map(formatActivityMessage).filter(Boolean).join("\n\n"),
      title: "Recent current-turn activity",
    });
  }

  if (omitted.length > 0) {
    sections.push({
      content: formatActivityIndex(omitted),
      title: "Earlier current-turn activity index",
    });
  }

  if (options.compactedContext?.summary.trim()) {
    sections.push({
      content: truncateMiddle(
        options.compactedContext.summary.trim(),
        MAX_COMPACTED_CONTEXT_CHARS,
      ),
      title: "Earlier compacted session context",
    });
  }

  return sections;
}

function buildBoundedConversation(options: {
  inputBudget: number;
  sections: readonly EmergencySection[];
  systemPrompt: string;
}) {
  const selected: string[] = [];
  const toConversation = (parts: readonly string[]): ChatRequestMessage[] => [
    { content: options.systemPrompt, role: "system" },
    {
      content: parts.join("\n\n"),
      role: "user",
    },
  ];
  const fits = (parts: readonly string[]) =>
    estimateConversationTokens({ messages: toConversation(parts) }) <= options.inputBudget;

  for (const section of options.sections) {
    const full = `## ${section.title}\n\n${section.content}`;
    if (fits([...selected, full])) {
      selected.push(full);
      continue;
    }

    let low = 0;
    let high = section.content.length;
    let best = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = `## ${section.title}\n\n${truncateMiddle(section.content, middle)}`;
      if (fits([...selected, candidate])) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best) {
      selected.push(best);
    }
    break;
  }

  const conversation = toConversation(
    selected.length > 0
      ? selected
      : ["No additional transcript content fit in the emergency replay budget."],
  );
  return {
    conversation,
    estimatedInputTokens: estimateConversationTokens({ messages: conversation }),
  };
}

export function buildEmergencyFinalizationRequest(options: {
  compactedContext?: CompactedContextRecord | null;
  currentTurnId: string;
  history: readonly Message[];
  maxContextTokens?: number | null;
  maxOutputTokens?: number | null;
  previewFileMap: Map<string, PreviewFile>;
  systemPrompt: string;
  planInstruction?: string;
}): EmergencyFinalizationRequest {
  const budget = resolveEmergencyFinalizationBudget(options);
  const primary = buildBoundedConversation({
    inputBudget: budget.inputTokens,
    sections: buildSections({
      ...options,
      detailedMessageLimit: MAX_DETAILED_ACTIVITY_MESSAGES,
    }),
    systemPrompt: options.systemPrompt,
  });
  const retryInputBudget = Math.min(
    budget.inputTokens,
    EMERGENCY_FINAL_RETRY_MAX_INPUT_TOKENS,
  );
  const retry = buildBoundedConversation({
    inputBudget: retryInputBudget,
    sections: buildSections({
      ...options,
      detailedMessageLimit: MAX_RETRY_DETAILED_ACTIVITY_MESSAGES,
    }),
    systemPrompt: options.systemPrompt,
  });

  return {
    budget,
    conversation: primary.conversation,
    estimatedInputTokens: primary.estimatedInputTokens,
    retryConversation: retry.conversation,
    retryEstimatedInputTokens: retry.estimatedInputTokens,
  };
}
