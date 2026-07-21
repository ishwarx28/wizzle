import { frontendLogger } from "./logger";
import { buildWorkspaceSystemPrompt } from "./agent-prompt";
import {
  detectOperatingSystem,
  type RuntimeOperatingSystem,
} from "./runtime-environment";
import { clientEnv } from "./env";
import {
  loadAgentProjectContext,
  runAgentTool,
  type AgentToolOutputChunk,
} from "./agent-runtime";
import {
  resolveAgentTools,
  resolveToolDefinitionsMetadata,
} from "./agent/tool-definitions";
import {
  createAssistantMessage,
  createPendingToolMessage,
  createSubagentResponseMessage,
  createToolCallState,
  createToolMessage,
  type ToolExecutionPayload,
} from "./agent/message-factories";
import {
  SUBAGENT_NAMES,
  withoutSubagentOutput,
  workspaceSubagentManager,
  type SubagentName,
  type StartSubagentRun,
} from "./agent/subagent-manager";
import { getRemotePrompt } from "./remote-config";
import { shouldDeferFinalForSubagentResponse } from "./agent/subagent-finalization";
import { buildSubagentTaskPrompt } from "./agent/subagent-prompt";
import {
  buildSubagentCoordinationMessage,
} from "./agent/subagent-coordination";
import {
  resolveForcedFinalDisplayContent,
  type ForcedFinalKind,
  type ForcedFinalOutcome,
} from "./agent/forced-final";
import {
  buildEmergencyFinalizationRequest,
  resolveEmergencyReasoningSelection,
  shouldAcceptBufferedMaxStepFinal,
} from "./agent/emergency-finalization";
import {
  containsRawToolSyntax,
  persistPendingImplementationPlanForContextContinuation,
  shouldEnterContextPressure,
  resolveContextPressureSystemPrompt,
  type WorkspaceAgentRunResult,
} from "./agent/context-pressure";
import {
  buildCompactionFailureUserMessage,
  CompactionFailureError,
  isCompactionFailureError,
  resolveCompactionFailureAction,
  toCompactionFailureError,
} from "./agent/compaction-failure";
import {
  createRejectedToolPayload,
  createToolApprovalBatchRequest,
  createToolApprovalRequest,
} from "./tool-approval";
import { resolvePostStreamAssistantAction } from "./agent/assistant-stream-finish";
import { findIncompleteToolCallIds } from "./agent/tool-batch";
import { normalizeStreamedToolCalls, streamAgentTurn } from "./agent/stream-turn";
import { runClarifyTool } from "./agent/clarify-tool";
import { createImplementationPlanEngine } from "./agent/implementation-plan/engine";
import { runImplementationPlanTool } from "./agent/implementation-plan/tool";
import {
  loadImplementationPlanState,
  publishImplementationPlanState,
  saveImplementationPlanState,
} from "./agent/implementation-plan/storage";
import {
  compactReplayBlocks,
  selectOldestCompactionBatch,
} from "./agent/compaction";
import {
  buildChatMessages,
  INTERRUPTED_WORKSPACE_CHAT_ERROR,
  interruptWorkspaceChat,
  isInterruptedWorkspaceChatError,
  type ChatRequestMessage,
} from "./chat-stream";
import { getMessageContent } from "./message-parts";
import { listAgentProcesses, stopAgentProcess } from "./local-workspace";
import {
  buildCompactedContextMessage,
  buildReplayBlocks,
  buildPromptTokenCacheKeyData,
  type ContextBudgetSnapshot,
  estimateChatMessageTokens,
  estimateToolDefinitionTokens,
  isReplayBudgetError,
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
  ProviderRetryStatus,
  ToolCall,
  ToolApprovalRequest,
  WorkflowQuestionAnswer,
  WorkflowQuestionRequest,
} from "../types/workspace";
import { formatExactMessageTimestamp } from "../utils/time";
import {
  attachReasoningReplaySource,
  normalizeReasoningSelection,
} from "./reasoning-config";

const MAX_ALLOWED_AGENT_STEPS = 100;
const DEFAULT_AGENT_STEPS = 100;
function subagentSystemPrompt(name: SubagentName) {
  return getRemotePrompt(name);
}
const BACKGROUND_SUBAGENT_GUIDANCE =
  "The delegated task is running. Do not duplicate it. Do other clearly separate work if available; otherwise wait. Prefer minute-scale waits because completion wakes you immediately. A timeout is normal, not failure: wait again unless the task is no longer needed. Never interrupt merely because it is taking time.";
const SUBAGENT_WAIT_DURATIONS = {
  "10m": 600_000,
  "1m": 60_000,
  "2m": 120_000,
  "30s": 30_000,
  "5m": 300_000,
} as const;
type SubagentWaitDuration = keyof typeof SUBAGENT_WAIT_DURATIONS;

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
  additionalMessages?: ChatRequestMessage[];
  compactedContext?: CompactedContextRecord | null;
  currentTurnId?: string;
  history: Message[];
  modelCapabilities: ModelCapability[];
  modelId: ModelId;
  modelReasoning?: ProviderModelInfo["reasoning"];
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
    ...buildChatMessages(options.history, options.previewFileMap, options.modelCapabilities, {
      currentTurnId: options.currentTurnId,
      modelId: options.modelId,
      reasoning: options.modelReasoning,
    }),
    ...(options.additionalMessages ?? []),
  ] satisfies ChatRequestMessage[];
}

function buildSystemPrompt(options: {
  currentYear: number;
  gitTrackedState: Awaited<ReturnType<typeof loadAgentProjectContext>>["gitTrackedState"];
  globalSkillFiles: Awaited<ReturnType<typeof loadAgentProjectContext>>["globalSkillFiles"];
  globalSkillsDir: Awaited<ReturnType<typeof loadAgentProjectContext>>["globalSkillsDir"];
  imageCapable?: boolean;
  instructionFiles: Awaited<ReturnType<typeof loadAgentProjectContext>>["instructionFiles"];
  operatingSystem: RuntimeOperatingSystem;
  platform: string;
  projectRoot: string;
  sessionCacheDir: Awaited<ReturnType<typeof loadAgentProjectContext>>["sessionCacheDir"];
}) {
  return buildWorkspaceSystemPrompt({
    currentYear: options.currentYear,
    gitTrackedState: options.gitTrackedState,
    globalSkillFiles: options.globalSkillFiles,
    globalSkillsDir: options.globalSkillsDir,
    imageCapable: options.imageCapable,
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
  return detectOperatingSystem(
    typeof navigator !== "undefined" ? navigator.userAgent : "",
    typeof navigator !== "undefined" ? navigator.platform : "",
  );
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
  maxTokens?: number;
  modelId: ModelId;
  modelReasoning?: ProviderModelInfo["reasoning"];
  onAssistantChunk: (payload: {
    kind: "content" | "reasoning";
    messageId: string;
    text: string;
  }) => void;
  onAssistantCreated: (message: Message) => void;
  onAssistantReasoningReplay?: RunWorkspaceAgentOptions["onAssistantReasoningReplay"];
  onReasoningFinished?: (messageId: string) => void;
  onProviderRetry?: (status: ProviderRetryStatus | null) => void;
  onAssistantStreamFinished: (messageId: string, phase: AssistantPhase) => void;
  projectId: string;
  reasoningLevel?: string | null;
  reasoningSelection?: ReturnType<typeof normalizeReasoningSelection>;
  semanticRetryConversation?: ChatRequestMessage[];
  step: number;
  streamKey?: string;
  turnId: string;
}): Promise<ForcedFinalOutcome> {
  const finalAssistantMessage = createAssistantMessage(options.turnId);
  options.onAssistantCreated(finalAssistantMessage);

  let finalReasoningReplay: Awaited<ReturnType<typeof streamAgentTurn>>["reasoningReplay"] = [];
  let streamedContent = "";
  let streamError: unknown;
  const attempts = [options.conversation, options.semanticRetryConversation].filter(
    (conversation): conversation is ChatRequestMessage[] => Boolean(conversation),
  );

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    let attemptContent = "";
    try {
      const finalTurn = await streamAgentTurn({
        chatId: options.chatId,
        conversation: attempts[attempt]!,
        maxTokens: options.maxTokens,
        modelId: options.modelId,
        onChunk: (chunk) => {
          if (chunk.kind === "content") {
            attemptContent += chunk.text;
          }
        },
        onReasoningFinished: () => options.onReasoningFinished?.(finalAssistantMessage.id),
        onProviderRetry: options.onProviderRetry,
        projectId: options.projectId,
        reasoningLevel: options.reasoningLevel,
        reasoningSelection: options.reasoningSelection,
        streamKey: options.streamKey,
        toolChoice: "none",
        tools: [],
        turnIndex: options.step + attempt,
        toToolCallState: createToolCallState,
      });
      attemptContent = finalTurn.content || attemptContent;
      if (finalTurn.toolCalls.length > 0 || containsRawToolSyntax(attemptContent)) {
        streamError = new Error(
          "The model returned tool syntax instead of a user-facing final response.",
        );
        attemptContent = "";
      } else if (attemptContent.trim()) {
        streamedContent = attemptContent;
        finalReasoningReplay = finalTurn.reasoningReplay;
        streamError = undefined;
        break;
      } else {
        streamError = undefined;
      }

      if (attempt + 1 < attempts.length) {
        frontendLogger.info("frontend.agent", "forced_final_semantic_retry", {
          attempt: attempt + 2,
          forcedFinalKind: options.forcedFinalKind,
          reason: streamError ? "tool_syntax" : "empty",
          turnIdLength: options.turnId.length,
        });
        continue;
      }
    } catch (error) {
      if (isInterruptedWorkspaceChatError(error)) {
        frontendLogger.info("frontend.agent", "forced_final_response_interrupted", {
          forcedFinalKind: options.forcedFinalKind,
          turnIdLength: options.turnId.length,
        });
        throw error;
      }
      streamedContent = attemptContent;
      streamError = error;
    }

    if (streamError) {
      frontendLogger.error("frontend.agent", "forced_final_response_failed", {
        error: streamError,
        forcedFinalKind: options.forcedFinalKind,
        turnIdLength: options.turnId.length,
      });
    }
    break;
  }

  if (finalReasoningReplay.length > 0) {
    const reasoningReplay = attachReasoningReplaySource({
      entries: finalReasoningReplay,
      modelId: options.modelId,
      reasoning: options.modelReasoning,
    });
    finalAssistantMessage.reasoningReplay = reasoningReplay;
    options.onAssistantReasoningReplay?.(
      finalAssistantMessage.id,
      reasoningReplay,
    );
  }

  if (containsRawToolSyntax(streamedContent)) {
    streamedContent = "";
    streamError = new Error(
      "The model returned tool syntax instead of a user-facing final response.",
    );
  }

  const outcome = resolveForcedFinalDisplayContent({
    error: streamError,
    kind: options.forcedFinalKind,
    streamedContent,
  });

  // Forced finals are buffered until validated so raw provider tool syntax is never persisted.
  if (outcome.content.trim()) {
    options.onAssistantChunk({
      kind: "content",
      messageId: finalAssistantMessage.id,
      text: outcome.content,
    });
  }

  options.onAssistantStreamFinished(finalAssistantMessage.id, "final");
  return outcome;
}

