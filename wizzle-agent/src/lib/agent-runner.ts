import { frontendLogger } from "./logger";
import { buildWorkspaceSystemPrompt } from "./agent-prompt";
import { clientEnv } from "./env";
import {
  loadAgentProjectContext,
  runAgentTool,
  type AgentToolOutputChunk,
} from "./agent-runtime";
import { resolveAgentTools } from "./agent/tool-definitions";
import {
  createAssistantMessage,
  createPendingToolMessage,
  createToolCallState,
  createToolMessage,
  type ToolExecutionPayload,
} from "./agent/message-factories";
import {
  resolveForcedFinalDisplayContent,
  type ForcedFinalKind,
  type ForcedFinalOutcome,
} from "./agent/forced-final";
import { createRejectedToolPayload, createToolApprovalRequest } from "./tool-approval";
import { normalizeStreamedToolCalls, streamAgentTurn } from "./agent/stream-turn";
import {
  buildCompactedContextMessage,
  compactReplayBlocks,
  selectOldestCompactionBatch,
} from "./agent/compaction";
import {
  buildChatMessages,
  INTERRUPTED_WORKSPACE_CHAT_ERROR,
  type ChatRequestMessage,
} from "./chat-stream";
import {
  buildReplayBlocks,
  buildPromptTokenCacheKeyData,
  selectReplayHistoryWithinBudget,
} from "./context-budget";
import type {
  AssistantPhase,
  CompactedContextRecord,
  Message,
  ModelId,
  ModelCapability,
  PermissionMode,
  PersistedTurnSummaryRecord,
  PreviewFile,
  ProviderModelInfo,
  ToolCall,
} from "../types/workspace";

const MAX_ALLOWED_AGENT_STEPS = 100;
const DEFAULT_AGENT_STEPS = 100;
/** Max older→newer summarizer passes while freeing live agent context. */
const MAX_COMPACTION_PASSES = 16;

const FINAL_RESPONSE_SYSTEM_PROMPT =
  "You have finished the tool work for this turn. Reply to the user now with the final answer only. Do not call tools. Do not add progress narration. Do not describe what you are about to do. Give the completed user-facing response.";
const FINAL_RESPONSE_AFTER_LIMIT_SYSTEM_PROMPT =
  "You have reached the maximum number of tool steps for this turn. Do not call tools. Reply to the user now with the best possible final answer based on the completed work so far. Clearly summarize what was completed, and mention any remaining limitation or incomplete part if relevant.";

function resolveMaxAgentSteps() {
  const rawValue = clientEnv.WIZZLE_MAX_AGENT_STEPS;

  if (!rawValue) {
    return DEFAULT_AGENT_STEPS;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsedValue) || parsedValue < 1) {
    return DEFAULT_AGENT_STEPS;
  }

  return Math.min(parsedValue, MAX_ALLOWED_AGENT_STEPS);
}

function resolveToolExecutionErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const message =
      "message" in error && typeof error.message === "string" ? error.message.trim() : "";

    if (message) {
      return message;
    }

    const nestedError =
      "error" in error && typeof error.error === "string" ? error.error.trim() : "";

    if (nestedError) {
      return nestedError;
    }
  }

  return "The tool could not be executed.";
}

function buildConversation(options: {
  compactedContext?: CompactedContextRecord | null;
  history: Message[];
  modelCapabilities: ModelCapability[];
  previewFileMap: Map<string, PreviewFile>;
  systemPrompt: string;
}) {
  return [
    {
      content: options.systemPrompt,
      role: "system" as const,
    },
    ...(options.compactedContext?.summary.trim()
      ? [buildCompactedContextMessage(options.compactedContext.summary)]
      : []),
    ...buildChatMessages(options.history, options.previewFileMap, options.modelCapabilities),
  ] satisfies ChatRequestMessage[];
}

