import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { frontendLogger } from "./logger";
import { resolveMaxPromptSize } from "./env";
import type { Message, ModelCapability, ModelId, PreviewFile } from "../types/workspace";
import {
  createToolCallFromPart,
  getAssistantConversationContent,
  getMessageParts,
} from "./message-parts";

type ReasoningLevel = string;
export const INTERRUPTED_WORKSPACE_CHAT_ERROR = "__WIZZLE_PROVIDER_CHAT_INTERRUPTED__";
const DEFAULT_REASONING_LEVELS = ["low", "medium", "high", "max"] as const;
const MAX_TITLE_INPUT_LENGTH = 1_000;
const MAX_TITLE_OUTPUT_TOKENS = 256;
const MAX_TITLE_RETRY_OUTPUT_TOKENS = 512;
const MAX_ENHANCEMENT_INPUT_LENGTH = 8_000;
const MAX_ENHANCEMENT_OUTPUT_TOKENS = 4 * 1_024;
const TITLE_SYSTEM_PROMPT =
  "You are naming a chat, not replying to the user. Generate only a short chat title based on the first user message and attached file names. Do not answer the request. Do not explain. Do not add quotes, prefixes, markdown, bullets, or extra text. Return only the title, in 3 to 6 words.";
const ENHANCEMENT_SYSTEM_PROMPT =
  "You are rewriting a user's draft, not replying to it. Improve grammar, clarity, and specificity while preserving intent, constraints, technical meaning, and tone. Do not answer the request. Do not solve the task. Do not add markdown, bullets, greetings, explanations, or commentary. Return the rewritten draft wrapped in exactly one <enhanced_prompt>...</enhanced_prompt> block.";

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type OpenAIChatToolCall = {
  function: {
    arguments: string;
    name: string;
  };
  id: string;
  type: "function";
};

type ProxyChatChunkPayload = {
  chunk: string;
  kind: "content" | "reasoning" | "toolArguments" | "toolCallId" | "toolName";
  requestId: string;
  toolCallIndex?: number | null;
};

export type WorkspaceChatChunk =
  | {
      kind: "content" | "reasoning";
      text: string;
    }
  | {
      kind: "toolArguments" | "toolCallId" | "toolName";
      text: string;
      toolCallIndex: number;
    };

export type ChatRequestMessage = {
  content?: string | OpenAIContentPart[] | null;
  role: "assistant" | "system" | "tool" | "user";
  tool_call_id?: string;
  tool_calls?: OpenAIChatToolCall[];
};

export type ProxyToolDefinition = {
  function: {
    description: string;
    name: string;
    parameters: Record<string, unknown>;
  };
  type: "function";
};

type ChatCompletionJson = {
  choices?: Array<{
    message?: {
      content?: string | OpenAIContentPart[];
    };
  }>;
};

/** Per-session stream request ids so interrupt targets the correct run (#17 / #27). */
const activeStreamRequestIdBySession = new Map<string, string>();
/** Last-started stream (prompt enhancement / title-less helpers without a session scope). */
let activeGlobalStreamRequestId: string | null = null;

function resolveFallbackReasoningLevel(modelId: ModelId): ReasoningLevel {
  return modelId.includes("max") ? "max" : "medium";
}

function normalizeReasoningLevels(reasoningLevels?: string[]) {
  const normalizedLevels = (reasoningLevels ?? [])
    .map((level) => level.trim())
    .filter(Boolean);

  return normalizedLevels.length > 0 ? normalizedLevels : [...DEFAULT_REASONING_LEVELS];
}

export function resolveLowestReasoningLevel(reasoningLevels?: string[]) {
  return normalizeReasoningLevels(reasoningLevels)[0]!;
}

export function resolvePromptEnhancementReasoningLevel(reasoningLevels?: string[]) {
  const normalizedLevels = normalizeReasoningLevels(reasoningLevels);

  return normalizedLevels[1] ?? normalizedLevels[0]!;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }

  return fallback;
}

export function extractMessageText(payload: ChatCompletionJson) {
  const content = payload.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("");
  }

  return "";
}

function extractTaggedEnhancedPrompt(responseText: string) {
  const taggedMatch = responseText.match(/<enhanced_prompt>\s*([\s\S]*?)\s*<\/enhanced_prompt>/i);

  return taggedMatch?.[1] ?? null;
}