export type RunWorkspaceAgentOptions = {
  /** Hidden child runs disable the subagent tool to prevent recursive delegation. */
  allowSubagents?: boolean;
  /** Reviewer runs may delegate only to the Explorer role. */
  allowedSubagentNames?: SubagentName[];
  cancelToolApproval?: (toolCallId: string) => void;
  chatId: string;
  history: Message[];
  modelId: ModelId;
  onAssistantChunk: (payload: {
    kind: "content" | "reasoning";
    messageId: string;
    text: string;
  }) => void;
  onAssistantCreated: (message: Message) => void;
  onAssistantReasoningReplay?: (
    messageId: string,
    replay: NonNullable<Message["reasoningReplay"]>,
  ) => void;
  onReasoningFinished?: (messageId: string) => void;
  onAssistantStreamFinished: (messageId: string, phase: AssistantPhase) => void;
  onAssistantToolCalls: (messageId: string, toolCalls: ToolCall[]) => void;
  onCompactionStarted?: () => Promise<void> | void;
  onCompactedContext?: (context: CompactedContextRecord) => Promise<void> | void;
  onContextBudget?: (snapshot: ContextBudgetSnapshot) => void;
  /** Called when compaction exits without a new summary (or after failure cleanup). */
  onCompactionEnded?: (result: "compacted" | "skipped" | "failed") => Promise<void> | void;
  onProviderRetry?: (status: ProviderRetryStatus | null) => void;
  onToolMessage: (message: Message) => Promise<void> | void;
  onToolChunk?: (chunk: AgentToolOutputChunk) => void;
  /** Persist prompt cache hashes once the real system prompt is built (#77). */
  onSessionPromptMetadata?: (metadata: {
    systemPromptHash: string;
    systemPromptTokens: number;
    toolDefTokens: number;
    toolDefsHash: string;
  }) => Promise<void> | void;
  onTurnFinished: (payload: {
    finishReason?: WorkspaceAgentRunResult["finishReason"];
    status: "done" | "error" | "interrupted";
    turnId: string;
  }) => void;
  compactedContext?: CompactedContextRecord | null;
  /** Internal exceptional continuation compacts completed history before streaming. */
  forceCompaction?: boolean;
  maxContextTokens?: number;
  modelCapabilities: ModelCapability[];
  permissionMode: PermissionMode;
  previewFileMap: Map<string, PreviewFile>;
  projectId: string;
  reasoningLevel?: string | null;
  /** Visible parent turn used for lifecycle ownership across nested Reviewer delegation. */
  rootTurnId?: string;
  requestToolApproval: (request: ToolApprovalRequest) => Promise<boolean>;
  requestWorkflowQuestions: (request: WorkflowQuestionRequest) => Promise<WorkflowQuestionAnswer>;
  selectedModel: ProviderModelInfo;
  /** Frontend-only key used to target a hidden subagent provider stream. */
  streamKey?: string;
  systemPromptAddendum?: string;
  /** Hidden task that owns this run; used to isolate nested responses and tools. */
  subagentTaskId?: string;
  subagentRole?: SubagentName;
  turnSummaries?: PersistedTurnSummaryRecord[];
  turnId: string;
};

function createSubagentUserMessage(prompt: string, turnId: string): Message {
  const createdAtMs = Date.now();

  return {
    content: prompt,
    createdAtLabel: formatExactMessageTimestamp(createdAtMs),
    createdAtMs,
    id: `message-subagent-user-${crypto.randomUUID()}`,
    role: "user",
    status: "done",
    turnId,
  };
}

