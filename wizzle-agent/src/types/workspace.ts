export type MessageRole = "user" | "assistant" | "tool";
export type FilePreviewKind = "markdown" | "text" | "image" | "other";
export type PermissionMode = "manual-approve" | "full-access";
export type ModelId = string;
export type ModelCapability = "text" | "image" | "video" | "audio";
export type AssistantPhase = "pending" | "working" | "final";
export type ReplayCapabilityMode = "textOnly" | "imageCapable";
export type SessionRuntimeStateKind =
  | "idle"
  | "busy"
  | "compacting"
  | "waiting_approval"
  | "interrupted"
  | "error";

export interface ProxyModelInfo {
  capabilities: ModelCapability[];
  id: string;
}

export interface ProviderInfo {
  canRefreshModels: boolean;
  createdAtMs: number;
  defaultMaxContext?: number | null;
  defaultMaxOutputTokens?: number | null;
  defaultModelId?: string | null;
  endpoint: string;
  hasApiKey: boolean;
  headers: ProviderHeader[];
  id: string;
  isManaged: boolean;
  managedConfigId?: string | null;
  modelCount: number;
  name: string;
  providerType: string;
  requestFields: ProviderRequestField[];
  updatedAtMs: number;
}

export interface ProviderHeader {
  name: string;
  value: string;
}

export interface ProviderRequestField {
  path: string;
  value: unknown;
}

export type ReasoningPatchOperation = "omit" | "set";
export type ReasoningReplayOperation = "append" | "merge" | "prepend" | "set";
export type ReasoningReplayScope =
  | "active_tool_loop"
  | "all_turns"
  | "server_managed"
  | "tool_call_turns";

export interface ModelReasoningInput {
  default: number;
  id: string;
  max?: number | null;
  min?: number | null;
  type: "integer";
}

export interface ModelReasoningRequestPatch {
  operation: ReasoningPatchOperation;
  path: string;
  value?: unknown;
}

export interface ModelReasoningVariant {
  id: string;
  inputs: ModelReasoningInput[];
  label: string;
  request: ModelReasoningRequestPatch[];
}

export interface ModelReasoningReplayCapture {
  assistantMessagePath: string;
  operation?: ReasoningReplayOperation;
  responsePath: string;
  when?: {
    equals: unknown;
    responsePath: string;
  } | null;
}

export interface ModelReasoningConfig {
  defaultVariantId?: string | null;
  replay?: {
    capture: ModelReasoningReplayCapture[];
    preserveExactly: boolean;
    scope: ReasoningReplayScope;
  } | null;
  variants: ModelReasoningVariant[];
}

export interface ReasoningSelection {
  inputs: Record<string, number>;
  variantId: string;
}

export interface ReasoningReplayEntry {
  assistantMessagePath: string;
  operation: ReasoningReplayOperation;
  /** Model UUID that produced this opaque provider-native value. */
  sourceModelId?: ModelId;
  /** Stable identity of the recipe used when this value was captured. */
  sourceRecipeHash?: string;
  value: unknown;
}

export interface ProviderModelInfo {
  capabilities: ModelCapability[];
  /** Model-specific value before provider fallback is applied. */
  configuredMaxContext?: number | null;
  /** Model-specific value before provider fallback is applied. */
  configuredMaxOutputTokens?: number | null;
  displayName?: string | null;
  id: ModelId;
  isPinned: boolean;
  lastUsedAtMs?: number | null;
  /** Effective context limit after provider and app fallback. */
  maxContext: number | null;
  /** Effective output limit after provider fallback, if configured. */
  maxOutputTokens?: number | null;
  modelId: string;
  providerId: string;
  providerName: string;
  providerType: string;
  reasoning?: ModelReasoningConfig | null;
  /** Compatibility projection of `reasoning.variants[].id`. */
  reasoningLevels: string[];
}

export interface ProviderRetryStatus {
  attempt: number;
  delayMs: number;
  maxAttempts: number;
  message: string;
}

export interface ToolApprovalRequest {
  arguments?: string;
  /** Approval-requiring calls emitted in the same model tool batch. */
  batchRequests?: ToolApprovalRequest[];
  command?: string;
  description?: string;
  path?: string;
  /** Session that owns this pending approval (survives UI session switches). */
  sessionId: string;
  /** Hidden subagent that owns this approval, when applicable. */
  subagentName?: "reviewer" | "explorer" | "worker";
  subagentTask?: string;
  subagentTaskId?: string;
  summary: string;
  timeout: string;
  toolCallId: string;
  toolName: "shell" | "edit" | "read" | "write";
  warning?: {
    kind: "dangerous-command" | "external-path" | "sensitive-path";
    message: string;
    title?: string;
  };
}

export interface ClarifyRequest {
  allowCustomAnswer?: boolean;
  choices?: string[];
  kind: "approach" | "doubt";
  prompt: string;
  recommended?: number;
  sessionId: string;
  toolCallId: string;
}

export type WorkflowQuestionRequest = ClarifyRequest;
export type WorkflowQuestionAnswer = string;

export interface PreviewFile {
  contentHash?: string;
  id: string;
  isSensitive?: boolean;
  name: string;
  kind: FilePreviewKind;
  mimeType?: string;
  originalPath?: string;
  path: string;
  previewMetadata?: Record<string, unknown>;
  realPath?: string;
  sizeBytes?: number;
  summary: string;
  content?: string;
  language?: string;
  imageSrc?: string;
}

export interface ToolCall {
  id: string;
  input?: string;
  name: string;
  status?: string;
}