function normalizeEnhancedPromptResponse(responseText: string) {
  const extractedText = extractTaggedEnhancedPrompt(responseText) ?? responseText;

  return extractedText
    .replace(/^improved\s+draft\s*:\s*/i, "")
    .replace(/^enhanced\s+prompt\s*:\s*/i, "")
    .replace(/^rewritten\s+prompt\s*:\s*/i, "")
    .replace(/^here(?:'s| is)\s+(?:the\s+)?(?:improved|enhanced|rewritten)\s+(?:draft|prompt)\s*:\s*/i, "")
    .replace(/^```[a-zA-Z0-9_-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "")
    .trim();
}

function normalizePartialEnhancedPromptResponse(responseText: string) {
  const openTagMatch = responseText.match(/<enhanced_prompt>\s*/i);
  const responseAfterOpenTag =
    openTagMatch?.index === undefined
      ? responseText
      : responseText.slice(openTagMatch.index + openTagMatch[0].length);

  return responseAfterOpenTag
    .replace(/\s*<\/enhanced_prompt>\s*$/i, "")
    .replace(/^improved\s+draft\s*:\s*/i, "")
    .replace(/^enhanced\s+prompt\s*:\s*/i, "")
    .replace(/^rewritten\s+prompt\s*:\s*/i, "")
    .trim();
}

function truncateAtWordBoundary(text: string, maxLength: number) {
  const normalized = text.trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const sliced = normalized.slice(0, maxLength);
  const trimmedSlice = sliced.trimEnd();
  const lastWhitespaceIndex = trimmedSlice.search(/\s\S*$/);

  if (lastWhitespaceIndex <= 0) {
    return trimmedSlice;
  }

  return trimmedSlice.slice(0, lastWhitespaceIndex).trimEnd();
}

export function resolvePromptEnhancementInputLimit() {
  return MAX_ENHANCEMENT_INPUT_LENGTH;
}

export function resolvePromptInputLimit() {
  return resolveMaxPromptSize();
}

function buildTextAttachmentBlock(attachments: PreviewFile[]) {
  const textAttachments = attachments.filter(
    (attachment) => (attachment.kind === "markdown" || attachment.kind === "text") && attachment.content,
  );

  if (textAttachments.length === 0) {
    return "";
  }

  return textAttachments
    .map((attachment) => {
      const label = attachment.kind === "markdown" ? "markdown" : attachment.language ?? "text";

      return [
        `Attached file: ${attachment.name}`,
        `Type: ${label}`,
        "",
        "```",
        attachment.content ?? "",
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

function buildUserContentPartsForCapabilities(
  prompt: string,
  attachments: PreviewFile[],
  modelCapabilities: ModelCapability[],
): OpenAIContentPart[] {
  const parts: OpenAIContentPart[] = [];
  const trimmedPrompt = prompt.trim();
  const attachmentBlock = buildTextAttachmentBlock(attachments);
  const textSections = [trimmedPrompt, attachmentBlock].filter(Boolean);

  if (textSections.length > 0) {
    parts.push({ type: "text", text: textSections.join("\n\n") });
  }

  for (const attachment of attachments) {
    if (
      attachment.kind !== "image" ||
      !attachment.imageSrc ||
      !modelCapabilities.includes("image")
    ) {
      continue;
    }

    parts.push({
      type: "image_url",
      image_url: {
        url: attachment.imageSrc,
      },
    });
  }

  return parts;
}

type ReadToolImageContext = {
  imageSrc: string;
  name: string;
};

type ReadReplayMetadata = {
  binary: boolean | null;
  contentLength: number;
  endLine: number | null;
  fingerprint: string;
  path: string;
  startLine: number | null;
  totalLines: number | null;
};

const REDACTED_DATA_URL_MIN_LENGTH = 128;
const DATA_URL_PATTERN = /data:[^,\s"'<>]+,[A-Za-z0-9+/=_-]{128,}/g;
const MAX_REPLAY_COMMAND_OUTPUT_LENGTH = 24_000;
const MAX_REPLAY_FILE_SNAPSHOT_LENGTH = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getStringField(record: Record<string, unknown>, key: string) {
  const value = record[key];

  return typeof value === "string" ? value : "";
}

function getNumberField(record: Record<string, unknown>, key: string) {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hashString(value: string) {
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

function formatApproxByteCount(value: number) {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }

  return `${value} bytes`;
}

function truncateReplayText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return {
      text: value,
      truncated: false,
    };
  }

  const marker = `\n\n[...${formatApproxByteCount(value.length - maxLength)} omitted from replay...]\n\n`;
  const availableLength = Math.max(0, maxLength - marker.length);
  const headLength = Math.ceil(availableLength * 0.65);
  const tailLength = Math.max(0, availableLength - headLength);

  return {
    text: `${value.slice(0, headLength)}${marker}${tailLength > 0 ? value.slice(-tailLength) : ""}`,
    truncated: true,
  };
}

function describeRedactedDataUrl(value: string) {
  const commaIndex = value.indexOf(",");
  const metadata = commaIndex >= 0 ? value.slice(0, commaIndex) : "data:";
  const payloadLength = commaIndex >= 0 ? value.length - commaIndex - 1 : value.length;
  const mimeType = metadata.match(/^data:([^;,]+)/i)?.[1] ?? "data";
  const approxBytes = metadata.toLowerCase().includes(";base64")
    ? Math.floor((payloadLength * 3) / 4)
    : payloadLength;

  return `[${mimeType} data URL omitted from replay text; approximately ${formatApproxByteCount(approxBytes)}]`;
}

function parseJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseReadReplayMetadata(content: string): ReadReplayMetadata | null {
  const parsed = parseJsonObject(content);

  if (!parsed || parsed.ok === false) {
    return null;
  }

  const path = getStringField(parsed, "path").trim();

  if (!path) {
    return null;
  }

  const textContent = getStringField(parsed, "content");
  const imageContent = getStringField(parsed, "imageSrc");
  const messageContent = getStringField(parsed, "message");
  const contentForHash = textContent || imageContent || messageContent;

  if (!contentForHash) {
    return null;
  }

  const startLine = getNumberField(parsed, "startLine");
  const endLine = getNumberField(parsed, "endLine");
  const totalLines = getNumberField(parsed, "totalLines");
  const binary = typeof parsed.binary === "boolean" ? parsed.binary : null;
  const normalizedPath = path.replace(/\\/g, "/");
  const fingerprint = [
    normalizedPath,
    startLine ?? "all-start",
    endLine ?? "all-end",
    contentForHash.length,
    hashString(contentForHash),
  ].join(":");

  return {
    binary,
    contentLength: contentForHash.length,
    endLine,
    fingerprint,
    path,
    startLine,
    totalLines,
  };
}

export function collectDuplicateReadReplayMessageIds(history: Message[]) {
  const latestMessageIdByFingerprint = new Map<string, string>();
  const duplicateMessageIds = new Set<string>();

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];

    if (message?.role !== "tool" || message.toolName !== "read" || !message.toolCallId) {
      continue;
    }

    const metadata = parseReadReplayMetadata(message.content);

    if (!metadata) {
      continue;
    }

    if (latestMessageIdByFingerprint.has(metadata.fingerprint)) {
      duplicateMessageIds.add(message.id);
      continue;
    }

    latestMessageIdByFingerprint.set(metadata.fingerprint, message.id);
  }

  return duplicateMessageIds;
}

function buildDuplicateReadReplayContent(content: string) {
  const metadata = parseReadReplayMetadata(content);
  const payload: Record<string, unknown> = {
    duplicate: true,
    message:
      "Duplicate read result omitted from replay because an identical later read result is still included. Same path and same content hash. If available and needed, use git to read history of that file.",
    ok: true,
  };

  if (metadata) {
    payload.path = metadata.path;
    payload.startLine = metadata.startLine;
    payload.endLine = metadata.endLine;
    payload.totalLines = metadata.totalLines;
    payload.binary = metadata.binary;
    payload.omittedContentLength = metadata.contentLength;
  }

  return JSON.stringify(payload);
}

function compactBashToolResultForReplay(record: Record<string, unknown>) {
  const combinedOutput = getStringField(record, "combinedOutput");
  const stdout = getStringField(record, "stdout");
  const stderr = getStringField(record, "stderr");
  const replayOutput = combinedOutput || [stdout, stderr].filter(Boolean).join("\n");
  const nextRecord = { ...record };

  delete nextRecord.stdout;
  delete nextRecord.stderr;

  if (replayOutput) {
    const truncatedOutput = truncateReplayText(
      replayOutput,
      MAX_REPLAY_COMMAND_OUTPUT_LENGTH,
    );

    nextRecord.combinedOutput = truncatedOutput.text;
    if (truncatedOutput.truncated) {
      nextRecord.replayOutputTruncated = true;
      nextRecord.originalCombinedOutputLength = replayOutput.length;
    }
  }

  return nextRecord;
}

function compactFileMutationToolResultForReplay(record: Record<string, unknown>) {
  const nextRecord = { ...record };

  for (const field of ["beforeContent", "afterContent"]) {
    const value = getStringField(record, field);

    if (!value) {
      continue;
    }

    const truncatedValue = truncateReplayText(value, MAX_REPLAY_FILE_SNAPSHOT_LENGTH);
    nextRecord[field] = truncatedValue.text;

    if (truncatedValue.truncated) {
      nextRecord[`${field}TruncatedForReplay`] = true;
      nextRecord[`${field}OriginalLength`] = value.length;
    }
  }

  return nextRecord;
}

function compactToolResultJsonForReplay(
  record: Record<string, unknown>,
  toolName?: string,
) {
  switch (toolName) {
    case "bash":
      return compactBashToolResultForReplay(record);
    case "edit":
    case "write":
      return compactFileMutationToolResultForReplay(record);
    default:
      return record;
  }
}

function redactDataUrlString(value: string) {
  if (
    value.length >= REDACTED_DATA_URL_MIN_LENGTH &&
    value.startsWith("data:") &&
    value.includes(",")
  ) {
    return {
      changed: true,
      value: describeRedactedDataUrl(value),
    };
  }

  const nextValue = value.replace(DATA_URL_PATTERN, (match) => describeRedactedDataUrl(match));

  return {
    changed: nextValue !== value,
    value: nextValue,
  };
}

function redactDataUrlsFromJsonValue(value: unknown): { changed: boolean; value: unknown } {
  if (typeof value === "string") {
    return redactDataUrlString(value);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const nextValue = value.map((item) => {
      const result = redactDataUrlsFromJsonValue(item);
      changed ||= result.changed;
      return result.value;
    });

    return { changed, value: nextValue };
  }

  if (!value || typeof value !== "object") {
    return { changed: false, value };
  }

  let changed = false;
  const nextValue = Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const result = redactDataUrlsFromJsonValue(item);
      changed ||= result.changed;
      return [key, result.value];
    }),
  );

  return { changed, value: nextValue };
}