function createSubagentRunStarter(parent: RunWorkspaceAgentOptions): StartSubagentRun {
  return ({ history, name, onUpdate, prompt, taskId }) => {
    const turnId = `turn-${crypto.randomUUID()}`;
    const parentRequest = [...parent.history]
      .reverse()
      .find((message) => message.role === "user");
    const requestText = parentRequest
      ? getMessageContent(parentRequest).trim() || parentRequest.content.trim()
      : "";
    const taskPrompt = buildSubagentTaskPrompt({
      isContinuation: history.length > 0,
      parentRequest: requestText,
      task: prompt,
    });
    const transcript = [
      ...history,
      createSubagentUserMessage(taskPrompt, turnId),
    ];
    const streamKey = `${parent.chatId}:${taskId}`;
    const pendingApprovalIds = new Set<string>();

    const upsertTranscriptMessage = (message: Message) => {
      const index = transcript.findIndex((entry) => entry.id === message.id);

      if (index >= 0) {
        transcript[index] = message;
      } else {
        transcript.push(message);
      }
      onUpdate(transcript);
    };

    onUpdate(transcript);

    const promise = runWorkspaceAgentInternal({
      ...parent,
      allowSubagents: name === "reviewer",
      allowedSubagentNames: name === "reviewer" ? ["explorer"] : [],
      compactedContext: null,
      history: transcript,
      // Child quality must match its parent even if parent option defaults change later.
      modelId: parent.modelId,
      onAssistantChunk: ({ kind, messageId, text }) => {
        const message = transcript.find((entry) => entry.id === messageId);

        if (!message) {
          return;
        }

        if (kind === "content") {
          message.content += text;
        } else {
          message.reasoning = `${message.reasoning ?? ""}${text}`;
        }
        onUpdate(transcript);
      },
      onAssistantCreated: (message) => upsertTranscriptMessage(message),
      onAssistantReasoningReplay: (messageId, reasoningReplay) => {
        const message = transcript.find((entry) => entry.id === messageId);
        if (message) {
          message.reasoningReplay = reasoningReplay;
          onUpdate(transcript);
        }
      },
      onAssistantStreamFinished: (messageId, phase) => {
        const message = transcript.find((entry) => entry.id === messageId);

        if (message) {
          message.assistantPhase = phase;
          message.completedAtMs = Date.now();
          message.status = "done";
          onUpdate(transcript);
        }
      },
      onAssistantToolCalls: (messageId, toolCalls) => {
        const message = transcript.find((entry) => entry.id === messageId);

        if (message) {
          message.toolCalls = toolCalls;
          onUpdate(transcript);
        }
      },
      onCompactedContext: undefined,
      onCompactionEnded: undefined,
      onCompactionStarted: undefined,
      onContextBudget: undefined,
      onReasoningFinished: undefined,
      onSessionPromptMetadata: undefined,
      onToolChunk: undefined,
      onToolMessage: (message) => upsertTranscriptMessage(message),
      onTurnFinished: () => undefined,
      requestToolApproval: async (request) => {
        pendingApprovalIds.add(request.toolCallId);
        workspaceSubagentManager.setWaitingForPermission(parent.chatId, taskId, true);
        try {
          return await parent.requestToolApproval({
            ...request,
            subagentName: name,
            subagentTask:
              workspaceSubagentManager.list(parent.chatId).find(
                (task) => task.taskId === taskId,
              )?.task ?? prompt,
            subagentTaskId: taskId,
          });
        } finally {
          pendingApprovalIds.delete(request.toolCallId);
          workspaceSubagentManager.setWaitingForPermission(parent.chatId, taskId, false);
        }
      },
      requestWorkflowQuestions: parent.requestWorkflowQuestions,
      reasoningLevel: parent.reasoningLevel,
      selectedModel: parent.selectedModel,
      streamKey,
      subagentTaskId: taskId,
      subagentRole: name,
      systemPromptAddendum: subagentSystemPrompt(name),
      rootTurnId: parent.rootTurnId ?? parent.turnId,
      turnId,
      turnSummaries: [],
    }).then(() => {
      const output = [...transcript]
        .reverse()
        .filter((message) => message.role === "assistant")
        .map((message) => getMessageContent(message).trim() || message.content.trim())
        .find(Boolean);

      return {
        history: transcript,
        output: output || "The subagent completed without returning findings.",
      };
    });

    return {
      interrupt: async () => {
        const interruptedAtMs = Date.now();
        for (const message of transcript) {
          if (message.status === "streaming") {
            message.status = "interrupted";
            message.completedAtMs = interruptedAtMs;
          }
          message.parts = message.parts?.map((part) =>
            ["pending", "running", "streaming"].includes(part.status ?? "")
              ? { ...part, status: "interrupted" }
              : part,
          );
          message.toolCalls = message.toolCalls?.map((call) =>
            ["pending", "running", "streaming"].includes(call.status ?? "")
              ? { ...call, status: "interrupted" }
              : call,
          );
        }
        onUpdate(transcript);
        for (const toolCallId of pendingApprovalIds) {
          parent.cancelToolApproval?.(toolCallId);
        }
        const cancelStream = interruptWorkspaceChat({
          interruptSessionRun: false,
          sessionId: streamKey,
        });
        const stopProcesses = listAgentProcesses(parent.chatId)
          .then((processes) =>
            Promise.all(
              processes
                .filter(
                  (process) =>
                    process.turnId === turnId &&
                    (process.status === "pending" || process.status === "running"),
                )
                .map((process) => stopAgentProcess(parent.chatId, process.id)),
            ),
          )
          .catch(() => undefined);
        await Promise.all([cancelStream, stopProcesses]);
      },
      promise,
    };
  };
}

function parseSubagentArguments(argumentsJson: string) {
  const parsed = JSON.parse(argumentsJson) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Subagent arguments must be a JSON object.");
  }

  return parsed as Record<string, unknown>;
}