function buildSystemPrompt(options: {
  currentYear: number;
  gitTrackedState: Awaited<ReturnType<typeof loadAgentProjectContext>>["gitTrackedState"];
  globalSkillFiles: Awaited<ReturnType<typeof loadAgentProjectContext>>["globalSkillFiles"];
  globalSkillsDir: Awaited<ReturnType<typeof loadAgentProjectContext>>["globalSkillsDir"];
  instructionFiles: Awaited<ReturnType<typeof loadAgentProjectContext>>["instructionFiles"];
  operatingSystem: string;
  platform: string;
  projectRoot: string;
  sessionCacheDir: Awaited<ReturnType<typeof loadAgentProjectContext>>["sessionCacheDir"];
}) {
  return buildWorkspaceSystemPrompt({
    currentYear: options.currentYear,
    gitTrackedState: options.gitTrackedState,
    globalSkillFiles: options.globalSkillFiles,
    globalSkillsDir: options.globalSkillsDir,
    instructionFiles: options.instructionFiles,
    operatingSystem: options.operatingSystem,
    platform: options.platform,
    projectRoot: options.projectRoot,
    sessionCacheDir: options.sessionCacheDir,
  });
}

function resolveRuntimePlatform() {
  if (typeof navigator !== "undefined" && navigator.platform) {
    return navigator.platform;
  }

  return "unknown";
}

function resolveRuntimeOperatingSystem() {
  if (typeof document !== "undefined") {
    const platform = document.documentElement.dataset.platform;

    if (platform) {
      return platform;
    }
  }

  if (typeof navigator !== "undefined" && navigator.userAgent) {
    return navigator.userAgent;
  }

  return "unknown";
}

/**
 * After tools have already run, a failed or empty forced-final stream must not
 * fail the whole turn (#24 / #25). Always finishes an assistant message and
 * returns an outcome the caller can settle as done.
 */
async function requestForcedFinalResponse(options: {
  chatId: string;
  conversation: ChatRequestMessage[];
  forcedFinalKind: ForcedFinalKind;
  modelId: ModelId;
  onAssistantChunk: (payload: {
    kind: "content" | "reasoning";
    messageId: string;
    text: string;
  }) => void;
  onAssistantCreated: (message: Message) => void;
  onReasoningFinished?: (messageId: string) => void;
  onAssistantStreamFinished: (messageId: string, phase: AssistantPhase) => void;
  projectId: string;
  prompt: string;
  reasoningLevel?: string | null;
  step: number;
  turnId: string;
}): Promise<ForcedFinalOutcome> {
  const finalAssistantMessage = createAssistantMessage(options.turnId);
  options.onAssistantCreated(finalAssistantMessage);

  let streamedContent = "";
  let streamError: unknown;

  try {
    const finalTurn = await streamAgentTurn({
      chatId: options.chatId,
      conversation: [
        ...options.conversation,
        {
          content: options.prompt,
          role: "system",
        },
      ],
      modelId: options.modelId,
      onChunk: (chunk) => {
        if (chunk.kind === "content") {
          streamedContent += chunk.text;
        }
        options.onAssistantChunk({
          ...chunk,
          messageId: finalAssistantMessage.id,
        });
      },
      onReasoningFinished: () => options.onReasoningFinished?.(finalAssistantMessage.id),
      projectId: options.projectId,
      reasoningLevel: options.reasoningLevel,
      tools: [],
      turnIndex: options.step,
      toToolCallState: createToolCallState,
    });
    streamedContent = finalTurn.content || streamedContent;
  } catch (error) {
    streamError = error;
    frontendLogger.error("frontend.agent", "forced_final_response_failed", {
      error,
      forcedFinalKind: options.forcedFinalKind,
      turnIdLength: options.turnId.length,
    });
  }

  const outcome = resolveForcedFinalDisplayContent({
    error: streamError,
    kind: options.forcedFinalKind,
    streamedContent,
  });

  // Inject fallback only when the stream left the assistant empty.
  if (outcome.kind !== "ok" && !streamedContent.trim()) {
    options.onAssistantChunk({
      kind: "content",
      messageId: finalAssistantMessage.id,
      text: outcome.content,
    });
  }

  options.onAssistantStreamFinished(finalAssistantMessage.id, "final");
  return outcome;
}