export function sanitizeToolResultContentForReplay(
  content: string,
  options: {
    isDuplicateRead?: boolean;
    toolName?: string;
  } = {},
) {
  if (!content) {
    return content;
  }

  if (options.isDuplicateRead && options.toolName === "read") {
    return buildDuplicateReadReplayContent(content);
  }

  const parsed = parseJsonObject(content);

  if (parsed) {
    const compacted = compactToolResultJsonForReplay(parsed, options.toolName);
    const result = redactDataUrlsFromJsonValue(compacted);

    return result.changed || compacted !== parsed ? JSON.stringify(result.value) : content;
  }

  return redactDataUrlString(content).value;
}

export function extractReadToolImageContext(content: string): ReadToolImageContext | null {
  try {
    const parsed = JSON.parse(content);
    if (!parsed.imageSrc || typeof parsed.imageSrc !== "string" || !parsed.imageSrc.startsWith("data:")) {
      return null;
    }

    return {
      imageSrc: parsed.imageSrc,
      name: parsed.path?.split("/").pop() ?? "read-image",
    };
  } catch {
    return null;
  }
}

export function buildReadToolImageContextMessage(options: {
  modelCapabilities: ModelCapability[];
  toolOutput: string;
}): ChatRequestMessage[] {
  if (!options.modelCapabilities.includes("image")) {
    return [];
  }

  const image = extractReadToolImageContext(options.toolOutput);

  if (!image) {
    return [];
  }

  return [
    {
      content: [
        {
          type: "text",
          text: `Tool context: the previous read call returned the image "${image.name}". Use it as context for the current task.`,
        },
        {
          type: "image_url",
          image_url: { url: image.imageSrc },
        },
      ],
      role: "user",
    },
  ];
}