function requireSubagentString(
  input: Record<string, unknown>,
  field: "action" | "prompt" | "taskId",
) {
  const value = input[field];

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Subagent ${field} is required.`);
  }

  return value.trim();
}

function requireSubagentName(input: Record<string, unknown>) {
  const name = input.name;

  if (typeof name !== "string" || !SUBAGENT_NAMES.includes(name as SubagentName)) {
    throw new Error("Subagent name is required and must be reviewer, explorer, or worker.");
  }

  return name as SubagentName;
}

function subagentToolPayload(value: Record<string, unknown>): ToolExecutionPayload {
  return {
    output: JSON.stringify({ ok: true, ...value }),
    status: "done",
  };
}

async function runSubagentTool(options: {
  allowedNames?: SubagentName[];
  argumentsJson: string;
  ownerTurnId: string;
  recipientTaskId: string | null;
  responseTurnId: string;
  sessionId: string;
  start: StartSubagentRun;
}): Promise<ToolExecutionPayload> {
  try {
    const input = parseSubagentArguments(options.argumentsJson);
    const action = requireSubagentString(input, "action");

    switch (action) {
      case "create": {
        const name = requireSubagentName(input);
        if (options.allowedNames && !options.allowedNames.includes(name)) {
          throw new Error(`This agent may create only these subagent roles: ${options.allowedNames.join(", ")}.`);
        }
        const prompt = requireSubagentString(input, "prompt");
        const join = input.join;
        if (join !== "required" && join !== "optional") {
          throw new Error("Subagent join must be required or optional.");
        }
        const task = workspaceSubagentManager.create({
          join,
          name,
          ownerTurnId: options.ownerTurnId,
          prompt,
          recipientTaskId: options.recipientTaskId,
          responseTurnId: options.responseTurnId,
          sessionId: options.sessionId,
          start: options.start,
        });
        return subagentToolPayload({ action, guidance: BACKGROUND_SUBAGENT_GUIDANCE, ...task });
      }
      case "send_message": {
        const prompt = requireSubagentString(input, "prompt");
        const taskId = requireSubagentString(input, "taskId");
        if (
          options.recipientTaskId &&
          !workspaceSubagentManager
            .listForOwner(options.sessionId, options.recipientTaskId)
            .some((task) => task.taskId === taskId)
        ) {
          throw new Error("A subagent may manage only subagents it created.");
        }
        const task = workspaceSubagentManager.sendMessage({
          ownerTurnId: options.ownerTurnId,
          prompt,
          recipientTaskId: options.recipientTaskId,
          responseTurnId: options.responseTurnId,
          sessionId: options.sessionId,
          start: options.start,
          taskId,
        });
        return subagentToolPayload({ action, guidance: BACKGROUND_SUBAGENT_GUIDANCE, ...task });
      }
      case "interrupt": {
        const taskId = requireSubagentString(input, "taskId");
        if (
          options.recipientTaskId &&
          !workspaceSubagentManager
            .listForOwner(options.sessionId, options.recipientTaskId)
            .some((task) => task.taskId === taskId)
        ) {
          throw new Error("A subagent may manage only subagents it created.");
        }
        const task = await workspaceSubagentManager.interrupt(options.sessionId, taskId);
        return subagentToolPayload({ action, ...task });
      }
      case "list":
        return subagentToolPayload({
          action,
          guidance:
            "Use list only to recover task IDs or answer an explicit status request. Do not poll. Do not duplicate an active task; do separate work or wait.",
          tasks: (options.recipientTaskId
            ? workspaceSubagentManager.listForOwner(
                options.sessionId,
                options.recipientTaskId,
              )
            : workspaceSubagentManager.list(options.sessionId)
          ).map(withoutSubagentOutput),
        });
      case "wait": {
        const taskId = requireSubagentString(input, "taskId");
        if (
          options.recipientTaskId &&
          !workspaceSubagentManager
            .listForOwner(options.sessionId, options.recipientTaskId)
            .some((task) => task.taskId === taskId)
        ) {
          throw new Error("A subagent may manage only subagents it created.");
        }
        const timeout =
          typeof input.timeoutMs === "string" && input.timeoutMs in SUBAGENT_WAIT_DURATIONS
            ? (input.timeoutMs as SubagentWaitDuration)
            : "5m";
        const timeoutMs = SUBAGENT_WAIT_DURATIONS[timeout];
        const result = await workspaceSubagentManager.wait(
          options.sessionId,
          taskId,
          timeoutMs,
        );
        return subagentToolPayload({
          action,
          task: withoutSubagentOutput(result.snapshot),
          timeoutMs: timeout,
          timedOut: result.timedOut,
          guidance: result.timedOut
            ? "The task is still working. This is normal. Do not poll, request status, interrupt, or duplicate it. Do separate work if available; otherwise call wait again, preferably with a minute-scale duration."
            : "The task completed before the wait window ended. Its response is injected separately after this result. Integrate it and do not repeat the task.",
        });
      }
      default:
        throw new Error(
          `Unsupported subagent action "${action}". Expected create, send_message, interrupt, list, or wait.`,
        );
    }
  } catch (error) {
    const message = resolveToolExecutionErrorMessage(error);
    return {
      error: message,
      output: JSON.stringify({ error: message, ok: false }),
      status: "error",
    };
  }
}

async function runWorkspaceAgentInternal(
  options: RunWorkspaceAgentOptions,
): Promise<WorkspaceAgentRunResult> {
  const maxAgentSteps = resolveMaxAgentSteps();
  const reasoningSelection = normalizeReasoningSelection(
    options.reasoningLevel,
    options.selectedModel.reasoning,
  );

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
  const imageCapable = options.modelCapabilities.includes("image");
  const allowSubagents = options.allowSubagents !== false;
  const permittedToolNames = options.subagentRole
    ? new Set(
        options.subagentRole === "reviewer"
          ? ["shell", "read", "subagent"]
          : options.subagentRole === "worker"
            ? ["shell", "edit", "read", "write"]
            : ["shell", "read"],
      )
    : null;
  const tools = resolveAgentTools({
    imageCapable,
    includeSubagent: allowSubagents,
    modelCapabilities: options.modelCapabilities,
  }).filter((tool) => !permittedToolNames || permittedToolNames.has(tool.function.name));
  let restoredImplementationPlanState = null;
  if (!options.subagentRole) {
    try {
      restoredImplementationPlanState = await loadImplementationPlanState(options.chatId);
      publishImplementationPlanState(options.chatId, restoredImplementationPlanState);
    } catch (error) {
      frontendLogger.error("frontend.agent", "implementation_plan_state_load_failed", {
        error,
        sessionIdLength: options.chatId.length,
      });
    }
  }
  const implementationPlanPath = projectContext.sessionCacheDir
    ? `${projectContext.sessionCacheDir.replace(/[\\/]+$/, "")}/implementation-plan.md`
    : "implementation-plan.md";
  const implementationPlanEngine = createImplementationPlanEngine(
    restoredImplementationPlanState,
    implementationPlanPath,
  );
  const restoredImplementationPlanInstruction =
    implementationPlanEngine.getContinuationInstruction();
  const baseSystemPrompt = buildSystemPrompt({
    currentYear: new Date().getFullYear(),
    gitTrackedState: projectContext.gitTrackedState,
    globalSkillFiles: projectContext.globalSkillFiles,
    globalSkillsDir: projectContext.globalSkillsDir,
    imageCapable,
    instructionFiles: projectContext.instructionFiles,
    operatingSystem: resolveRuntimeOperatingSystem(),
    platform: resolveRuntimePlatform(),
    projectRoot: projectContext.projectRoot,
    sessionCacheDir: projectContext.sessionCacheDir,
  });
  const systemPrompt = [
    baseSystemPrompt,
    options.systemPromptAddendum,
    restoredImplementationPlanInstruction,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
  const promptCacheKeyData = buildPromptTokenCacheKeyData({
    selectedModelUuid: options.modelId,
    systemPrompt,
    tools,
  });
  // Session SQL already stores tooldefs-v* hash; also write system_prompt_hash (#77).
  const toolDefinitionsMetadata = resolveToolDefinitionsMetadata();
  await options.onSessionPromptMetadata?.({
    systemPromptHash: promptCacheKeyData.systemPromptHash,
    systemPromptTokens: estimateChatMessageTokens(
      { content: systemPrompt, role: "system" },
    ),
    toolDefTokens: estimateToolDefinitionTokens(tools),
    toolDefsHash: toolDefinitionsMetadata.hash,
  });
  const replayEstimateCache = new Map<string, { replayMessageCount: number; tokens: number }>();
  const conversationHistory = [...options.history];
  const persistImplementationPlanProgress = async () => {
    if (options.subagentRole) {
      return false;
    }
    const snapshot = implementationPlanEngine.getSnapshot();
    if (!snapshot) return false;
    try {
      return await saveImplementationPlanState(options.chatId, snapshot);
    } catch (error) {
      frontendLogger.error("frontend.agent", "implementation_plan_state_save_failed", {
        error,
        sessionIdLength: options.chatId.length,
      });
      return false;
    }
  };
  let approvalQueue = Promise.resolve<unknown>(undefined);
  const cancelledApprovalIds = new Set<string>();
  const requestToolApproval: RunWorkspaceAgentOptions["requestToolApproval"] = (request) => {
    const result = approvalQueue.then(() => {
      if (cancelledApprovalIds.delete(request.toolCallId)) {
        throw new Error(INTERRUPTED_WORKSPACE_CHAT_ERROR);
      }

      return options.requestToolApproval(request);
    });
    approvalQueue = result.catch(() => undefined);
    return result;
  };
  const cancelToolApproval = (toolCallId: string) => {
    cancelledApprovalIds.add(toolCallId);
    options.cancelToolApproval?.(toolCallId);
  };
  const startSubagent = allowSubagents
    ? createSubagentRunStarter({ ...options, cancelToolApproval, requestToolApproval })
    : null;
  const responseRecipientTaskId = options.subagentTaskId ?? null;
  const activeTasksForRun = () =>
    options.subagentTaskId
      ? workspaceSubagentManager.listActiveForOwner(options.chatId, options.subagentTaskId)
      : workspaceSubagentManager.listActiveForTurn(
          options.chatId,
          options.rootTurnId ?? options.turnId,
        );
  const hasUnsettledSubagentsForRun = () => {
    const hasActive = activeTasksForRun().length > 0;
    return (
      hasActive ||
      workspaceSubagentManager.hasResponses(
        options.chatId,
        responseRecipientTaskId,
      )
    );
  };
  const settleSubagentsForFinal = async () => {
    const optionalTasks = activeTasksForRun().filter((task) => task.join === "optional");
    await Promise.all(
      optionalTasks.map((task) =>
        workspaceSubagentManager.interrupt(options.chatId, task.taskId),
      ),
    );

    while (true) {
      const requiredTasks = activeTasksForRun().filter((task) => task.join === "required");
      if (requiredTasks.length === 0) {
        return;
      }
      await Promise.all(
        requiredTasks.map((task) =>
          workspaceSubagentManager.wait(options.chatId, task.taskId, 600_000),
        ),
      );
    }
  };
  const injectCompletedSubagentResponses = async () => {
    if (!allowSubagents) {
      return 0;
    }

    const responses = workspaceSubagentManager.drainResponses(
      options.chatId,
      responseRecipientTaskId,
    );
    for (const response of responses) {
      const message = createSubagentResponseMessage(response, options.turnId);
      conversationHistory.push(message);
      await options.onToolMessage(message);
      frontendLogger.info("frontend.agent", "subagent_response_injected", {
        outputLength: response.output.length,
        status: response.status,
        taskIdLength: response.taskId.length,
        turnIdLength: options.turnId.length,
      });
    }
    return responses.length;
  };
  let compactedContext = options.compactedContext ?? null;
  type ConversationSelectOptions = {
    additionalMessages?: ChatRequestMessage[];
    history?: Message[];
    systemPrompt?: string;
    tools?: typeof tools;
  };

  const selectConversation = (selectOptions?: ConversationSelectOptions) => {
    const selection = selectReplayHistoryWithinBudget({
      additionalMessages: selectOptions?.additionalMessages,
      cachedEstimateByBlockId: replayEstimateCache,
      cacheKeyData: promptCacheKeyData,
      compactedContext,
      currentTurnId: options.turnId,
      forceCompaction: options.forceCompaction,
      history: selectOptions?.history ?? conversationHistory,
      maxContext: options.selectedModel.maxContext,
      maxOutputTokens: options.selectedModel.maxOutputTokens,
      modelCapabilities: options.modelCapabilities,
      modelReasoning: options.selectedModel.reasoning,
      previewFileMap: options.previewFileMap,
      selectedModelUuid: options.modelId,
      systemPrompt: selectOptions?.systemPrompt ?? systemPrompt,
      tools: selectOptions?.tools ?? tools,
      turnSummaries: options.turnSummaries,
    });
    options.onContextBudget?.(selection.snapshot);
    return selection;
  };

  const compactDroppedTurns = async (
    selection: ReturnType<typeof selectConversation>,
    historyForBlocks: Message[],
    selectOptions?: ConversationSelectOptions,
  ) => {
    if (selection.droppedTurnIds.length === 0) {
      return selection;
    }

    frontendLogger.info("frontend.agent", "compaction_started", {
      droppedTurnCount: selection.droppedTurnIds.length,
      estimatedTokens: selection.snapshot.preCompactionTokens,
      inputBudget: selection.budget.inputBudget,
      requestEstimatedTokens: selection.requestEstimatedTokens,
      turnIdLength: options.turnId.length,
    });
    await options.onCompactionStarted?.();

    let compactionEnded = false;
    const endCompaction = async (result: "compacted" | "skipped" | "failed") => {
      if (compactionEnded) {
        return;
      }
      compactionEnded = true;
      await options.onCompactionEnded?.(result);
    };

    try {
      const pendingTurnIds = new Set(selection.droppedTurnIds);
      const reselect = () =>
        selectConversation({
          ...selectOptions,
          history: historyForBlocks,
        });

      for (let pass = 0; pendingTurnIds.size > 0; pass += 1) {
        const blocks = buildReplayBlocks(historyForBlocks, options.turnId);
        const batchTurnIds = selectOldestCompactionBatch({
          blocks,
          candidateTurnIds: [...pendingTurnIds],
          currentTurnId: options.turnId,
          maxContext: options.selectedModel.maxContext,
          maxOutputTokens: options.selectedModel.maxOutputTokens,
          previousContext: compactedContext,
          previewFileMap: options.previewFileMap,
          tokenLimit: selection.budget.compactedContextTokens,
        });

        if (batchTurnIds.length === 0) {
          break;
        }

        frontendLogger.info("frontend.agent", "compaction_pass", {
          batchTurnCount: batchTurnIds.length,
          droppedTurnCount: pendingTurnIds.size,
          pass,
          turnIdLength: options.turnId.length,
        });

        const nextCompactedContext = await compactReplayBlocks({
          blocks,
          chatId: options.chatId,
          currentTurnId: options.turnId,
          droppedTurnIds: batchTurnIds,
          model: options.selectedModel,
          onProviderRetry: options.onProviderRetry,
          previousContext: compactedContext,
          projectId: options.projectId,
          previewFileMap: options.previewFileMap,
          tokenLimit: selection.budget.compactedContextTokens,
        });

        if (!nextCompactedContext) {
          break;
        }

        compactedContext = nextCompactedContext;
        await options.onCompactedContext?.(nextCompactedContext);
        for (const turnId of batchTurnIds) {
          pendingTurnIds.delete(turnId);
        }

        frontendLogger.info("frontend.agent", "compaction_pass_finished", {
          compactedTurnCount: nextCompactedContext.compactedTurnIds.length,
          remainingDroppedTurnCount: pendingTurnIds.size,
          summaryTokens: nextCompactedContext.tokens,
          turnIdLength: options.turnId.length,
        });
      }

      if (pendingTurnIds.size > 0) {
        frontendLogger.error("frontend.agent", "compaction_incomplete", {
          remainingDroppedTurnCount: pendingTurnIds.size,
          turnIdLength: options.turnId.length,
        });
        await endCompaction("failed");
        throw new CompactionFailureError(
          "Could not free enough context by compacting older turns. Try a larger-context model or start a new chat.",
        );
      }

      const nextSelection = reselect();
      if (nextSelection.droppedTurnIds.length > 0) {
        await endCompaction("failed");
        throw new CompactionFailureError(
          "Context changed while compaction was rebuilding replay. Send the message again to retry safely.",
        );
      }

      frontendLogger.info("frontend.agent", "compaction_finished", {
        compactedTurnCount: compactedContext?.compactedTurnIds.length ?? 0,
        summaryTokens: compactedContext?.tokens ?? 0,
        turnIdLength: options.turnId.length,
      });
      await endCompaction("compacted");

      return nextSelection;
    } catch (error) {
      if (isCompactionFailureError(error)) {
        throw error;
      }
      frontendLogger.error("frontend.agent", "compaction_failed", {
        error,
        turnIdLength: options.turnId.length,
      });
      await endCompaction("failed");
      if (isReplayBudgetError(error)) {
        throw error;
      }
      throw toCompactionFailureError(error);
    }
  };

  const rebuildConversation = async (additionalMessages: ChatRequestMessage[] = []) => {
    const selectOptions = { additionalMessages };
    let selection = selectConversation(selectOptions);

    if (selection.droppedTurnIds.length > 0) {
      selection = await compactDroppedTurns(selection, conversationHistory, {
        additionalMessages,
        history: conversationHistory,
      });
    }

    return {
      conversation: buildConversation({
        additionalMessages,
        compactedContext,
        currentTurnId: options.turnId,
        history: selection.messages,
        modelCapabilities: options.modelCapabilities,
        modelId: options.modelId,
        modelReasoning: options.selectedModel.reasoning,
        previewFileMap: options.previewFileMap,
        systemPrompt,
      }),
      maxTokens: selection.budget.reservedOutputTokens,
      snapshot: selection.snapshot,
    };
  };

  let usedToolsInTurn = false;

  const settleSoftAfterToolsForCompactionFailure = async (error: CompactionFailureError) => {
    if (allowSubagents) {
      await settleSubagentsForFinal();
      await injectCompletedSubagentResponses();
    }
    const notice = buildCompactionFailureUserMessage(error.message);
    frontendLogger.error("frontend.agent", "compaction_failed_after_tools_soft_settle", {
      errorMessage: error.message,
      turnIdLength: options.turnId.length,
    });
    const noticeMessage = createAssistantMessage(options.turnId);
    options.onAssistantCreated(noticeMessage);
    options.onAssistantChunk({
      kind: "content",
      messageId: noticeMessage.id,
      text: notice,
    });
    options.onAssistantStreamFinished(noticeMessage.id, "final");
    options.onTurnFinished({ finishReason: "done", status: "done", turnId: options.turnId });
  };

  const runExceptionalFinal = async (
    kind: "context_pressure" | "max_steps",
  ): Promise<WorkspaceAgentRunResult> => {
    // Settling makes this turn compactable. The queued continuation restores
    // the durable implementation plan and resumes its current step on the next turn.
    const preservesImplementationPlan =
      await persistPendingImplementationPlanForContextContinuation({
        hasPendingPlan: implementationPlanEngine.hasPendingExecution(),
        persistPlan: persistImplementationPlanProgress,
      });
    frontendLogger.info("frontend.agent", "exceptional_finalization_started", {
      historyCount: conversationHistory.length,
      kind,
      preservesImplementationPlan,
      turnIdLength: options.turnId.length,
    });

    if (allowSubagents) {
      await settleSubagentsForFinal();
      await injectCompletedSubagentResponses();
    }

    let emergencyBuild: ReturnType<typeof buildEmergencyFinalizationRequest>;
    try {
      emergencyBuild = buildEmergencyFinalizationRequest({
        compactedContext,
        currentTurnId: options.turnId,
        history: conversationHistory,
        maxContextTokens: options.selectedModel.maxContext,
        maxOutputTokens: options.selectedModel.maxOutputTokens,
        previewFileMap: options.previewFileMap,
        systemPrompt:
          kind === "context_pressure"
            ? resolveContextPressureSystemPrompt()
            : getRemotePrompt("max-steps-final"),
        planInstruction: implementationPlanEngine.getContinuationInstruction() ?? undefined,
      });
    } catch (error) {
      frontendLogger.error("frontend.agent", "exceptional_finalization_build_failed", {
        error,
        kind,
        turnIdLength: options.turnId.length,
      });
      // Soft settle with fallback text so tools are not lost as a hard error.
      const noticeMessage = createAssistantMessage(options.turnId);
      options.onAssistantCreated(noticeMessage);
      options.onAssistantChunk({
        kind: "content",
        messageId: noticeMessage.id,
        text: resolveForcedFinalDisplayContent({
          error,
          kind,
          streamedContent: "",
        }).content,
      });
      options.onAssistantStreamFinished(noticeMessage.id, "final");
      options.onTurnFinished({
        finishReason: kind,
        status: "done",
        turnId: options.turnId,
      });
      return { finishReason: kind };
    }

    frontendLogger.info("frontend.agent", "exceptional_finalization_request_built", {
      estimatedInputTokens: emergencyBuild.estimatedInputTokens,
      inputBudget: emergencyBuild.budget.inputTokens,
      kind,
      maxOutputTokens: emergencyBuild.budget.maxOutputTokens,
      retryEstimatedInputTokens: emergencyBuild.retryEstimatedInputTokens,
      turnIdLength: options.turnId.length,
    });

    const finalOutcome = await requestForcedFinalResponse({
      chatId: options.chatId,
      conversation: emergencyBuild.conversation,
      forcedFinalKind: kind,
      maxTokens: emergencyBuild.budget.maxOutputTokens,
      modelId: options.modelId,
      modelReasoning: options.selectedModel.reasoning,
      onAssistantChunk: options.onAssistantChunk,
      onAssistantCreated: options.onAssistantCreated,
      onAssistantReasoningReplay: options.onAssistantReasoningReplay,
      onReasoningFinished: options.onReasoningFinished,
      onProviderRetry: options.onProviderRetry,
      onAssistantStreamFinished: options.onAssistantStreamFinished,
      projectId: options.projectId,
      reasoningLevel: null,
      reasoningSelection: resolveEmergencyReasoningSelection(
        options.selectedModel.reasoning,
      ),
      semanticRetryConversation: emergencyBuild.retryConversation,
      step: kind === "context_pressure" ? 0 : maxAgentSteps,
      streamKey: options.streamKey,
      turnId: options.turnId,
    });

    frontendLogger.info("frontend.agent", "exceptional_finalization_finished", {
      contentLength: finalOutcome.content.length,
      kind,
      outcomeKind: finalOutcome.kind,
      turnIdLength: options.turnId.length,
      usedFallback: finalOutcome.kind !== "ok",
    });

    options.onTurnFinished({
      finishReason: kind,
      status: "done",
      turnId: options.turnId,
    });
    return { finishReason: kind };
  };

  const runContextPressureFinal = () => runExceptionalFinal("context_pressure");

  type RebuildOutcome =
    | {
        kind: "conversation";
        conversation: ChatRequestMessage[];
        maxTokens: number;
      }
    | { kind: "context_pressure" }
    | { kind: "settled" };

  const rebuildConversationForTurn = async (
    additionalMessages: ChatRequestMessage[] = [],
  ): Promise<RebuildOutcome> => {
    try {
      const rebuilt = await rebuildConversation(additionalMessages);
      return {
        kind: "conversation",
        conversation: rebuilt.conversation,
        maxTokens: rebuilt.maxTokens,
      };
    } catch (error) {
      if (
        isReplayBudgetError(error) &&
        shouldEnterContextPressure({ code: error.code, usedToolsInTurn })
      ) {
        frontendLogger.info("frontend.agent", "context_pressure_triggered", {
          code: error.code,
          turnIdLength: options.turnId.length,
        });
        return { kind: "context_pressure" };
      }

      if (!isCompactionFailureError(error)) {
        throw error;
      }

      if (resolveCompactionFailureAction({ usedToolsInTurn }) === "soft_settle_done") {
        if (implementationPlanEngine.hasPendingExecution()) {
          options.onTurnFinished({ finishReason: "error", status: "error", turnId: options.turnId });
          throw new Error(
            "Context compaction failed while the implementation plan was unfinished. The saved plan remains available to continue.",
          );
        }
        await settleSoftAfterToolsForCompactionFailure(error);
        return { kind: "settled" };
      }

      // Pre-tools: hard fail — never send with unsummarized drops (#33 / #35).
      options.onTurnFinished({ finishReason: "error", status: "error", turnId: options.turnId });
      throw error;
    }
  };

  let conversation: ChatRequestMessage[];
  let requestMaxTokens: number;
  {
    await injectCompletedSubagentResponses();
    const initial = await rebuildConversationForTurn();
    if (initial.kind === "context_pressure") {
      return runContextPressureFinal();
    }
    if (initial.kind === "settled") {
      return { finishReason: "done" };
    }
    conversation = initial.conversation;
    requestMaxTokens = initial.maxTokens;
  }

  for (let step = 0; step < maxAgentSteps; step += 1) {
    await injectCompletedSubagentResponses();
    const activeSubagentTasks = allowSubagents ? activeTasksForRun() : [];
    const bufferForSubagent = allowSubagents && hasUnsettledSubagentsForRun();
    const implementationPlanInstruction = implementationPlanEngine.getContinuationInstruction();
    const bufferForImplementationPlan = implementationPlanEngine.hasPendingExecution();
    const bufferWorkingContent = bufferForSubagent || bufferForImplementationPlan;
    const coordinationMessage = buildSubagentCoordinationMessage(activeSubagentTasks);
    const additionalMessages: ChatRequestMessage[] = bufferWorkingContent
      ? [
          {
            content:
              [coordinationMessage, implementationPlanInstruction].filter(Boolean).join("\n\n") ||
              "Required work is still pending. Do not give a final answer yet.",
            role: "system",
          },
        ]
      : [];
    const rebuilt = await rebuildConversationForTurn(additionalMessages);
    if (rebuilt.kind === "context_pressure") {
      return runContextPressureFinal();
    }
    if (rebuilt.kind === "settled") {
      return { finishReason: "done" };
    }
    conversation = rebuilt.conversation;
    requestMaxTokens = rebuilt.maxTokens;
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
        maxTokens: requestMaxTokens,
        modelId: options.modelId,
        onChunk: (chunk) => {
          if (bufferWorkingContent && chunk.kind === "content") {
            return;
          }
          options.onAssistantChunk({
            ...chunk,
            messageId: assistantMessage.id,
          });
        },
        onReasoningFinished: () => options.onReasoningFinished?.(assistantMessage.id),
        onProviderRetry: options.onProviderRetry,
        onToolCalls: (toolCalls) => options.onAssistantToolCalls(assistantMessage.id, toolCalls),
        projectId: options.projectId,
        reasoningLevel: options.reasoningLevel,
        reasoningSelection,
        streamKey: options.streamKey,
        tools,
        turnIndex: step,
        toToolCallState: createToolCallState,
      });
      if (streamedTurn.reasoningReplay.length > 0) {
        const reasoningReplay = attachReasoningReplaySource({
          entries: streamedTurn.reasoningReplay,
          modelId: options.modelId,
          reasoning: options.selectedModel.reasoning,
        });
        // The next tool-loop request is rebuilt from this local transcript, so
        // update it before notifying persistence/UI listeners.
        assistantMessage.reasoningReplay = reasoningReplay;
        options.onAssistantReasoningReplay?.(
          assistantMessage.id,
          reasoningReplay,
        );
      }
    } catch (error) {
      frontendLogger.error("frontend.agent", "step_stream_failed", {
        error,
        messageIdLength: assistantMessage.id.length,
        step,
        turnIdLength: options.turnId.length,
      });
      options.onTurnFinished({ finishReason: "error", status: "error", turnId: options.turnId });
      throw error;
    }

    const normalizedToolCalls = normalizeStreamedToolCalls(streamedTurn.toolCalls, step);
    const toolCallItems = normalizedToolCalls.items;
    const postStreamAction = resolvePostStreamAssistantAction({
      hadToolCallIntents: normalizedToolCalls.hadToolCallIntents,
      toolCallItemCount: toolCallItems.length,
    });

    frontendLogger.info("frontend.agent", "step_stream_finished", {
      contentLength: streamedTurn.content.length,
      hadToolCallIntents: normalizedToolCalls.hadToolCallIntents,
      invalidToolCallCount: toolCallItems.filter((item) => item.kind === "invalid").length,
      postStreamAction: postStreamAction.type,
      reasoningLength: streamedTurn.reasoning.length,
      readyToolCallCount: toolCallItems.filter((item) => item.kind === "ready").length,
      step,
      toolCallCount: toolCallItems.length,
    });

    if (postStreamAction.type === "malformed_tool_stream") {
      // Do not finish as a clean final answer when the model intended tools (#38).
      frontendLogger.error("frontend.agent", "malformed_tool_call_stream", {
        rawToolCallSlots: streamedTurn.toolCalls.length,
        step,
        turnIdLength: options.turnId.length,
      });
      options.onTurnFinished({ finishReason: "error", status: "error", turnId: options.turnId });
      throw new Error(
        "The model returned tool calls that could not be executed (missing or invalid tool names).",
      );
    }

    if (postStreamAction.type === "finish_final") {
      let requiredJoinPending = false;
      if (bufferForSubagent) {
        await settleSubagentsForFinal();
        requiredJoinPending = activeTasksForRun().some((task) => task.join === "required");
      }
      const injectedResponseCount = await injectCompletedSubagentResponses();
      const hasFinalContent = streamedTurn.content.trim().length > 0;
      if (implementationPlanEngine.hasPendingExecution()) {
        if (step + 1 >= maxAgentSteps) {
          const canUseBufferedFinal = shouldAcceptBufferedMaxStepFinal({
            content: streamedTurn.content,
            injectedResponseCount,
            isLastStep: true,
            requiredJoinPending,
          });
          if (canUseBufferedFinal) {
            await persistPendingImplementationPlanForContextContinuation({
              hasPendingPlan: true,
              persistPlan: persistImplementationPlanProgress,
            });
            if (bufferWorkingContent) {
              options.onAssistantChunk({
                kind: "content",
                messageId: assistantMessage.id,
                text: streamedTurn.content,
              });
            }
            options.onAssistantStreamFinished(assistantMessage.id, "final");
            frontendLogger.info("frontend.agent", "max_steps_buffered_final_accepted", {
              contentLength: streamedTurn.content.length,
              step,
              turnIdLength: options.turnId.length,
            });
            options.onTurnFinished({
              finishReason: "max_steps",
              status: "done",
              turnId: options.turnId,
            });
            return { finishReason: "max_steps" };
          }

          options.onAssistantStreamFinished(assistantMessage.id, "working");
          frontendLogger.info("frontend.agent", "max_steps_requires_emergency_final", {
            contentLength: streamedTurn.content.length,
            injectedResponseCount,
            step,
            turnIdLength: options.turnId.length,
          });
          return runExceptionalFinal("max_steps");
        }

        options.onAssistantStreamFinished(assistantMessage.id, "working");
        frontendLogger.info("frontend.agent", "final_deferred_for_implementation_plan", {
          step,
          turnIdLength: options.turnId.length,
        });
        continue;
      }
      if (
        shouldDeferFinalForSubagentResponse({
          candidateWasBuffered: bufferForSubagent,
          injectedResponseCount,
          requiredJoinPending,
        })
      ) {
        options.onAssistantStreamFinished(assistantMessage.id, "working");
        frontendLogger.info("frontend.agent", "final_deferred_for_subagent_event", {
          injectedResponseCount,
          step,
          turnIdLength: options.turnId.length,
        });
        continue;
      }

      if (bufferWorkingContent && streamedTurn.content) {
        options.onAssistantChunk({
          kind: "content",
          messageId: assistantMessage.id,
          text: streamedTurn.content,
        });
      }

      options.onAssistantStreamFinished(assistantMessage.id, "final");

      if (usedToolsInTurn && !hasFinalContent) {
        frontendLogger.info("frontend.agent", "missing_final_response_after_tool_run", {
          step,
          turnIdLength: options.turnId.length,
        });

        const forcedRebuild = await rebuildConversationForTurn([
          { content: getRemotePrompt("final-response"), role: "system" },
        ]);
        if (forcedRebuild.kind === "context_pressure") {
          return runContextPressureFinal();
        }
        if (forcedRebuild.kind === "settled") {
          return { finishReason: "done" };
        }

        const finalOutcome = await requestForcedFinalResponse({
          chatId: options.chatId,
          conversation: forcedRebuild.conversation,
          forcedFinalKind: "after_tools",
          maxTokens: forcedRebuild.maxTokens,
          modelId: options.modelId,
          modelReasoning: options.selectedModel.reasoning,
          onAssistantChunk: options.onAssistantChunk,
          onAssistantCreated: options.onAssistantCreated,
          onAssistantReasoningReplay: options.onAssistantReasoningReplay,
          onReasoningFinished: options.onReasoningFinished,
          onProviderRetry: options.onProviderRetry,
          onAssistantStreamFinished: options.onAssistantStreamFinished,
          projectId: options.projectId,
          reasoningLevel: options.reasoningLevel,
          reasoningSelection,
          step: step + 1,
          streamKey: options.streamKey,
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
      options.onTurnFinished({ finishReason: "done", status: "done", turnId: options.turnId });
      return { finishReason: "done" };
    }

    // #15: attach tool_call parts before finishing the assistant stream as working.
    if (bufferWorkingContent && streamedTurn.content) {
      options.onAssistantChunk({
        kind: "content",
        messageId: assistantMessage.id,
        text: streamedTurn.content,
      });
    }
    const openAiToolCalls = toolCallItems.map((item) => item.toolCall);
    let toolCallState = openAiToolCalls.map(createToolCallState);
    const hasImplementationPlanStopIntent = toolCallItems.some((item) => {
      if (item.toolCall.function.name !== "implementation_plan") return false;
      try {
        const input = JSON.parse(item.toolCall.function.arguments) as { action?: string };
        return input.action === "save";
      } catch {
        return false;
      }
    });
    let implementationPlanStopRequested = false;
    usedToolsInTurn = true;
    options.onAssistantToolCalls(assistantMessage.id, toolCallState);
    options.onAssistantStreamFinished(assistantMessage.id, "working");
    conversationHistory.push({
      ...assistantMessage,
      assistantPhase: "working",
      completedAtMs: Date.now(),
      content: streamedTurn.content,
      reasoning: "",
      status: "done",
      toolCalls: openAiToolCalls.map((toolCall) => ({
        id: toolCall.id,
        input: toolCall.function.arguments,
        name: toolCall.function.name,
        status: "pending",
      })),
    });
    const approvalPreflightResults = await Promise.all(
      toolCallItems.map(async (item) => {
        const toolCall = item.toolCall;
        const isSpecialTool = ["clarify", "implementation_plan", "subagent"].includes(
          toolCall.function.name,
        );
        const isSuppressedByPlanReview =
          hasImplementationPlanStopIntent && toolCall.function.name !== "implementation_plan";
        const isDisallowedForRole =
          Boolean(permittedToolNames) && !permittedToolNames?.has(toolCall.function.name);

        if (
          item.kind === "invalid" ||
          isSpecialTool ||
          isSuppressedByPlanReview ||
          isDisallowedForRole
        ) {
          return { request: null, toolCallId: toolCall.id };
        }

        try {
          return {
            request: await createToolApprovalRequest({
              arguments: toolCall.function.arguments,
              permissionMode: options.permissionMode,
              projectRoot: projectContext.projectRoot,
              sessionId: options.chatId,
              toolCallId: toolCall.id,
              toolName: toolCall.function.name,
            }),
            toolCallId: toolCall.id,
          };
        } catch (error) {
          return {
            error: resolveToolExecutionErrorMessage(error),
            request: null,
            toolCallId: toolCall.id,
          };
        }
      }),
    );
    const approvalRequestsByToolCallId = new Map(
      approvalPreflightResults.flatMap((result) =>
        result.request ? [[result.toolCallId, result.request] as const] : [],
      ),
    );
    const approvalPreparationErrorsByToolCallId = new Map(
      approvalPreflightResults.flatMap((result) =>
        result.error ? [[result.toolCallId, result.error] as const] : [],
      ),
    );
    const approvalRequests = [...approvalRequestsByToolCallId.values()];
    let batchApprovalGranted = false;
    let batchApprovalError: string | null = null;
    let batchApprovalInterrupted = false;

    if (approvalRequests.length > 0) {
      try {
        batchApprovalGranted = await requestToolApproval(
          createToolApprovalBatchRequest(approvalRequests),
        );
      } catch (error) {
        if (error instanceof Error && error.message === INTERRUPTED_WORKSPACE_CHAT_ERROR) {
          batchApprovalInterrupted = true;
        } else {
          batchApprovalError = resolveToolExecutionErrorMessage(error);
        }
      }
    }
    let batchInterrupted = false;
    for (const item of toolCallItems) {
      const toolCall = item.toolCall;
      frontendLogger.info("frontend.agent", "tool_started", {
        step,
        toolCallIdLength: toolCall.id.length,
        toolInputLength: toolCall.function.arguments.length,
        toolKind: item.kind,
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

      if (batchApprovalInterrupted) {
        toolPayload = {
          error: "User interrupted",
          output: JSON.stringify({
            error: "User interrupted",
            interrupted: true,
            ok: false,
          }),
          status: "interrupted",
        };
      } else if (batchInterrupted) {
        toolPayload = {
          error: "Skipped because an earlier tool in this batch was interrupted.",
          output: JSON.stringify({
            error: "Skipped because an earlier tool in this batch was interrupted.",
            interrupted: true,
            ok: false,
          }),
          status: "interrupted",
        };
      } else if (implementationPlanStopRequested) {
        toolPayload = {
          error: "Skipped because the implementation plan is ready for user review.",
          output: JSON.stringify({
            error: "Skipped because the implementation plan is ready for user review.",
            ok: false,
          }),
          status: "error",
        };
      } else if (
        hasImplementationPlanStopIntent &&
        toolCall.function.name !== "implementation_plan"
      ) {
        toolPayload = {
          error: "Project tools cannot run in the same batch that saves an implementation plan.",
          output: JSON.stringify({
            error: "Project tools cannot run in the same batch that saves an implementation plan.",
            ok: false,
          }),
          status: "error",
        };
      } else if (item.kind === "invalid") {
        // #21 / #38: never execute invalid args/names as empty tools.
        frontendLogger.error("frontend.agent", "tool_call_rejected_before_run", {
          error: item.error,
          step,
          toolCallIdLength: toolCall.id.length,
          toolName: toolCall.function.name,
        });
        toolPayload = {
          error: item.error,
          output: JSON.stringify({
            error: item.error,
            ok: false,
          }),
          status: "error",
        };
      } else {
        try {
          if (toolCall.function.name === "implementation_plan") {
            if (options.subagentRole) {
              toolPayload = {
                error: "Implementation plans are managed by the main agent.",
                output: JSON.stringify({
                  error: "Implementation plans are managed by the main agent.",
                  ok: false,
                }),
                status: "error",
              };
            } else {
              toolPayload = runImplementationPlanTool(
                implementationPlanEngine,
                toolCall.function.arguments,
              );
              if (toolPayload.status === "done" && toolPayload.output) {
                const savedPlan = await persistImplementationPlanProgress();
                if (!savedPlan) {
                  const message =
                    "The implementation plan changed but could not be saved. Retry by revising the plan.";
                  toolPayload = {
                    error: message,
                    output: JSON.stringify({ error: message, ok: false, stopTurn: false }),
                    status: "error",
                  };
                } else {
                  const output = JSON.parse(toolPayload.output) as Record<string, unknown>;
                  output.path = savedPlan.planPath;
                  output.planPath = savedPlan.planPath;
                  toolPayload.output = JSON.stringify(output);
                  implementationPlanStopRequested = output.stopTurn === true;
                }
              }
            }
          } else if (toolCall.function.name === "clarify") {
            if (options.subagentRole) {
              toolPayload = {
                error: "Clarification is managed by the main agent.",
                output: JSON.stringify({ error: "Clarification is managed by the main agent.", ok: false }),
                status: "error",
              };
            } else {
              toolPayload = await runClarifyTool({
                argumentsJson: toolCall.function.arguments,
                request: (request) => options.requestWorkflowQuestions({
                  ...request,
                  sessionId: options.chatId,
                  toolCallId: toolCall.id,
                }),
              });
            }
          } else if (toolCall.function.name === "subagent") {
            if (!startSubagent) {
              toolPayload = {
                error: "Subagents are not available inside a subagent run.",
                output: JSON.stringify({
                  error: "Subagents are not available inside a subagent run.",
                  ok: false,
                }),
                status: "error",
              };
            } else {
              toolPayload = await runSubagentTool({
                allowedNames: options.allowedSubagentNames,
                argumentsJson: toolCall.function.arguments,
                ownerTurnId: options.rootTurnId ?? options.turnId,
                recipientTaskId: options.subagentTaskId ?? null,
                responseTurnId: options.turnId,
                sessionId: options.chatId,
                start: startSubagent,
              });
            }
          } else {
            if (permittedToolNames && !permittedToolNames.has(toolCall.function.name)) {
              toolPayload = {
                error: `${options.subagentRole} cannot use ${toolCall.function.name}.`,
                output: JSON.stringify({ error: "Tool is not allowed for this subagent role.", ok: false }),
                status: "error",
              };
            } else {
              const approvalPreparationError =
                approvalPreparationErrorsByToolCallId.get(toolCall.id);
              const approvalRequest = approvalRequestsByToolCallId.get(toolCall.id);
              const manualApprovalGranted = Boolean(approvalRequest && batchApprovalGranted);

              if (approvalPreparationError) {
                toolPayload = {
                  error: approvalPreparationError,
                  output: null,
                  status: "error",
                };
              } else if (approvalRequest && batchApprovalError) {
                toolPayload = {
                  error: batchApprovalError,
                  output: null,
                  status: "error",
                };
              } else if (approvalRequest && !manualApprovalGranted) {
                toolPayload = createRejectedToolPayload(approvalRequest);
              } else {
                toolPayload = await runAgentTool({
                  arguments: toolCall.function.arguments,
                  imageCapable,
                  manualApprovalGranted,
                  onChunk: (chunk) => options.onToolChunk?.(chunk),
                  projectId: options.projectId,
                  sessionId: options.chatId,
                  toolCallId: toolCall.id,
                  turnId: options.turnId,
                  toolName: toolCall.function.name,
                });
              }
            }
          }
        } catch (error) {
          if (error instanceof Error && error.message === INTERRUPTED_WORKSPACE_CHAT_ERROR) {
            frontendLogger.info("frontend.agent", "tool_execution_interrupted", {
              step,
              toolCallIdLength: toolCall.id.length,
              toolName: toolCall.function.name,
            });
            // Partial stream text is folded in by the store from live buffers (#37).
            toolPayload = {
              error: "User interrupted",
              output: JSON.stringify({
                error: "User interrupted",
                interrupted: true,
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
      if (toolPayload.status === "interrupted") {
        batchInterrupted = true;
      }
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
    }

    if (batchInterrupted) {
      options.onTurnFinished({
        finishReason: "interrupted",
        status: "interrupted",
        turnId: options.turnId,
      });
      throw new Error(INTERRUPTED_WORKSPACE_CHAT_ERROR);
    }

    const incompleteToolCallIds = findIncompleteToolCallIds(toolCallState);
    if (incompleteToolCallIds.length > 0) {
      options.onTurnFinished({ finishReason: "error", status: "error", turnId: options.turnId });
      throw new Error("The tool batch ended before every tool call received a terminal result.");
    }

    if (implementationPlanStopRequested) {
      if (allowSubagents) {
        await settleSubagentsForFinal();
        await injectCompletedSubagentResponses();
      }
      const planReadyMessage = createAssistantMessage(options.turnId);
      options.onAssistantCreated(planReadyMessage);
      options.onAssistantChunk({
        kind: "content",
        messageId: planReadyMessage.id,
        text: "Implementation plan is ready. Read it, then reply continue/proceed or request changes.",
      });
      options.onAssistantStreamFinished(planReadyMessage.id, "final");
      frontendLogger.info("frontend.agent", "implementation_plan_awaiting_user", {
        step,
        turnIdLength: options.turnId.length,
      });
      options.onTurnFinished({ finishReason: "done", status: "done", turnId: options.turnId });
      return { finishReason: "done" };
    }

    // Tool batches are context-atomic: every call receives a terminal result before
    // replay selection can compact or enter current-turn pressure.
    {
      await injectCompletedSubagentResponses();
      const rebuiltAfterToolBatch = await rebuildConversationForTurn();
      if (rebuiltAfterToolBatch.kind === "context_pressure") {
        return runContextPressureFinal();
      }
      if (rebuiltAfterToolBatch.kind === "settled") {
        return { finishReason: "done" };
      }
      conversation = rebuiltAfterToolBatch.conversation;
      requestMaxTokens = rebuiltAfterToolBatch.maxTokens;
    }
  }

  frontendLogger.error("frontend.agent", "run_exceeded_max_steps", {
    maxSteps: maxAgentSteps,
    turnIdLength: options.turnId.length,
  });

  if (usedToolsInTurn || implementationPlanEngine.hasPendingExecution()) {
    return runExceptionalFinal("max_steps");
  }

  options.onTurnFinished({ finishReason: "error", status: "error", turnId: options.turnId });
  throw new Error(
    "The agent reached the maximum number of tool steps for this turn before producing a final response.",
  );
}

export async function runWorkspaceAgent(
  options: RunWorkspaceAgentOptions,
): Promise<WorkspaceAgentRunResult> {
  try {
    return await runWorkspaceAgentInternal(options);
  } finally {
    if (options.allowSubagents !== false) {
      await workspaceSubagentManager.interruptAll(options.chatId);
    }
  }
}