export async function runWorkspaceAgent(options: {
  chatId: string;
  history: Message[];
  modelId: ModelId;
  onAssistantChunk: (payload: {
    kind: "content" | "reasoning";
    messageId: string;
    text: string;
  }) => void;
  onAssistantCreated: (message: Message) => void;
  onReasoningFinished?: (messageId: string) => void;
  onAssistantStreamFinished: (messageId: string, phase: AssistantPhase) => void;
  onAssistantToolCalls: (messageId: string, toolCalls: ToolCall[]) => void;
  onCompactionStarted?: () => Promise<void> | void;
  onCompactedContext?: (context: CompactedContextRecord) => Promise<void> | void;
  /** Called when compaction exits without a new summary (or after failure cleanup). */
  onCompactionEnded?: (result: "compacted" | "skipped" | "failed") => Promise<void> | void;
  onToolMessage: (message: Message) => Promise<void> | void;
  onToolChunk?: (chunk: AgentToolOutputChunk) => void;
  onTurnFinished: (payload: { status: "done" | "error" | "interrupted"; turnId: string }) => void;
  compactedContext?: CompactedContextRecord | null;
  maxContextTokens?: number;
  modelCapabilities: ModelCapability[];
  permissionMode: PermissionMode;
  previewFileMap: Map<string, PreviewFile>;
  projectId: string;
  reasoningLevel?: string | null;
  requestToolApproval: (request: {
    command?: string;
    path?: string;
    sessionId: string;
    summary: string;
    timeout: string;
    toolCallId: string;
    toolName: "bash" | "edit" | "read" | "write";
    warning?: {
      kind: "dangerous-command" | "external-path" | "sensitive-path";
      message: string;
    };
  }) => Promise<boolean>;
  selectedModel: ProviderModelInfo;
  turnSummaries?: PersistedTurnSummaryRecord[];
  turnId: string;
  tokenizerKind?: string | null;
}) {
  const maxAgentSteps = resolveMaxAgentSteps();

  frontendLogger.info("frontend.agent", "run_started", {
    chatIdLength: options.chatId.length,
    historyCount: options.history.length,
    maxAgentSteps,
    modelId: options.modelId,
    permissionMode: options.permissionMode,
    projectIdLength: options.projectId.length,
    turnIdLength: options.turnId.length,
  });

  const projectContext = await loadAgentProjectContext(options.projectId, options.chatId);
  const tools = resolveAgentTools();
  const systemPrompt = buildSystemPrompt({
    currentYear: new Date().getFullYear(),
    gitTrackedState: projectContext.gitTrackedState,
    globalSkillFiles: projectContext.globalSkillFiles,
    globalSkillsDir: projectContext.globalSkillsDir,
    instructionFiles: projectContext.instructionFiles,
    operatingSystem: resolveRuntimeOperatingSystem(),
    platform: resolveRuntimePlatform(),
    projectRoot: projectContext.projectRoot,
    sessionCacheDir: projectContext.sessionCacheDir,
  });
  const promptCacheKeyData = buildPromptTokenCacheKeyData({
    selectedModelUuid: options.modelId,
    systemPrompt,
    tokenizerKind: options.selectedModel.tokenizerKind ?? options.tokenizerKind,
    tools,
  });
  const replayEstimateCache = new Map<string, { replayMessageCount: number; tokens: number }>();
  const conversationHistory = [...options.history];
  let compactedContext = options.compactedContext ?? null;
  const selectConversation = () =>
    selectReplayHistoryWithinBudget({
      cachedEstimateByBlockId: replayEstimateCache,
      cacheKeyData: promptCacheKeyData,
      compactedContext,
      currentTurnId: options.turnId,
      history: conversationHistory,
      maxContext: options.selectedModel.maxContext,
      maxOutputTokens: options.selectedModel.maxOutputTokens,
      modelCapabilities: options.modelCapabilities,
      previewFileMap: options.previewFileMap,
      systemPrompt,
      tokenizerKind: options.selectedModel.tokenizerKind ?? options.tokenizerKind,
      tools,
      turnSummaries: options.turnSummaries,
    });

  const rebuildConversation = async () => {
    let selection = selectConversation();

    if (selection.droppedTurnIds.length === 0) {
      return buildConversation({
        compactedContext,
        history: selection.messages,
        modelCapabilities: options.modelCapabilities,
        previewFileMap: options.previewFileMap,
        systemPrompt,
      });
    }

    frontendLogger.info("frontend.agent", "compaction_started", {
      droppedTurnCount: selection.droppedTurnIds.length,
      estimatedTokens: selection.estimatedTokens,
      inputBudget: selection.budget.inputBudget,
      turnIdLength: options.turnId.length,
    });
    await options.onCompactionStarted?.();

    try {
      let compactedThisRebuild = false;

      for (let pass = 0; pass < MAX_COMPACTION_PASSES; pass += 1) {
        if (selection.droppedTurnIds.length === 0) {
          break;
        }

        const blocks = buildReplayBlocks(conversationHistory, options.turnId);
        const batchTurnIds = selectOldestCompactionBatch({
          blocks,
          candidateTurnIds: selection.droppedTurnIds,
          currentTurnId: options.turnId,
          maxContext: options.selectedModel.maxContext,
          maxOutputTokens: options.selectedModel.maxOutputTokens,
          previousContext: compactedContext,
          previewFileMap: options.previewFileMap,
          tokenLimit: selection.budget.compactedContextTokens,
          tokenizerKind: options.selectedModel.tokenizerKind ?? options.tokenizerKind,
        });

        if (batchTurnIds.length === 0) {
          break;
        }

        frontendLogger.info("frontend.agent", "compaction_pass", {
          batchTurnCount: batchTurnIds.length,
          droppedTurnCount: selection.droppedTurnIds.length,
          pass,
          turnIdLength: options.turnId.length,
        });

        const nextCompactedContext = await compactReplayBlocks({
          blocks,
          chatId: options.chatId,
          currentTurnId: options.turnId,
          droppedTurnIds: batchTurnIds,
          model: options.selectedModel,
          previousContext: compactedContext,
          projectId: options.projectId,
          previewFileMap: options.previewFileMap,
          tokenLimit: selection.budget.compactedContextTokens,
        });

        if (!nextCompactedContext) {
          break;
        }

        compactedThisRebuild = true;
        compactedContext = nextCompactedContext;
        await options.onCompactedContext?.(nextCompactedContext);
        selection = selectConversation();

        frontendLogger.info("frontend.agent", "compaction_pass_finished", {
          compactedTurnCount: nextCompactedContext.compactedTurnIds.length,
          remainingDroppedTurnCount: selection.droppedTurnIds.length,
          summaryTokens: nextCompactedContext.tokens,
          turnIdLength: options.turnId.length,
        });
      }

      if (selection.droppedTurnIds.length > 0) {
        frontendLogger.error("frontend.agent", "compaction_incomplete", {
          remainingDroppedTurnCount: selection.droppedTurnIds.length,
          turnIdLength: options.turnId.length,
        });
        await options.onCompactionEnded?.("failed");
        throw new Error(
          "Could not free enough context by compacting older turns. Try a larger-context model or start a new chat.",
        );
      }

      if (compactedThisRebuild) {
        frontendLogger.info("frontend.agent", "compaction_finished", {
          compactedTurnCount: compactedContext?.compactedTurnIds.length ?? 0,
          summaryTokens: compactedContext?.tokens ?? 0,
          turnIdLength: options.turnId.length,
        });
        await options.onCompactionEnded?.("compacted");
      } else {
        await options.onCompactionEnded?.("skipped");
        throw new Error(
          "Could not free enough context by compacting older turns. Try a larger-context model or start a new chat.",
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Could not free enough context")
      ) {
        throw error;
      }
      frontendLogger.error("frontend.agent", "compaction_failed", {
        error,
        turnIdLength: options.turnId.length,
      });
      await options.onCompactionEnded?.("failed");
      throw error;
    }

    return buildConversation({
      compactedContext,
      history: selection.messages,
      modelCapabilities: options.modelCapabilities,
      previewFileMap: options.previewFileMap,
      systemPrompt,
    });
  };
  let conversation = await rebuildConversation();
  let usedToolsInTurn = false;

  for (let step = 0; step < maxAgentSteps; step += 1) {
    conversation = await rebuildConversation();
    frontendLogger.info("frontend.agent", "step_started", {
      conversationCount: conversation.length,
      step,
      toolCount: tools.length,
      turnIdLength: options.turnId.length,
    });
    const assistantMessage = createAssistantMessage(options.turnId);
    options.onAssistantCreated(assistantMessage);

    let streamedTurn;

    try {
      streamedTurn = await streamAgentTurn({
        chatId: options.chatId,
        conversation,
        modelId: options.modelId,
        onChunk: (chunk) =>
          options.onAssistantChunk({
            ...chunk,
            messageId: assistantMessage.id,
          }),
        onReasoningFinished: () => options.onReasoningFinished?.(assistantMessage.id),
        onToolCalls: (toolCalls) => options.onAssistantToolCalls(assistantMessage.id, toolCalls),
        projectId: options.projectId,
        reasoningLevel: options.reasoningLevel,
        tools,
        turnIndex: step,
        toToolCallState: createToolCallState,
      });
    } catch (error) {
      frontendLogger.error("frontend.agent", "step_stream_failed", {
        error,
        messageIdLength: assistantMessage.id.length,
        step,
        turnIdLength: options.turnId.length,
      });
      options.onTurnFinished({ status: "error", turnId: options.turnId });
      throw error;
    }

    const normalizedToolCalls = normalizeStreamedToolCalls(streamedTurn.toolCalls, step);
    options.onAssistantStreamFinished(
      assistantMessage.id,
      normalizedToolCalls.length > 0 ? "working" : "final",
    );
    frontendLogger.info("frontend.agent", "step_stream_finished", {
      contentLength: streamedTurn.content.length,
      reasoningLength: streamedTurn.reasoning.length,
      step,
      toolCallCount: normalizedToolCalls.length,
    });

    if (normalizedToolCalls.length === 0) {
      const hasFinalContent = streamedTurn.content.trim().length > 0;

      if (usedToolsInTurn && !hasFinalContent) {
        frontendLogger.info("frontend.agent", "missing_final_response_after_tool_run", {
          step,
          turnIdLength: options.turnId.length,
        });

        const finalOutcome = await requestForcedFinalResponse({
          chatId: options.chatId,
          conversation,
          forcedFinalKind: "after_tools",
          modelId: options.modelId,
          onAssistantChunk: options.onAssistantChunk,
          onAssistantCreated: options.onAssistantCreated,
          onReasoningFinished: options.onReasoningFinished,
          onAssistantStreamFinished: options.onAssistantStreamFinished,
          projectId: options.projectId,
          prompt: FINAL_RESPONSE_SYSTEM_PROMPT,
          reasoningLevel: options.reasoningLevel,
          step: step + 1,
          turnId: options.turnId,
        });
        frontendLogger.info("frontend.agent", "forced_final_response_finished", {
          contentLength: finalOutcome.content.length,
          outcomeKind: finalOutcome.kind,
          step,
          turnIdLength: options.turnId.length,
          usedFallback: finalOutcome.kind !== "ok",
        });
      }

      frontendLogger.info("frontend.agent", "run_finished_without_tools", {
        step,
        turnIdLength: options.turnId.length,
      });
      // Tools already ran: forced-final failure/empty still settles done (#24/#25).
      options.onTurnFinished({ status: "done", turnId: options.turnId });
      return;
    }

    let toolCallState = normalizedToolCalls.map(createToolCallState);
    usedToolsInTurn = true;
    options.onAssistantToolCalls(assistantMessage.id, toolCallState);
    conversationHistory.push({
      ...assistantMessage,
      assistantPhase: "working",
      completedAtMs: Date.now(),
      content: streamedTurn.content,
      reasoning: "",
      status: "done",
      toolCalls: normalizedToolCalls.map((toolCall) => ({
        id: toolCall.id,
        input: toolCall.function.arguments,
        name: toolCall.function.name,
        status: "pending",
      })),
    });
    conversation = await rebuildConversation();

    for (const toolCall of normalizedToolCalls) {
      frontendLogger.info("frontend.agent", "tool_started", {
        step,
        toolCallIdLength: toolCall.id.length,
        toolInputLength: toolCall.function.arguments.length,
        toolName: toolCall.function.name,
      });
      toolCallState = toolCallState.map((entry) =>
        entry.id === toolCall.id ? { ...entry, status: "running" } : entry,
      );
      const toolStartedAtMs = Date.now();
      const parentPartId = `${assistantMessage.id}-tool-call-${toolCall.id}`;
      options.onAssistantToolCalls(assistantMessage.id, toolCallState);
      await options.onToolMessage(
        createPendingToolMessage({
          parentPartId,
          projectId: options.projectId,
          startedAtMs: toolStartedAtMs,
          toolCall,
          turnId: options.turnId,
        }),
      );

      let toolPayload: ToolExecutionPayload;

      try {
        const approvalRequest = createToolApprovalRequest({
          arguments: toolCall.function.arguments,
          globalSkillsDir: projectContext.globalSkillsDir ?? undefined,
          permissionMode: options.permissionMode,
          projectRoot: projectContext.projectRoot,
          sessionId: options.chatId,
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
        });
        const isApproved =
          !approvalRequest ||
          (await options.requestToolApproval(approvalRequest));

        toolPayload = isApproved
          ? await runAgentTool({
              arguments: toolCall.function.arguments,
              onChunk: (chunk) => options.onToolChunk?.(chunk),
              projectId: options.projectId,
              sessionId: options.chatId,
              toolCallId: toolCall.id,
              toolName: toolCall.function.name,
            })
          : createRejectedToolPayload(approvalRequest);
      } catch (error) {
        if (error instanceof Error && error.message === INTERRUPTED_WORKSPACE_CHAT_ERROR) {
          frontendLogger.info("frontend.agent", "tool_execution_interrupted", {
            step,
            toolCallIdLength: toolCall.id.length,
            toolName: toolCall.function.name,
          });
          toolPayload = {
            error: "User interrupted",
            output: JSON.stringify({
              error: "User interrupted",
              ok: false,
            }),
            status: "interrupted",
          };
        } else {
          const errorMessage = resolveToolExecutionErrorMessage(error);
          frontendLogger.error("frontend.agent", "tool_execution_failed", {
            error,
            errorMessage,
            step,
            toolCallIdLength: toolCall.id.length,
            toolName: toolCall.function.name,
          });
          toolPayload = {
            error: errorMessage,
            output: null,
            status: "error",
          };
        }
      }

      frontendLogger.info("frontend.agent", "tool_finished", {
        outputLength: toolPayload.output?.length ?? 0,
        status: toolPayload.status,
        step,
        toolCallIdLength: toolCall.id.length,
        toolErrorLength: toolPayload.error?.length ?? 0,
        toolName: toolCall.function.name,
      });

      await options.onToolMessage(
        createToolMessage({
          parentPartId,
          payload: toolPayload,
          projectId: options.projectId,
          startedAtMs: toolStartedAtMs,
          toolCall,
          turnId: options.turnId,
        }),
      );
      toolCallState = toolCallState.map((entry) =>
        entry.id === toolCall.id
          ? {
              ...entry,
              status: toolPayload.status,
            }
          : entry,
      );
      options.onAssistantToolCalls(assistantMessage.id, toolCallState);
      conversationHistory.push(
        createToolMessage({
          parentPartId,
          payload: toolPayload,
          projectId: options.projectId,
          startedAtMs: toolStartedAtMs,
          toolCall,
          turnId: options.turnId,
        }),
      );
      conversation = await rebuildConversation();

      if (toolPayload.status === "interrupted") {
        options.onTurnFinished({ status: "interrupted", turnId: options.turnId });
        throw new Error(INTERRUPTED_WORKSPACE_CHAT_ERROR);
      }
    }
  }

  frontendLogger.error("frontend.agent", "run_exceeded_max_steps", {
    maxSteps: maxAgentSteps,
    turnIdLength: options.turnId.length,
  });

  if (usedToolsInTurn) {
    const finalOutcome = await requestForcedFinalResponse({
      chatId: options.chatId,
      conversation,
      forcedFinalKind: "max_steps",
      modelId: options.modelId,
      onAssistantChunk: options.onAssistantChunk,
      onAssistantCreated: options.onAssistantCreated,
      onReasoningFinished: options.onReasoningFinished,
      onAssistantStreamFinished: options.onAssistantStreamFinished,
      projectId: options.projectId,
      prompt: FINAL_RESPONSE_AFTER_LIMIT_SYSTEM_PROMPT,
      reasoningLevel: options.reasoningLevel,
      step: maxAgentSteps,
      turnId: options.turnId,
    });

    frontendLogger.info("frontend.agent", "forced_final_response_after_limit_finished", {
      contentLength: finalOutcome.content.length,
      outcomeKind: finalOutcome.kind,
      turnIdLength: options.turnId.length,
      usedFallback: finalOutcome.kind !== "ok",
    });

    // Max steps after tools: always done. Empty/failed final uses fallback text (#25/#60).
    options.onTurnFinished({ status: "done", turnId: options.turnId });
    return;
  }

  options.onTurnFinished({ status: "error", turnId: options.turnId });
  throw new Error(
    "The agent reached the maximum number of tool steps for this turn before producing a final response.",
  );
}