export interface ToolResult {
  error?: string;
  id: string;
  output?: string;
  status?: string;
  toolCallId?: string;
}

export interface SessionRuntimeState {
  error?: string | null;
  sessionId: string;
  state: SessionRuntimeStateKind;
  updatedAtMs: number;
}

export interface WorkspaceProcess {
  command: string;
  cwd: string;
  endedAtMs?: number | null;
  exitCode?: number | null;
  id: string;
  pid?: number | null;
  sessionId: string;
  startedAtMs: number;
  status: "pending" | "running" | "done" | "error" | "interrupted" | string;
  stderrTail: string;
  stdoutTail: string;
  /** Tool call that spawned this process (#75). */
  toolCallId?: string | null;
  /** Conversation turn that spawned this process (#75). */
  turnId?: string | null;
}

export type MessagePartType =
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "subagent_response"
  | "activity_content"
  | "content";

export interface MessagePart {
  content?: string;
  createdAtMs?: number;
  durationMs?: number;
  error?: string;
  id: string;
  input?: string;
  metadata?: Record<string, unknown>;
  name?: string;
  output?: string;
  parentPartId?: string;
  pruned?: boolean;
  status?: string;
  toolArguments?: string;
  toolCallId?: string;
  tokens?: number;
  type: MessagePartType;
}

export interface Message {
  assistantPhase?: AssistantPhase;
  id: string;
  role: MessageRole;
  content: string;
  turnId?: string;
  toolCallId?: string;
  toolName?: string;
  reasoning?: string;
  /** Opaque provider-native data retained only when the selected model requires replay. */
  reasoningReplay?: ReasoningReplayEntry[];
  createdAtMs?: number;
  completedAtMs?: number;
  durationMs?: number;
  reasoningDurationMs?: number;
  startedAtMs?: number;
  createdAtLabel: string;
  editedAtMs?: number;
  isStored?: boolean;
  linkedFileIds?: string[];
  status?: "streaming" | "done" | "error" | "interrupted";
  /** UI-only stream state. Not persisted. */
  transientReasoningActive?: boolean;
  /** UI-only stream state. Not persisted. */
  transientStreamStarted?: boolean;
  parts?: MessagePart[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface MessageEditState {
  attachments: PreviewFile[];
  messageId: string;
  projectId: string;
  prompt: string;
  sessionId: string;
  turnId?: string;
}

export interface PersistedTurnSummaryRecord {
  completedAtMs: number;
  estimatedTokensImageCapable: number;
  estimatedTokensTextOnly: number;
  estimatorVersion: number;
  messageIds: string[];
  replayMessageCountImageCapable: number;
  replayMessageCountTextOnly: number;
  turnId: string;
}

export interface CompactedContextRecord {
  compactedTurnIds: string[];
  summary: string;
  tokens: number;
  updatedAtMs: number;
}

export type ContextCompactionPhase = "compacting" | "compacted";

export interface SessionEvent {
  afterMessageCount: number;
  createdAtMs: number;
  id: string;
  phase: ContextCompactionPhase;
  type: "context_status";
  updatedAtMs: number;
}

export type SessionHistoryRecord =
  | {
      kind: "message";
      message: Message;
    }
  | {
      kind: "turn_summary";
      summary: PersistedTurnSummaryRecord;
    };

export interface DisplayMessage {
  content: string;
  createdAtLabel: string;
  createdAtMs?: number;
  durationMs?: number;
  editedAtMs?: number;
  id: string;
  linkedFileIds?: string[];
  messages: Message[];
  parts: MessagePart[];
  role: "assistant" | "user";
  startedAtMs?: number;
  status?: "streaming" | "done" | "error" | "interrupted";
  transientReasoningActive?: boolean;
  transientStreamStarted?: boolean;
}

export interface Session {
  createdAtMs?: number;
  id: string;
  messagesLoaded: boolean;
  title: string;
  updatedAtLabel: string;
  updatedAtMs?: number;
  modelId?: ModelId;
  permissionMode?: PermissionMode;
  /** Compatibility storage slot: plain variant id, or encoded ReasoningSelection with inputs. */
  reasoningLevel?: string | null;
  compactedContext?: CompactedContextRecord | null;
  events?: SessionEvent[];
  messages: Message[];
  replayTurnSummaries?: PersistedTurnSummaryRecord[];
  selectedModelUuid?: string | null;
  systemPromptHash?: string | null;
  systemPromptTokens?: number;
  toolDefTokens?: number;
  toolDefsHash?: string | null;
}

export interface Project {
  createdAtMs?: number;
  id: string;
  name: string;
  rootPath: string;
  isExpanded: boolean;
  sessions: Session[];
  updatedAtMs?: number;
}

export interface WorkspaceSnapshot {
  isFilePanelOpen: boolean;
  isSidebarOpen: boolean;
  modelId: ModelId;
  permissionMode: PermissionMode;
  reasoningLevel?: string;
  previewFiles: PreviewFile[];
  projects: Project[];
  selectedProjectId: string;
  selectedSessionId: string | null;
}

export interface WorkspaceSessionLoad {
  previewFiles: PreviewFile[];
  session: Session;
}

export interface QueuedComposerMessage {
  attachments: PreviewFile[];
  content: string;
  createdAtMs: number;
  id: string;
  queueIndex: number;
  status: "queued" | "sending" | "sent" | "failed";
  updatedAtMs: number;
}

export interface WorkspaceComposerState {
  draftText: string;
  queuedMessages: QueuedComposerMessage[];
}