function buildAssistantConversationMessage(message: Message): ChatRequestMessage[] {
  const parts = getMessageParts(message);
  const toolCalls = parts
    .filter((part) => part.type === "tool_call")
    .map((part) => createToolCallFromPart(part))
    .filter((toolCall): toolCall is NonNullable<typeof toolCall> => Boolean(toolCall))
    .map((toolCall) => ({
      function: {
        arguments: toolCall.input ?? "{}",
        name: toolCall.name,
      },
      id: toolCall.id,
      type: "function" as const,
    }));
  const content = getAssistantConversationContent(message).trim();

  if (!content && toolCalls.length === 0) {
    return [];
  }

  return [
    {
      content: content || null,
      role: "assistant",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ];
}

function resolveAttachments(message: Message, previewFileMap: Map<string, PreviewFile>) {
  return (message.linkedFileIds ?? [])
    .map((fileId) => previewFileMap.get(fileId))
    .filter((file): file is PreviewFile => Boolean(file));
}

export function buildChatMessages(
  history: Message[],
  previewFileMap: Map<string, PreviewFile>,
  modelCapabilities: ModelCapability[],
  options: {
    duplicateReadMessageIds?: ReadonlySet<string>;
  } = {},
): ChatRequestMessage[] {
  const duplicateReadMessageIds =
    options.duplicateReadMessageIds ?? collectDuplicateReadReplayMessageIds(history);

  return history.flatMap((message) => {
    if (message.role === "assistant") {
      return buildAssistantConversationMessage(message);
    }

    if (message.role === "tool") {
      if (!message.toolCallId) {
        return [];
      }

      const isDuplicateRead =
        message.toolName === "read" && duplicateReadMessageIds.has(message.id);

      return [
        {
          content: sanitizeToolResultContentForReplay(message.content, {
            isDuplicateRead,
            toolName: message.toolName,
          }),
          role: "tool",
          tool_call_id: message.toolCallId,
        },
        ...(
          message.toolName === "read" && !isDuplicateRead
            ? buildReadToolImageContextMessage({
                modelCapabilities,
                toolOutput: message.content,
              })
            : []
        ),
      ];
    }

    const attachments = resolveAttachments(message, previewFileMap);
    const contentParts = buildUserContentPartsForCapabilities(
      message.content,
      attachments,
      modelCapabilities,
    );

    return [
      {
        content:
          contentParts.length === 1 && contentParts[0]?.type === "text"
            ? contentParts[0].text
            : contentParts,
        role: "user",
      },
    ];
  });
}

export async function streamWorkspaceChat(options: {
  chatId: string;
  history: ChatRequestMessage[];
  maxTokens?: number;
  modelId: ModelId;
  onChunk: (chunk: WorkspaceChatChunk) => void;
  onReasoningFinished?: () => void;
  projectId: string;
  reasoningLevel?: string;
  toolChoice?: "auto" | "none";
  tools?: ProxyToolDefinition[];
}) {
  const requestBody = {
    messages: options.history,
    model: options.modelId,
    stream: true,
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    ...(options.tools?.length ? { tools: options.tools } : {}),
  };

  if (!isTauriRuntime()) {
    throw new Error("Wizzle chat streaming is only available inside the desktop app.");
  }

  const requestId = crypto.randomUUID();
  const sessionKey = options.chatId.trim();
  if (sessionKey) {
    activeStreamRequestIdBySession.set(sessionKey, requestId);
  } else {
    activeGlobalStreamRequestId = requestId;
  }
  frontendLogger.info("frontend.chat-stream", "stream_started", {
    chatIdLength: options.chatId.length,
    historyCount: options.history.length,
    modelId: options.modelId,
    projectIdLength: options.projectId.length,
    requestBodyLength: JSON.stringify(requestBody).length,
    requestIdLength: requestId.length,
    toolCount: options.tools?.length ?? 0,
    toolChoice: options.toolChoice ?? null,
  });
  let lastChunkKind: "content" | "reasoning" | "tool" | null = null;
  let didNotifyReasoningFinished = false;
  const notifyReasoningFinished = () => {
    if (didNotifyReasoningFinished || lastChunkKind !== "reasoning") {
      return;
    }

    didNotifyReasoningFinished = true;
    options.onReasoningFinished?.();
  };
  const unlisten = await listen<ProxyChatChunkPayload>("provider-chat-chunk", (event) => {
    if (event.payload.requestId !== requestId || !event.payload.chunk) {
      return;
    }

    frontendLogger.debug("frontend.chat-stream", "stream_chunk_received", {
      kind: event.payload.kind,
      length: event.payload.chunk.length,
      requestIdLength: event.payload.requestId.length,
      toolCallIndex: event.payload.toolCallIndex ?? null,
    });

    if (event.payload.kind === "content" || event.payload.kind === "reasoning") {
      if (event.payload.kind === "content") {
        notifyReasoningFinished();
      }
      lastChunkKind = event.payload.kind;
      options.onChunk({
        kind: event.payload.kind,
        text: event.payload.chunk,
      });
      return;
    }

    if (typeof event.payload.toolCallIndex !== "number") {
      return;
    }

    notifyReasoningFinished();
    lastChunkKind = "tool";
    options.onChunk({
      kind: event.payload.kind,
      text: event.payload.chunk,
      toolCallIndex: event.payload.toolCallIndex,
    });
  });

  try {
    await invoke("stream_provider_chat", {
      input: {
        requestId,
        modelUuid: options.modelId,
        projectId: options.projectId,
        chatId: options.chatId,
        reasoningLevel: options.reasoningLevel ?? resolveFallbackReasoningLevel(options.modelId),
        body: requestBody,
      },
    });
    frontendLogger.info("frontend.chat-stream", "stream_finished", {
      requestIdLength: requestId.length,
    });
  } catch (error) {
    if (getErrorMessage(error, "") === INTERRUPTED_WORKSPACE_CHAT_ERROR) {
      frontendLogger.info("frontend.chat-stream", "stream_interrupted", {
        requestIdLength: requestId.length,
      });
      throw new Error(INTERRUPTED_WORKSPACE_CHAT_ERROR);
    }

    frontendLogger.error("frontend.chat-stream", "stream_failed", {
      requestIdLength: requestId.length,
      error,
    });
    throw new Error(getErrorMessage(error, "Wizzle could not complete the request."));
  } finally {
    if (sessionKey && activeStreamRequestIdBySession.get(sessionKey) === requestId) {
      activeStreamRequestIdBySession.delete(sessionKey);
    }
    if (!sessionKey && activeGlobalStreamRequestId === requestId) {
      activeGlobalStreamRequestId = null;
    }

    lastChunkKind = null;
    didNotifyReasoningFinished = false;
    unlisten();
  }
}

export async function interruptWorkspaceChat(options: { sessionId?: string } = {}) {
  const sessionId = options.sessionId?.trim();
  const requestId = sessionId
    ? activeStreamRequestIdBySession.get(sessionId) ?? null
    : activeGlobalStreamRequestId;

  if (requestId) {
    frontendLogger.info("frontend.chat-stream", "interrupt_requested", {
      requestIdLength: requestId.length,
      sessionScoped: Boolean(sessionId),
    });
    await invoke("cancel_provider_chat", {
      input: {
        requestId,
      },
    });
  }

  if (sessionId) {
    await invoke("interrupt_session_run", {
      input: {
        sessionId,
      },
    });
  }
}

export async function interruptWorkspacePromptEnhancement() {
  await interruptWorkspaceChat();
}

export function isInterruptedWorkspaceChatError(error: unknown) {
  return error instanceof Error && error.message === INTERRUPTED_WORKSPACE_CHAT_ERROR;
}

export async function generateWorkspaceSessionTitle(options: {
  attachments: PreviewFile[];
  chatId: string;
  modelId: ModelId;
  prompt: string;
  projectId: string;
  reasoningLevels?: string[];
}) {
  if (!isTauriRuntime()) {
    throw new Error("Wizzle title generation is only available inside the desktop app.");
  }

  const attachmentList = options.attachments.map((attachment) => attachment.name).join(", ");
  const sourceText = truncateAtWordBoundary(
    [
      options.prompt.trim() ? `First user message:\n${options.prompt.trim()}` : "",
      attachmentList ? `Attached files:\n${attachmentList}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    MAX_TITLE_INPUT_LENGTH,
  );

  frontendLogger.info("frontend.chat-stream", "title_generation_started", {
    attachmentCount: options.attachments.length,
    chatIdLength: options.chatId.length,
    projectIdLength: options.projectId.length,
    promptLength: options.prompt.length,
    truncatedInputLength: sourceText.length,
  });

  function buildTitleRequestBody(maxTokens: number) {
    return {
      model: options.modelId,
      stream: false,
      max_tokens: maxTokens,
      messages: [
        {
          role: "system" as const,
          content: TITLE_SYSTEM_PROMPT,
        },
        {
          role: "user" as const,
          content: [
            "Generate a concise chat title in 3 to 6 words.",
            sourceText || "Generate a title for this chat.",
          ].join("\n\n"),
        },
      ],
    };
  }

  async function requestTitle(maxTokens: number) {
    const response = await invoke<string>("complete_provider_chat", {
      input: {
        modelUuid: options.modelId,
        projectId: options.projectId,
        chatId: options.chatId,
        reasoningLevel: resolveLowestReasoningLevel(options.reasoningLevels),
        body: buildTitleRequestBody(maxTokens),
      },
    });

    return {
      responseLength: response.length,
      title: extractMessageText(JSON.parse(response) as ChatCompletionJson).trim(),
    };
  }

  try {
    let result = await requestTitle(MAX_TITLE_OUTPUT_TOKENS);

    if (!result.title) {
      frontendLogger.info("frontend.chat-stream", "title_generation_retrying", {
        initialResponseLength: result.responseLength,
        retryMaxTokens: MAX_TITLE_RETRY_OUTPUT_TOKENS,
      });
      result = await requestTitle(MAX_TITLE_RETRY_OUTPUT_TOKENS);
    }

    frontendLogger.info("frontend.chat-stream", "title_generation_finished", {
      responseLength: result.responseLength,
      titleLength: result.title.length,
    });
    return result.title;
  } catch (error) {
    frontendLogger.error("frontend.chat-stream", "title_generation_failed", {
      error,
    });
    return "";
  }
}

export async function enhanceWorkspacePrompt(options: {
  chatId: string;
  draft: string;
  modelId: ModelId;
  onDraft?: (draft: string) => void;
  projectId: string;
  reasoningLevel?: string;
  reasoningLevels?: string[];
}) {
  if (!isTauriRuntime()) {
    throw new Error("Wizzle prompt enhancement is only available inside the desktop app.");
  }

  frontendLogger.info("frontend.chat-stream", "prompt_enhancement_started", {
    chatIdLength: options.chatId.length,
    draftLength: options.draft.length,
    modelId: options.modelId,
    projectIdLength: options.projectId.length,
  });
  const truncatedDraft = truncateAtWordBoundary(options.draft, MAX_ENHANCEMENT_INPUT_LENGTH);
  const reasoningLevel =
    options.reasoningLevel || resolvePromptEnhancementReasoningLevel(options.reasoningLevels);
  let rawEnhancedDraft = "";

  await streamWorkspaceChat({
    chatId: options.chatId,
    history: [
      {
        role: "system",
        content: ENHANCEMENT_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: [
          "Rewrite this draft for the user.",
          "",
          "Original draft:",
          truncatedDraft,
        ].join("\n"),
      },
    ],
    maxTokens: MAX_ENHANCEMENT_OUTPUT_TOKENS,
    modelId: options.modelId,
    onChunk: (chunk) => {
      if (chunk.kind !== "content") {
        return;
      }

      rawEnhancedDraft += chunk.text;
      const partialDraft = normalizePartialEnhancedPromptResponse(rawEnhancedDraft);

      if (partialDraft) {
        options.onDraft?.(partialDraft);
      }
    },
    projectId: options.projectId,
    reasoningLevel,
    toolChoice: "none",
  });

  const enhancedDraft = normalizeEnhancedPromptResponse(rawEnhancedDraft);
  frontendLogger.info("frontend.chat-stream", "prompt_enhancement_finished", {
    enhancedLength: enhancedDraft.length,
    reasoningLevel,
    responseLength: rawEnhancedDraft.length,
    truncatedInputLength: truncatedDraft.length,
  });

  if (!enhancedDraft) {
    throw new Error("Wizzle could not enhance that prompt.");
  }

  return enhancedDraft;
}
