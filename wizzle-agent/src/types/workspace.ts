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
  createdAtMs: number;
  defaultModelId?: string | null;
  endpoint: string;
  hasApiKey: boolean;
  id: string;
  modelCount: number;
  name: string;
  providerType: string;
  /** Configured path or URL for provider-level tokenizer.json */
  tokenizerJson?: string | null;
  /** Cached local path under ~/.wizzle/tokenizers when ready */
  tokenizerLocalPath?: string | null;
  updatedAtMs: number;
}

export interface ProviderModelInfo {
  capabilities: ModelCapability[];
  displayName?: string | null;
  id: ModelId;
  isPinned: boolean;
  lastUsedAtMs?: number | null;
  /** Null when a remote catalog did not publish a trustworthy context limit. */
  maxContext: number | null;
  maxOutputTokens?: number | null;
  modelId: string;
  providerId: string;
  providerName: string;
  providerType: string;
  reasoningLevels: string[];
  /** Configured path or URL for model-level tokenizer.json (overrides provider) */
  tokenizerJson?: string | null;
  tokenizerKind?: string | null;
  /** Cached local path when model tokenizer is ready */
  tokenizerLocalPath?: string | null;
}

export interface ToolApprovalRequest {
  command?: string;
  path?: string;
  /** Session that owns this pending approval (survives UI session switches). */
  sessionId: string;
  summary: string;
  timeout: string;
  toolCallId: string;
  toolName: "bash" | "edit" | "read" | "write";
  warning?: {
    kind: "dangerous-command" | "external-path" | "sensitive-path";
    message: string;
    title?: string;
  };
}

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
  compactedContext?: CompactedContextRecord | null;
  events?: SessionEvent[];
  messages: Message[];
  replayTurnSummaries?: PersistedTurnSummaryRecord[];
  selectedModelUuid?: string | null;
  systemPromptHash?: string | null;
  tokenizerKind?: string | null;
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
