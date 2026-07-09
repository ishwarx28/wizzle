import { create } from "zustand";

import { shouldFinalizeStreamingPartOnAssistantFinish } from "../lib/agent/assistant-stream-finish";
import { runWorkspaceAgent } from "../lib/agent-runner";
import { loadPreviewFilesFromPaths } from "../lib/attachments";
import {
  generateWorkspaceSessionTitle,
  INTERRUPTED_WORKSPACE_CHAT_ERROR,
  interruptWorkspaceChat,
  isInterruptedWorkspaceChatError,
} from "../lib/chat-stream";
import {
  appendOrUpdateMessage,
  beginSessionRun,
  createSessionIfNeeded,
  deleteWorkspaceSession,
  finalizeTurn,
  finishSessionRun,
  loadWorkspaceSession,
  reconcileEntireSessionForExplicitEditOrRepair,
  renameWorkspaceSession,
  saveWorkspaceSettings,
  setProjectExpanded,
  truncateSessionTranscriptToTurns,
  updateSessionSelection,
  updateSessionTitle,
  setSessionRuntimeState,
  wakeSessionRun,
  upsertTurnSummary as persistTurnSummary,
} from "../lib/local-workspace";
import {
  collectRetainedTurnIds,
  filterCompactedTurnIds,
} from "../lib/session-edit-truncate";
import {
  drainComposerSessionQueue,
  migrateComposerSessionQueue,
  rekeyComposerSessionQueue,
} from "../lib/composer-session-queue";
import { createDurablePersistFailureReporter } from "../lib/durable-persist-failure";
import { getErrorMessage } from "../lib/settle-turn-persist";
import {
  completeSessionRunFinish,
  isSessionAlreadyRunningError,
} from "../lib/session-run-wake";
import { resolveImageAttachmentHardFailError } from "../lib/image-capability";
import { resolveEffectiveTokenizer } from "../lib/tokenizer-resolve";
import { activateTokenizer } from "../lib/tokenizer-runtime";
import {
  appendMessagePart,
  synchronizeMessageFromParts,
  updateMatchingMessagePart,
} from "../lib/message-parts";
import { buildTurnReplaySummary } from "../lib/context-budget";
import {
  beginContextCompaction,
  completeContextCompaction,
  type ContextCompactionStatus,
} from "../lib/context-status";
import { formatPromptTooLargeError, isPromptOverLimit, resolvePromptMaxChars } from "../lib/prompt-size";
import { frontendLogger } from "../lib/logger";
import {
  describeSettledTurnPersistResult,
  isSettledTurnPersistIncomplete,
  isTurnAlreadyFinalizedError,
  runSettledTurnPersistence,
  type SettledTurnPersistResult,
} from "../lib/settle-turn-persist";
import { resolveHydratedSessionSelection } from "../lib/session-selection";
import {
  clearSessionStreamErrorMap,
  formatStreamStepUserMessage,
  setSessionStreamErrorMap,
  turnHasPartialAssistantContent,
  type SessionStreamError,
} from "../lib/stream-step-error";
import { settleNonToolTurnMessage } from "../lib/settle-turn-status";
import {
  addSendingSessionId,
  removeSendingSessionId,
  resolveIsSendingMessage,
} from "../lib/session-sending";
import { extractLinkedFileFromToolResult } from "../lib/tool-activity";
import {
  appendBufferedToolChunk,
  createEmptyToolStreamBuffer,
  createInterruptedToolStreamOutput,
  createToolStreamOutput,
  type BufferedToolOutput,
} from "../lib/tool-stream-buffer";
import type {
  Message,
  MessageEditState,
  MessagePart,
  ModelId,
  PermissionMode,
  PersistedTurnSummaryRecord,
  PreviewFile,
  Project,
  ProviderInfo,
  ProviderModelInfo,
  Session,
  ToolApprovalRequest,
  WorkspaceSnapshot,
} from "../types/workspace";
import { formatExactMessageTimestamp } from "../utils/time";

interface WorkspaceState {
  activeMessageEdit: MessageEditState | null;
  chatError: string | null;
  draftSessions: Record<string, Session>;
  projects: Project[];
  previewFiles: PreviewFile[];
  selectedProjectId: string;
  selectedSessionId: string | null;
  loadingSessionId: string | null;
  activeFileId: string | null;
  openedFileIds: string[];
  isSidebarOpen: boolean;
  isFilePanelOpen: boolean;
  hasHydratedWorkspace: boolean;
  /** True when the *selected* session is mid-run (derived from sendingSessionIds). */
  isSendingMessage: boolean;
  /** Session ids with an in-flight agent run (multi-session isolated). */
  sendingSessionIds: string[];
  /** Inline context compaction status per session (#81). */
  sessionContextStatus: Record<string, ContextCompactionStatus>;
  /**
   * Stream/step failure under the assistant bubble for this session (#19 C).
   * Cleared when the user sends another message.
   */
  sessionStreamErrors: Record<string, SessionStreamError | undefined>;
  /**
   * Pending tool approvals keyed by session id.
   * Survive session switches; only the selected session's entry is shown in UI (#26/#28).
   */
  pendingToolApprovalsBySessionId: Record<string, ToolApprovalRequest>;
  /** Convenience: approval for the currently selected session (derived). */
  pendingToolApproval: ToolApprovalRequest | null;
  providerModels: ProviderModelInfo[];
  providerModelsError: string | null;
  providers: ProviderInfo[];
  modelId: ModelId;
  reasoningLevel: string;
  permissionMode: PermissionMode;
  clearChatError: () => void;
  clearSessionStreamError: (sessionId: string) => void;
  clearProviderModelsError: () => void;
  hydrateWorkspace: (snapshot: WorkspaceSnapshot) => void;
  toggleProjectExpanded: (projectId: string) => void;
  createSession: (projectId: string) => void;
  renameDraftSession: (projectId: string, title: string) => void;
  deleteDraftSession: (projectId: string) => void;
  renameSession: (projectId: string, sessionId: string, title: string) => Promise<void>;
  deleteSession: (projectId: string, sessionId: string) => Promise<void>;
  selectSession: (projectId: string, sessionId: string) => void;
  openFile: (fileId: string) => void;
  closeFile: (fileId: string) => void;
  toggleSidebar: () => void;
  toggleFilePanel: () => void;
  setModelId: (modelId: ModelId) => void;
  setReasoningLevel: (reasoningLevel: string) => void;
  setProviderConfig: (config: { models: ProviderModelInfo[]; providers: ProviderInfo[] }) => void;
  setPermissionMode: (permissionMode: PermissionMode) => void;
  requestToolApproval: (request: ToolApprovalRequest) => Promise<boolean>;
  resolveToolApproval: (approved: boolean, toolCallId?: string) => void;
  startMessageEdit: (edit: MessageEditState) => void;
  cancelMessageEdit: () => void;
  interruptPrompt: () => Promise<void>;
  sendPrompt: (
    prompt: string,
    attachments?: PreviewFile[],
    options?: { projectId?: string; sessionId?: string },
  ) => Promise<SubmitPromptResult>;
}

const DRAFT_SESSION_TITLE = "New session";
const SESSION_TITLE_MAX_LENGTH = 48;
const STREAM_FLUSH_INTERVAL_MS = 64;
const STREAM_PERSIST_INTERVAL_MS = 750;
const STREAM_PERSIST_CHAR_THRESHOLD = 2_000;
const MAX_PROMPT_SIZE = resolvePromptMaxChars();

type PendingToolApprovalResolution = {
  approved: boolean;
  interrupted: boolean;
};

type PendingToolApprovalResolver = {
  resolve: (resolution: PendingToolApprovalResolution) => void;
  sessionId: string;
  toolCallId: string;
};

type SubmitPromptResult =
  | { ok: true; accepted: true; turnId: string }
  | { ok: false; accepted: false; error: string; retryable?: boolean }
  | { ok: false; accepted: true; turnId: string; error: string };

/** Resolvers live for the whole wait; not cleared on session switch (#26). */
const pendingToolApprovalResolversBySessionId = new Map<string, PendingToolApprovalResolver>();
const activeRunRequestIdsBySession = new Map<string, string>();

function requestComposerQueueDrain(sessionId: string) {
  if (!sessionId) {
    return;
  }

  queueMicrotask(() => {
    void drainComposerSessionQueue(sessionId, {
      isSessionSending: (id) =>
        useWorkspaceStore.getState().sendingSessionIds.includes(id),
      resolveProjectIdForSession: (id) => {
        const state = useWorkspaceStore.getState();
        for (const project of state.projects) {
          if (project.sessions.some((session) => session.id === id)) {
            return project.id;
          }
        }
        return null;
      },
      sendPrompt: (prompt, attachments, options) =>
        useWorkspaceStore.getState().sendPrompt(prompt, attachments, options),
    });
  });
}

function withSendingSessionState(
  selectedSessionId: string | null,
  sendingSessionIds: string[],
) {
  return {
    isSendingMessage: resolveIsSendingMessage(selectedSessionId, sendingSessionIds),
    sendingSessionIds,
  };
}

function resolvePendingApprovalForSelection(
  selectedSessionId: string | null,
  pendingToolApprovalsBySessionId: Record<string, ToolApprovalRequest>,
) {
  if (!selectedSessionId) {
    return null;
  }

  return pendingToolApprovalsBySessionId[selectedSessionId] ?? null;
}

function withPendingApprovalsState(
  selectedSessionId: string | null,
  pendingToolApprovalsBySessionId: Record<string, ToolApprovalRequest>,
) {
  return {
    pendingToolApproval: resolvePendingApprovalForSelection(
      selectedSessionId,
      pendingToolApprovalsBySessionId,
    ),
    pendingToolApprovalsBySessionId,
  };
}

function rejectPendingToolApprovalForSession(sessionId: string, interrupted = false) {
  const resolver = pendingToolApprovalResolversBySessionId.get(sessionId);
  if (!resolver) {
    return;
  }

  pendingToolApprovalResolversBySessionId.delete(sessionId);
  resolver.resolve({
    approved: false,
    interrupted,
  });
}

function rejectAllPendingToolApprovals(interrupted = false) {
  const sessionIds = Array.from(pendingToolApprovalResolversBySessionId.keys());
  for (const sessionId of sessionIds) {
    rejectPendingToolApprovalForSession(sessionId, interrupted);
  }
}

/** Interrupt every in-flight run and pending approval (app close / restart). */
export async function interruptAllWorkspaceRunsForShutdown() {
  const state = useWorkspaceStore.getState();
  rejectAllPendingToolApprovals(true);

  const sessionIds = Array.from(
    new Set([
      ...state.sendingSessionIds,
      ...Object.keys(state.pendingToolApprovalsBySessionId),
    ]),
  );

  setWorkspacePendingApprovalsCleared();

  await Promise.all(
    sessionIds.map((sessionId) =>
      interruptWorkspaceChat({ sessionId }).catch(() => undefined),
    ),
  );
}

function setWorkspacePendingApprovalsCleared() {
  useWorkspaceStore.setState((state) => ({
    ...withPendingApprovalsState(state.selectedSessionId, {}),
  }));
}

function nowLabel() {
  return "now";
}

function buildDraftSession(projectId: string): Session {
  const timestamp = Date.now();

  return {
    createdAtMs: timestamp,
    id: `draft-${projectId}`,
    messagesLoaded: true,
    messages: [],
    replayTurnSummaries: [],
    title: DRAFT_SESSION_TITLE,
    updatedAtLabel: nowLabel(),
    updatedAtMs: timestamp,
  };
}

function createAttachmentFallback(attachments: PreviewFile[]) {
  return attachments.length === 1 ? "Attached 1 file." : `Attached ${attachments.length} files.`;
}

function createAttachmentTitle(attachments: PreviewFile[]) {
  if (attachments.length === 0) {
    return DRAFT_SESSION_TITLE;
  }

  if (attachments.length === 1) {
    return attachments[0]?.name || DRAFT_SESSION_TITLE;
  }

  return `${attachments[0]?.name || "Files"} +${attachments.length - 1}`;
}

function deriveSessionTitle(prompt: string, attachments: PreviewFile[]) {
  const normalizedPrompt = prompt.replace(/\s+/g, " ").trim();

  if (!normalizedPrompt) {
    return createAttachmentTitle(attachments);
  }

  if (normalizedPrompt.length <= SESSION_TITLE_MAX_LENGTH) {
    return normalizedPrompt;
  }

  return `${normalizedPrompt.slice(0, SESSION_TITLE_MAX_LENGTH).trimEnd()}…`;
}

function normalizeGeneratedSessionTitle(title: string, fallbackTitle: string) {
  const normalizedTitle = title
    .split("\n")[0]
    ?.replace(/^title\s*:\s*/i, "")
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedTitle) {
    return fallbackTitle;
  }

  if (normalizedTitle.length <= SESSION_TITLE_MAX_LENGTH) {
    return normalizedTitle;
  }

  return `${normalizedTitle.slice(0, SESSION_TITLE_MAX_LENGTH).trimEnd()}…`;
}

function createUserMessage(
  prompt: string,
  attachments: PreviewFile[],
  options?: {
    editedAtMs?: number;
  },
): Message {
  const createdAtMs = Date.now();
  const normalizedPrompt = prompt.trim();
  const turnId = `turn-${crypto.randomUUID()}`;

  return {
    content: normalizedPrompt || createAttachmentFallback(attachments),
    createdAtLabel: formatExactMessageTimestamp(createdAtMs),
    createdAtMs,
    editedAtMs: options?.editedAtMs,
    id: `message-user-${crypto.randomUUID()}`,
    isStored: false,
    linkedFileIds: attachments.map((attachment) => attachment.id),
    role: "user",
    status: "done",
    toolCalls: [],
    toolResults: [],
    turnId,
  };
}

function createMessagePartId(messageId: string, kind: MessagePart["type"]) {
  return `${messageId}-${kind}-${crypto.randomUUID()}`;
}

function upsertStreamingPart(
  message: Message,
  part: MessagePart,
  chunkText: string,
) {
  const existingPart = message.parts?.find((entry) => entry.id === part.id);

  if (!existingPart) {
    return appendMessagePart(message.parts, {
      ...part,
      content: chunkText,
    });
  }

  return updateMatchingMessagePart(message.parts, (entry) => entry.id === part.id, (entry) => ({
    ...entry,
    content: `${entry.content ?? ""}${chunkText}`,
    status: part.status ?? entry.status,
  }));
}

function upsertSessionMessage(messages: Message[], message: Message) {
  const existingIndex = messages.findIndex((entry) => entry.id === message.id);

  if (existingIndex < 0) {
    messages.push(message);
    return;
  }

  const existingMessage = messages[existingIndex]!;
  messages[existingIndex] = {
    ...message,
    createdAtLabel: existingMessage.createdAtLabel || message.createdAtLabel,
    createdAtMs: existingMessage.createdAtMs ?? message.createdAtMs,
    startedAtMs: existingMessage.startedAtMs ?? message.startedAtMs,
  };
}

function upsertTurnSummary(
  turnSummaries: PersistedTurnSummaryRecord[] | undefined,
  nextSummary: PersistedTurnSummaryRecord,
) {
  const nextTurnSummaries = [...(turnSummaries ?? [])];
  const existingIndex = nextTurnSummaries.findIndex((summary) => summary.turnId === nextSummary.turnId);

  if (existingIndex < 0) {
    nextTurnSummaries.push(nextSummary);
    nextTurnSummaries.sort((left, right) => left.completedAtMs - right.completedAtMs);
    return nextTurnSummaries;
  }

  nextTurnSummaries[existingIndex] = nextSummary;
  return nextTurnSummaries;
}

function mergePreviewFiles(existing: PreviewFile[], incoming: PreviewFile[]) {
  const map = new Map(existing.map((file) => [file.id, file] as const));

  for (const file of incoming) {
    map.set(file.id, file);
  }

  return Array.from(map.values());
}

function mergeLinkedFileIds(...groups: Array<string[] | undefined>) {
  const mergedIds = new Set<string>();

  for (const group of groups) {
    for (const id of group ?? []) {
      mergedIds.add(id);
    }
  }

  return Array.from(mergedIds);
}

function getTurnMessageRange(messages: Message[], target: Pick<MessageEditState, "messageId" | "turnId">) {
  const messageIndex = messages.findIndex((message) => message.id === target.messageId);

  if (messageIndex < 0) {
    return null;
  }

  if (target.turnId) {
    return {
      end: messages.length,
      start: messages.findIndex((message) => message.turnId === target.turnId),
    };
  }

  return {
    end: messages.length,
    start: messageIndex,
  };
}

function replaceEditedTurnMessages(
  session: Session,
  target: Pick<MessageEditState, "messageId" | "turnId">,
  nextUserMessage: Message,
) {
  const turnRange = getTurnMessageRange(session.messages, target);

  if (!turnRange || turnRange.start < 0) {
    return false;
  }

  session.messages = [
    ...session.messages.slice(0, turnRange.start),
    nextUserMessage,
  ];

  if (target.turnId) {
    session.replayTurnSummaries = (session.replayTurnSummaries ?? []).filter(
      (summary) => summary.turnId !== target.turnId,
    );
  }

  return true;
}

function collectDraftPreviewIds(draftSessions: Record<string, Session>) {
  const ids = new Set<string>();

  for (const session of Object.values(draftSessions)) {
    for (const message of session.messages) {
      for (const fileId of message.linkedFileIds ?? []) {
        ids.add(fileId);
      }
    }
  }

  return ids;
}

function mergeHydratedPreviewFiles(
  snapshotPreviewFiles: PreviewFile[],
  existingPreviewFiles: PreviewFile[],
  draftSessions: Record<string, Session>,
) {
  const draftPreviewIds = collectDraftPreviewIds(draftSessions);
  return mergePreviewFiles(
    snapshotPreviewFiles,
    existingPreviewFiles.filter((file) => draftPreviewIds.has(file.id)),
  );
}

function resolvePersistedSession(projects: Project[], projectId: string, sessionId: string) {
  return projects
    .find((project) => project.id === projectId)
    ?.sessions.find((session) => session.id === sessionId);
}

function isDraftSessionSelection(state: WorkspaceState) {
  const draftSession = state.draftSessions[state.selectedProjectId];
  return draftSession?.id === state.selectedSessionId;
}

function applyWorkspaceSnapshotToState(
  state: WorkspaceState,
  snapshot: WorkspaceSnapshot,
): Partial<WorkspaceState> {
  const nextDraftSessions = state.hasHydratedWorkspace
    ? Object.fromEntries(
        Object.entries(state.draftSessions).filter(([projectId]) =>
          snapshot.projects.some((project) => project.id === projectId),
        ),
      )
    : {};

  const selectedProjectId = snapshot.selectedProjectId;
  const projects = snapshot.projects.map((project) => {
    const currentProject = state.projects.find((p) => p.id === project.id);
    return currentProject
      ? { ...project, isExpanded: currentProject.isExpanded }
      : project;
  });
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  // #74: project selected + session null/stale → draft if any, else latest session.
  const selectedSessionId = resolveHydratedSessionSelection({
    draftSessionId: selectedProjectId
      ? nextDraftSessions[selectedProjectId]?.id ?? null
      : null,
    projectSessions: selectedProject?.sessions ?? [],
    selectedSessionId: snapshot.selectedSessionId,
  });

  return {
    activeFileId: null,
    draftSessions: nextDraftSessions,
    hasHydratedWorkspace: true,
    isFilePanelOpen: snapshot.isFilePanelOpen,
    isSidebarOpen: snapshot.isSidebarOpen,
    loadingSessionId: null,
    modelId: snapshot.modelId,
    openedFileIds: [],
    permissionMode: snapshot.permissionMode,
    previewFiles: mergeHydratedPreviewFiles(snapshot.previewFiles, state.previewFiles, nextDraftSessions),
    projects,
    selectedProjectId,
    selectedSessionId,
  };
}

function updatePersistedSession(
  projects: Project[],
  projectId: string,
  sessionId: string,
  updater: (session: Session) => void,
) {
  const projectIndex = projects.findIndex((entry) => entry.id === projectId);

  if (projectIndex < 0) {
    return null;
  }

  const project = projects[projectIndex]!;
  const sessionIndex = project.sessions.findIndex((entry) => entry.id === sessionId);

  if (sessionIndex < 0) {
    return null;
  }

  const nextProjects = [...projects];
  const nextProject = { ...project, sessions: [...project.sessions] };
  const nextSession = structuredClone(project.sessions[sessionIndex]!);

  updater(nextSession);
  nextProject.sessions[sessionIndex] = nextSession;
  nextProject.isExpanded = true;
  nextProject.updatedAtMs = Date.now();
  nextProjects[projectIndex] = nextProject;

  return nextProjects;
}

function replacePersistedSession(
  projects: Project[],
  projectId: string,
  sessionId: string,
  nextSession: Session,
) {
  const projectIndex = projects.findIndex((entry) => entry.id === projectId);

  if (projectIndex < 0) {
    return null;
  }

  const project = projects[projectIndex]!;
  const sessionIndex = project.sessions.findIndex((entry) => entry.id === sessionId);

  if (sessionIndex < 0) {
    return null;
  }

  const nextProjects = [...projects];
  const nextProject = { ...project, sessions: [...project.sessions] };
  nextProject.sessions[sessionIndex] = nextSession;
  nextProjects[projectIndex] = nextProject;

  return nextProjects;
}

function prependPersistedSession(projects: Project[], projectId: string, session: Session) {
  const projectIndex = projects.findIndex((entry) => entry.id === projectId);

  if (projectIndex < 0) {
    return null;
  }

  const project = projects[projectIndex]!;
  const timestamp = Date.now();
  const nextProjects = [...projects];
  nextProjects[projectIndex] = {
    ...project,
    isExpanded: true,
    sessions: [session, ...project.sessions],
    updatedAtMs: timestamp,
  };

  return nextProjects;
}

async function persistWorkspaceSettingsForCurrentState() {
  const state = useWorkspaceStore.getState();
  const selectedSessionId = isDraftSessionSelection(state) ? null : state.selectedSessionId;

  await saveWorkspaceSettings({
    isFilePanelOpen: state.isFilePanelOpen,
    isSidebarOpen: state.isSidebarOpen,
    modelId: state.modelId,
    permissionMode: state.permissionMode,
    selectedProjectId: state.selectedProjectId || null,
    selectedSessionId,
  });
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeMessageEdit: null,
  activeFileId: null,
  chatError: null,
  draftSessions: {},
  hasHydratedWorkspace: false,
  isFilePanelOpen: true,
  isSendingMessage: false,
  sendingSessionIds: [],
  sessionContextStatus: {},
  sessionStreamErrors: {},
  isSidebarOpen: true,
  loadingSessionId: null,
  modelId: "",
  openedFileIds: [],
  pendingToolApproval: null,
  pendingToolApprovalsBySessionId: {},
  permissionMode: "manual-approve",
  reasoningLevel: "",
  previewFiles: [],
  projects: [],
  providerModels: [],
  providerModelsError: null,
  providers: [],
  selectedProjectId: "",
  selectedSessionId: null,
  clearChatError: () => set({ chatError: null }),
  clearSessionStreamError: (sessionId) =>
    set((state) => ({
      sessionStreamErrors: clearSessionStreamErrorMap(state.sessionStreamErrors, sessionId),
    })),
  hydrateWorkspace: (snapshot) => {
    const currentState = useWorkspaceStore.getState();
    const didChangeWorkspaceContext =
      currentState.selectedProjectId !== snapshot.selectedProjectId ||
      currentState.selectedSessionId !== snapshot.selectedSessionId;

    // Fresh process / hydrate: in-memory approval waiters are dead — treat as interrupted.
    rejectAllPendingToolApprovals(true);

    const appliedPreview = applyWorkspaceSnapshotToState(currentState, snapshot);
    const repairedSessionId = appliedPreview.selectedSessionId ?? null;

    set((state) => {
      const applied = applyWorkspaceSnapshotToState(state, snapshot);
      const nextSelectedSessionId = applied.selectedSessionId ?? null;
      return {
        ...state,
        ...applied,
        activeMessageEdit: didChangeWorkspaceContext ? null : state.activeMessageEdit,
        chatError: didChangeWorkspaceContext ? null : state.chatError,
        ...withPendingApprovalsState(nextSelectedSessionId, {}),
      };
    });

    // Persist repaired half-null selection so the next cold start stays consistent (#74).
    if (repairedSessionId && repairedSessionId !== snapshot.selectedSessionId) {
      window.setTimeout(() => {
        void persistWorkspaceSettingsForCurrentState().catch(() => undefined);
      }, 0);
    }
  },
  toggleProjectExpanded: (projectId) =>
    set((state) => {
      const nextProjects = state.projects.map((project) =>
        project.id === projectId ? { ...project, isExpanded: !project.isExpanded } : project,
      );
      const nextProject = nextProjects.find((project) => project.id === projectId);

      if (nextProject) {
        void setProjectExpanded(projectId, nextProject.isExpanded).catch(() => undefined);
      }

      return { projects: nextProjects };
    }),
  createSession: (projectId) =>
    set((state) => {
      const nextDraftSessions = { ...state.draftSessions };

      if (!nextDraftSessions[projectId]) {
        nextDraftSessions[projectId] = buildDraftSession(projectId);
      }

      const nextProjects = state.projects.map((project) =>
        project.id === projectId ? { ...project, isExpanded: true } : project,
      );

      window.setTimeout(() => {
        void persistWorkspaceSettingsForCurrentState().catch(() => undefined);
      }, 0);

      return {
        activeMessageEdit: null,
        draftSessions: nextDraftSessions,
        projects: nextProjects,
        selectedProjectId: projectId,
        selectedSessionId: nextDraftSessions[projectId]?.id ?? null,
      };
    }),
  renameDraftSession: (projectId, title) =>
    set((state) => {
      const normalizedTitle = title.trim();

      if (!normalizedTitle) {
        return state;
      }

      const draftSession = state.draftSessions[projectId];

      if (!draftSession) {
        return state;
      }

      const nextDraftSessions = {
        ...state.draftSessions,
        [projectId]: {
          ...draftSession,
          title: normalizedTitle,
          updatedAtLabel: nowLabel(),
          updatedAtMs: Date.now(),
        },
      };

      window.setTimeout(() => {
        void persistWorkspaceSettingsForCurrentState().catch(() => undefined);
      }, 0);

      return {
        draftSessions: nextDraftSessions,
      };
    }),
  deleteDraftSession: (projectId) =>
    set((state) => {
      const draftSession = state.draftSessions[projectId];

      if (!draftSession) {
        return state;
      }

      const nextDraftSessions = { ...state.draftSessions };
      delete nextDraftSessions[projectId];

      const isSelectedDraft =
        state.selectedProjectId === projectId && state.selectedSessionId === draftSession.id;

      window.setTimeout(() => {
        void persistWorkspaceSettingsForCurrentState().catch(() => undefined);
      }, 0);

      return {
        draftSessions: nextDraftSessions,
        selectedSessionId: isSelectedDraft ? null : state.selectedSessionId,
      };
    }),
  renameSession: async (projectId, sessionId, title) => {
    const normalizedTitle = title.trim();

    if (!normalizedTitle) {
      return;
    }

    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions:
          project.id === projectId
            ? project.sessions.map((session) =>
                session.id === sessionId ? { ...session, title: normalizedTitle } : session,
              )
            : project.sessions,
      })),
    }));

    const snapshot = await renameWorkspaceSession(projectId, sessionId, normalizedTitle);
    set((state) => ({
      ...state,
      ...applyWorkspaceSnapshotToState(state, snapshot),
    }));
  },
  deleteSession: async (projectId, sessionId) => {
    // Deleting a session interrupts its pending approval / run.
    rejectPendingToolApprovalForSession(sessionId, true);

    const snapshot = await deleteWorkspaceSession(projectId, sessionId);

    set((state) => {
      const snapshotState = applyWorkspaceSnapshotToState(state, snapshot);
      const isDeletedSessionSelected =
        state.selectedProjectId === projectId && state.selectedSessionId === sessionId;
      const nextSelectedSessionId = isDeletedSessionSelected ? null : state.selectedSessionId;
      const sendingSessionIds = removeSendingSessionId(sessionId, state.sendingSessionIds);
      const nextApprovals = { ...state.pendingToolApprovalsBySessionId };
      delete nextApprovals[sessionId];

      return {
        ...state,
        ...snapshotState,
        activeMessageEdit:
          state.activeMessageEdit?.projectId === projectId &&
          state.activeMessageEdit?.sessionId === sessionId
            ? null
            : state.activeMessageEdit,
        selectedProjectId: isDeletedSessionSelected ? projectId : state.selectedProjectId,
        selectedSessionId: nextSelectedSessionId,
        ...withSendingSessionState(nextSelectedSessionId, sendingSessionIds),
        ...withPendingApprovalsState(nextSelectedSessionId, nextApprovals),
      };
    });
  },
  selectSession: (projectId, sessionId) => {
    const currentState = useWorkspaceStore.getState();
    const didChangeSelection =
      currentState.selectedProjectId !== projectId || currentState.selectedSessionId !== sessionId;
    const draftSession = currentState.draftSessions[projectId];
    const isDraftSelection = draftSession?.id === sessionId;
    const persistedSession = isDraftSelection
      ? null
      : resolvePersistedSession(currentState.projects, projectId, sessionId);
    const needsHydration = Boolean(persistedSession && !persistedSession.messagesLoaded);

    // Do NOT reject pending approvals on switch — keep waiters alive and re-show on return (#26/#28).

    set((state) => ({
      activeFileId: didChangeSelection ? null : state.activeFileId,
      activeMessageEdit: didChangeSelection ? null : state.activeMessageEdit,
      chatError: didChangeSelection ? null : state.chatError,
      loadingSessionId: needsHydration ? sessionId : null,
      openedFileIds: didChangeSelection ? [] : state.openedFileIds,
      selectedProjectId: projectId,
      selectedSessionId: sessionId,
      ...withSendingSessionState(sessionId, state.sendingSessionIds),
      ...withPendingApprovalsState(sessionId, state.pendingToolApprovalsBySessionId),
    }));
    // Drain any stranded queue for the session we left and the one we open (#43).
    if (currentState.selectedSessionId && currentState.selectedSessionId !== sessionId) {
      requestComposerQueueDrain(currentState.selectedSessionId);
    }
    requestComposerQueueDrain(sessionId);
    void persistWorkspaceSettingsForCurrentState().catch(() => undefined);

    if (!needsHydration) {
      return;
    }

    void loadWorkspaceSession(projectId, sessionId)
      .then(({ previewFiles, session }) => {
        set((state) => {
          const nextProjects = replacePersistedSession(state.projects, projectId, sessionId, session);

          if (!nextProjects) {
            return state;
          }

          return {
            loadingSessionId:
              state.selectedProjectId === projectId && state.selectedSessionId === sessionId
                ? null
                : state.loadingSessionId,
            previewFiles: mergePreviewFiles(state.previewFiles, previewFiles),
            projects: nextProjects,
          };
        });
      })
      .catch((error) => {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : "Wizzle could not load that session.";

        set((state) =>
          state.selectedProjectId === projectId && state.selectedSessionId === sessionId
            ? {
                chatError: message,
                loadingSessionId: null,
              }
            : state,
        );
      });
  },
  openFile: (fileId) =>
    set((state) => ({
      activeFileId: fileId,
      isFilePanelOpen: true,
      openedFileIds: state.openedFileIds.includes(fileId)
        ? state.openedFileIds
        : [...state.openedFileIds, fileId],
    })),
  closeFile: (fileId) =>
    set((state) => {
      const openedFileIds = state.openedFileIds.filter((entry) => entry !== fileId);
      const activeFileId =
        state.activeFileId === fileId
          ? openedFileIds[openedFileIds.length - 1] ?? null
          : state.activeFileId;

      return {
        activeFileId,
        isFilePanelOpen: openedFileIds.length > 0 && state.isFilePanelOpen,
        openedFileIds,
      };
    }),
  toggleSidebar: () => {
    set((state) => ({ isSidebarOpen: !state.isSidebarOpen }));
    void persistWorkspaceSettingsForCurrentState().catch(() => undefined);
  },
  toggleFilePanel: () => {
    set((state) => ({ isFilePanelOpen: !state.isFilePanelOpen }));
    void persistWorkspaceSettingsForCurrentState().catch(() => undefined);
  },
  setModelId: (modelId) => {
    set((state) => {
      const selectedModel = state.providerModels.find((model) => model.id === modelId);

      return {
        modelId,
        reasoningLevel: selectedModel?.reasoningLevels.includes(state.reasoningLevel)
          ? state.reasoningLevel
          : selectedModel?.reasoningLevels[0] ?? "",
      };
    });
    void persistWorkspaceSettingsForCurrentState().catch(() => undefined);
  },
  setReasoningLevel: (reasoningLevel) => {
    set({ reasoningLevel });
  },
  setProviderConfig: ({ models, providers }) =>
    set((state) => {
      const modelId =
        state.modelId && models.some((model) => model.id === state.modelId)
          ? state.modelId
          : models[0]?.id ?? state.modelId;
      const selectedModel = models.find((model) => model.id === modelId);

      return {
        modelId,
        reasoningLevel: selectedModel?.reasoningLevels.includes(state.reasoningLevel)
          ? state.reasoningLevel
          : selectedModel?.reasoningLevels[0] ?? "",
        providerModels: models,
        providerModelsError: null,
        providers,
      };
    }),
  clearProviderModelsError: () => set({ providerModelsError: null }),
  setPermissionMode: (permissionMode) => {
    set({ permissionMode });
    void persistWorkspaceSettingsForCurrentState().catch(() => undefined);
  },
  requestToolApproval: async (request) => {
    const sessionId = request.sessionId;
    // Replacing an in-session pending approval interrupts the previous wait only.
    rejectPendingToolApprovalForSession(sessionId, true);

    set((state) => {
      const pendingToolApprovalsBySessionId = {
        ...state.pendingToolApprovalsBySessionId,
        [sessionId]: request,
      };
      return withPendingApprovalsState(state.selectedSessionId, pendingToolApprovalsBySessionId);
    });

    const resolution = await new Promise<PendingToolApprovalResolution>((resolve) => {
      pendingToolApprovalResolversBySessionId.set(sessionId, {
        resolve,
        sessionId,
        toolCallId: request.toolCallId,
      });
    });

    set((state) => {
      const pendingToolApprovalsBySessionId = { ...state.pendingToolApprovalsBySessionId };
      const current = pendingToolApprovalsBySessionId[sessionId];
      if (current?.toolCallId === request.toolCallId) {
        delete pendingToolApprovalsBySessionId[sessionId];
      }
      return withPendingApprovalsState(state.selectedSessionId, pendingToolApprovalsBySessionId);
    });

    if (resolution.interrupted) {
      throw new Error(INTERRUPTED_WORKSPACE_CHAT_ERROR);
    }

    return resolution.approved;
  },
  resolveToolApproval: (approved, toolCallId) => {
    const state = useWorkspaceStore.getState();
    const selectedSessionId = state.selectedSessionId;
    if (!selectedSessionId) {
      return;
    }

    const pendingToolApproval = state.pendingToolApprovalsBySessionId[selectedSessionId] ?? null;
    const resolver = pendingToolApprovalResolversBySessionId.get(selectedSessionId);

    if (!resolver || !pendingToolApproval) {
      return;
    }

    if (toolCallId && pendingToolApproval.toolCallId !== toolCallId) {
      frontendLogger.info("frontend.workspace", "stale_tool_approval_resolution_ignored", {
        approved,
        pendingToolCallIdLength: pendingToolApproval.toolCallId.length,
        resolvedToolCallIdLength: toolCallId.length,
      });
      return;
    }

    pendingToolApprovalResolversBySessionId.delete(selectedSessionId);
    set((current) => {
      const pendingToolApprovalsBySessionId = { ...current.pendingToolApprovalsBySessionId };
      delete pendingToolApprovalsBySessionId[selectedSessionId];
      return withPendingApprovalsState(current.selectedSessionId, pendingToolApprovalsBySessionId);
    });
    resolver.resolve({
      approved,
      interrupted: false,
    });
  },
  startMessageEdit: (edit) =>
    set((state) => {
      const session = resolvePersistedSession(state.projects, edit.projectId, edit.sessionId);

      if (
        !session ||
        state.selectedProjectId !== edit.projectId ||
        state.selectedSessionId !== edit.sessionId ||
        state.isSendingMessage
      ) {
        return state;
      }

      const latestUserMessage = [...session.messages]
        .reverse()
        .find((message) => message.role === "user");

      if (
        !latestUserMessage ||
        latestUserMessage.id !== edit.messageId ||
        latestUserMessage.isStored === false
      ) {
        return state;
      }

      const turnRange = getTurnMessageRange(session.messages, edit);

      if (!turnRange) {
        return state;
      }

      const turnMessages = session.messages.slice(turnRange.start, turnRange.end);

      if (turnMessages.some((message) => message.status === "streaming")) {
        return state;
      }

      return {
        activeMessageEdit: edit,
        chatError: null,
      };
    }),
  cancelMessageEdit: () => set({ activeMessageEdit: null }),
  interruptPrompt: async () => {
    const state = useWorkspaceStore.getState();
    const sessionId = state.selectedSessionId;

    // Only interrupt the selected session's run (#27 / #46).
    if (!sessionId || !state.sendingSessionIds.includes(sessionId)) {
      return;
    }

    rejectPendingToolApprovalForSession(sessionId, true);
    set((current) => {
      const pendingToolApprovalsBySessionId = { ...current.pendingToolApprovalsBySessionId };
      delete pendingToolApprovalsBySessionId[sessionId];
      return withPendingApprovalsState(current.selectedSessionId, pendingToolApprovalsBySessionId);
    });
    await interruptWorkspaceChat({ sessionId });
  },
  sendPrompt: async (prompt, attachments = [], options) => {
    const initialState = useWorkspaceStore.getState();
    const content = prompt.trim();
    // Allow queue drain for a non-selected session (#43).
    let targetProjectId = options?.projectId ?? initialState.selectedProjectId;
    let targetSessionId = options?.sessionId ?? initialState.selectedSessionId;

    if (options?.sessionId && !options.projectId) {
      for (const project of initialState.projects) {
        if (project.sessions.some((session) => session.id === options.sessionId)) {
          targetProjectId = project.id;
          break;
        }
      }
    }

    // Block only if *this* session is already running (#27). Other sessions can send.
    if (
      (targetSessionId && initialState.sendingSessionIds.includes(targetSessionId)) ||
      (!content && attachments.length === 0)
    ) {
      return { accepted: false, error: "The chat is not ready for another message.", ok: false };
    }

    if (isPromptOverLimit(content, MAX_PROMPT_SIZE)) {
      const error = formatPromptTooLargeError(MAX_PROMPT_SIZE);
      set({
        chatError: error,
      });
      return { accepted: false, error, ok: false };
    }

    if (!targetProjectId) {
      const error = "Choose a project before sending a message.";
      set({ chatError: error });
      return { accepted: false, error, ok: false };
    }

    if (!initialState.modelId || !initialState.providerModels.some((model) => model.id === initialState.modelId)) {
      const error = "Choose a provider model before sending a message.";
      set({ chatError: error });
      return { accepted: false, error, ok: false };
    }
    const initialProviderModel =
      initialState.providerModels.find((model) => model.id === initialState.modelId) ?? null;
    const initialProvider = initialState.providers.find(
      (provider) => provider.id === initialProviderModel?.providerId,
    );
    const initialTokenizer = resolveEffectiveTokenizer(initialProviderModel, initialProvider);

    const imageAttachmentError = resolveImageAttachmentHardFailError(
      initialProviderModel?.capabilities,
      attachments,
    );
    if (imageAttachmentError) {
      set({ chatError: imageAttachmentError });
      return { accepted: false, error: imageAttachmentError, ok: false };
    }

    if (initialState.loadingSessionId && initialState.loadingSessionId === targetSessionId) {
      const error = "Wait for the selected session to finish loading.";
      set({ chatError: error });
      return { accepted: false, error, ok: false };
    }

    const activeMessageEdit =
      initialState.activeMessageEdit &&
      initialState.activeMessageEdit.projectId === targetProjectId &&
      initialState.activeMessageEdit.sessionId === targetSessionId
        ? initialState.activeMessageEdit
        : null;
    const userMessage = createUserMessage(content, attachments, {
      editedAtMs: activeMessageEdit ? Date.now() : undefined,
    });
    const turnId = userMessage.turnId ?? `turn-${crypto.randomUUID()}`;
    const nextPreviewFiles = mergePreviewFiles(initialState.previewFiles, attachments);
    const draftSession = initialState.draftSessions[targetProjectId];
    const isDraftSelection = draftSession?.id === targetSessionId;
    const rollbackState = {
      activeMessageEdit: initialState.activeMessageEdit,
      draftSessions: initialState.draftSessions,
      previewFiles: initialState.previewFiles,
      projects: initialState.projects,
      selectedProjectId: initialState.selectedProjectId,
      selectedSessionId: initialState.selectedSessionId,
    };
    frontendLogger.info("frontend.workspace", "send_prompt_started", {
      attachmentCount: attachments.length,
      isEditingMessage: Boolean(activeMessageEdit),
      isDraftSelection,
      promptLength: content.length,
      selectedProjectIdLength: targetProjectId.length,
      selectedSessionPresent: Boolean(targetSessionId),
      turnIdLength: turnId.length,
    });

    let shouldGenerateTitle = false;
    let fallbackTitle = deriveSessionTitle(content, attachments);

    if (isDraftSelection && draftSession) {
      const draftSessionId = draftSession.id;
      targetSessionId = `session-${crypto.randomUUID()}`;
      shouldGenerateTitle = true;

      set((state) => {
        if (!targetSessionId) {
          return state;
        }

        const timestamp = Date.now();
        const nextProjects = prependPersistedSession(state.projects, targetProjectId, {
          createdAtMs: timestamp,
          id: targetSessionId,
          messages: [userMessage],
          messagesLoaded: true,
          modelId: state.modelId,
          permissionMode: state.permissionMode,
          replayTurnSummaries: [],
          title: fallbackTitle,
          updatedAtLabel: nowLabel(),
          updatedAtMs: timestamp,
        });

        if (!nextProjects) {
          return state;
        }

        const nextDraftSessions = { ...state.draftSessions };
        delete nextDraftSessions[targetProjectId];

        const sendingSessionIds = addSendingSessionId(targetSessionId, state.sendingSessionIds);
        // #19 C: new send clears prior stream-step error under the bubble.
        let sessionStreamErrors = clearSessionStreamErrorMap(
          state.sessionStreamErrors,
          draftSessionId,
        );
        sessionStreamErrors = clearSessionStreamErrorMap(sessionStreamErrors, targetSessionId);

        return {
          chatError: null,
          draftSessions: nextDraftSessions,
          previewFiles: nextPreviewFiles,
          projects: nextProjects,
          selectedProjectId: targetProjectId,
          selectedSessionId: targetSessionId,
          sessionStreamErrors,
          ...withSendingSessionState(targetSessionId, sendingSessionIds),
        };
      });
      // #45: rekey immediately (sync) so Composer session switch does not drop the queue.
      rekeyComposerSessionQueue(draftSessionId, targetSessionId);
      void migrateComposerSessionQueue(draftSessionId, targetSessionId).catch(() => undefined);
      frontendLogger.info("frontend.workspace", "draft_session_promoted", {
        sessionIdLength: targetSessionId.length,
        turnIdLength: turnId.length,
      });
    } else {
      if (!targetSessionId) {
        const error = "Choose or create a session before sending a message.";
        set({ chatError: error });
        return { accepted: false, error, ok: false };
      }

      const existingSession = resolvePersistedSession(
        initialState.projects,
        targetProjectId,
        targetSessionId,
      );

      if (!existingSession) {
        const error = "Could not resolve the active chat.";
        set({ chatError: error });
        return { accepted: false, error, ok: false };
      }

      if (activeMessageEdit) {
        const turnRange = getTurnMessageRange(existingSession.messages, activeMessageEdit);

        if (!turnRange) {
          const error = "That message can no longer be edited.";
          set({
            activeMessageEdit: null,
            chatError: error,
          });
          return { accepted: false, error, ok: false };
        }
      }

      set((state) => {
        const nextProjects = updatePersistedSession(
          state.projects,
          targetProjectId,
          targetSessionId as string,
          (session) => {
            const timestamp = Date.now();
            if (activeMessageEdit) {
              replaceEditedTurnMessages(session, activeMessageEdit, userMessage);
            } else {
              session.messages.push(userMessage);
            }
            session.modelId = state.modelId;
            session.permissionMode = state.permissionMode;
            session.updatedAtLabel = nowLabel();
            session.updatedAtMs = timestamp;
          },
        );

        if (!nextProjects) {
          return state;
        }

        const sendingSessionIds = addSendingSessionId(
          targetSessionId as string,
          state.sendingSessionIds,
        );

        return {
          activeMessageEdit: null,
          chatError: null,
          previewFiles: nextPreviewFiles,
          projects: nextProjects,
          // #19 C: new send hides prior stream-step error under the bubble.
          sessionStreamErrors: clearSessionStreamErrorMap(
            state.sessionStreamErrors,
            targetSessionId as string,
          ),
          ...withSendingSessionState(state.selectedSessionId, sendingSessionIds),
        };
      });
      frontendLogger.info(
        "frontend.workspace",
        activeMessageEdit ? "message_replaced_in_session" : "message_appended_to_session",
        {
          sessionIdLength: targetSessionId.length,
          turnIdLength: turnId.length,
        },
      );
    }

    if (!targetProjectId || !targetSessionId) {
      const error = "Could not resolve the active chat.";
      set((state) => ({
        chatError: error,
        ...withSendingSessionState(state.selectedSessionId, state.sendingSessionIds),
      }));
      return { accepted: false, error, ok: false };
    }

    const targetProjectRoot =
      initialState.projects.find((project) => project.id === targetProjectId)?.rootPath ?? "";

    let didBeginRuntimeRun = false;
    try {
      await beginSessionRun(targetSessionId);
      didBeginRuntimeRun = true;
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message
          : "That session already has an active run.";
      const retryable = isSessionAlreadyRunningError(error) || isSessionAlreadyRunningError(message);
      set((state) => ({
        ...rollbackState,
        // Retryable coalesce: do not sticky-error the chat; queue will re-drain on wake (#29).
        chatError: retryable ? state.chatError : message,
        ...withSendingSessionState(
          rollbackState.selectedSessionId,
          removeSendingSessionId(targetSessionId, state.sendingSessionIds),
        ),
      }));
      return { accepted: false, error: message, ok: false, retryable };
    }
    const runRequestId = crypto.randomUUID();
    activeRunRequestIdsBySession.set(targetSessionId, runRequestId);
    const isActiveRunRequest = () => activeRunRequestIdsBySession.get(targetSessionId as string) === runRequestId;

    try {
      const currentPersistState = useWorkspaceStore.getState();
      const sessionToPersist = resolvePersistedSession(
        currentPersistState.projects,
        targetProjectId,
        targetSessionId,
      );

      if (!sessionToPersist) {
        throw new Error("Could not find the session to save.");
      }

      if (shouldGenerateTitle) {
        await createSessionIfNeeded({
          projectId: targetProjectId,
          selectedProjectId: targetProjectId,
          selectedSessionId: targetSessionId,
          session: sessionToPersist,
        });
      } else {
        await updateSessionSelection({
          permissionMode: sessionToPersist.permissionMode ?? currentPersistState.permissionMode,
          projectId: targetProjectId,
          selectedModelUuid: sessionToPersist.selectedModelUuid ?? currentPersistState.modelId,
          sessionId: targetSessionId,
          tokenizerKind: initialTokenizer.kind,
        });
      }
      // Edit: make SQL match in-memory truncation before the agent runs (#3/#57).
      if (activeMessageEdit) {
        const keepTurnIds = collectRetainedTurnIds(sessionToPersist.messages);
        const deletedTurnCount = await truncateSessionTranscriptToTurns({
          keepTurnIds,
          sessionId: targetSessionId,
        });
        const retained = new Set(keepTurnIds);
        set((state) => {
          const nextProjects = updatePersistedSession(
            state.projects,
            targetProjectId,
            targetSessionId as string,
            (session) => {
              if (session.compactedContext?.compactedTurnIds?.length) {
                session.compactedContext = {
                  ...session.compactedContext,
                  compactedTurnIds: filterCompactedTurnIds(
                    session.compactedContext.compactedTurnIds,
                    retained,
                  ),
                };
              }
            },
          );
          return nextProjects ? { projects: nextProjects } : state;
        });
        frontendLogger.info("frontend.workspace", "session_transcript_truncated_for_edit", {
          deletedTurnCount,
          keepTurnCount: keepTurnIds.length,
          sessionIdLength: targetSessionId.length,
        });
      }

      await appendOrUpdateMessage({
        message: userMessage,
        previewFiles: nextPreviewFiles,
        projectId: targetProjectId,
        sessionId: targetSessionId,
      });
      await persistWorkspaceSettingsForCurrentState();
      set((state) => {
        const nextProjects = updatePersistedSession(
          state.projects,
          targetProjectId,
          targetSessionId as string,
          (session) => {
            const targetMessage = session.messages.find((message) => message.id === userMessage.id);

            if (targetMessage) {
              targetMessage.isStored = true;
            }
          },
        );

        return nextProjects ? { projects: nextProjects } : state;
      });
      frontendLogger.info("frontend.workspace", "session_persisted_before_run", {
        projectIdLength: targetProjectId.length,
        sessionIdLength: targetSessionId.length,
      });
      if (shouldGenerateTitle) {
        void generateWorkspaceSessionTitle({
          attachments,
          chatId: targetSessionId,
          modelId: initialState.modelId,
          projectId: targetProjectId,
          prompt: content,
          reasoningLevels: initialProviderModel?.reasoningLevels,
        })
          .then((generatedTitle) => {
            const nextTitle = normalizeGeneratedSessionTitle(generatedTitle, fallbackTitle);
            set((state) => {
              const nextProjects = updatePersistedSession(
                state.projects,
                targetProjectId,
                targetSessionId as string,
                (session) => {
                  session.title = nextTitle;
                },
              );

              return nextProjects ? { projects: nextProjects } : state;
            });
            return updateSessionTitle({
              sessionId: targetSessionId as string,
              title: nextTitle,
            });
          })
          .catch(() => undefined);
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message
          : "Wizzle could not save the chat.";
      set((state) => ({
        ...rollbackState,
        chatError: message,
        ...withSendingSessionState(
          rollbackState.selectedSessionId,
          removeSendingSessionId(targetSessionId, state.sendingSessionIds),
        ),
      }));
      frontendLogger.error("frontend.workspace", "session_persist_before_run_failed", {
        error,
        projectIdLength: targetProjectId.length,
        sessionIdLength: targetSessionId.length,
      });
      if (didBeginRuntimeRun) {
        didBeginRuntimeRun = false;
        await completeSessionRunFinish({
          finish: () => finishSessionRun(targetSessionId),
          sessionId: targetSessionId,
          wake: wakeSessionRun,
        }).catch(() => undefined);
      }
      activeRunRequestIdsBySession.delete(targetSessionId);
      return { accepted: false, error: message, ok: false };
    }

    let activeAssistantMessageId: string | null = null;
    let bufferedContent = "";
    let flushTimeoutId: number | null = null;
    let toolFlushTimeoutId: number | null = null;
    let durablePersistTimeoutId: number | null = null;
    let durablePersistChars = 0;
    let lastDurablePersistAt = Date.now();
    let durablePersistChain = Promise.resolve();
    /** After settle starts, late stream writes must not race finalize (#4). */
    let turnSettled = false;
    let settledTurnPersistResult: SettledTurnPersistResult | null = null;
    const bufferedToolOutputByCallId = new Map<string, BufferedToolOutput>();
    let activeContentStepId: string | null = null;

    // Soft UI warning for mid-stream save failures; do not abort the turn (#6).
    const durablePersistFailureReporter = createDurablePersistFailureReporter({
      onReport: (message) => {
        set({ chatError: message });
      },
    });

    const handleMidStreamPersistFailure = (error: unknown, reason: string) => {
      if (isTurnAlreadyFinalizedError(error) || turnSettled) {
        return;
      }

      frontendLogger.error("frontend.workspace", "mid_stream_durable_persist_failed", {
        error,
        errorMessage: getErrorMessage(error, "Unknown save error."),
        reason,
        sessionIdLength: targetSessionId.length,
        turnIdLength: turnId.length,
      });
      durablePersistFailureReporter.report(error);
    };

    const persistMessageFromState = async (messageId: string) => {
      if (!isActiveRunRequest() || turnSettled) {
        return;
      }

      const state = useWorkspaceStore.getState();
      const session = resolvePersistedSession(state.projects, targetProjectId, targetSessionId as string);
      const message = session?.messages.find((entry) => entry.id === messageId);

      if (!message || message.turnId !== turnId) {
        return;
      }

      try {
        await appendOrUpdateMessage({
          message,
          previewFiles: state.previewFiles,
          projectId: targetProjectId,
          sessionId: targetSessionId as string,
        });
      } catch (error) {
        if (isTurnAlreadyFinalizedError(error)) {
          frontendLogger.debug("frontend.workspace", "stream_persist_skipped_finalized_turn", {
            messageIdLength: messageId.length,
            sessionIdLength: targetSessionId.length,
            turnIdLength: turnId.length,
          });
          return;
        }

        throw error;
      }
    };

    const collectActiveTurnMessageIds = () => {
      const state = useWorkspaceStore.getState();
      const session = resolvePersistedSession(state.projects, targetProjectId, targetSessionId as string);

      return (session?.messages ?? [])
        .filter((message) => message.turnId === turnId)
        .map((message) => message.id);
    };

    const persistActiveTurnMessages = async () => {
      if (!isActiveRunRequest()) {
        return;
      }

      const state = useWorkspaceStore.getState();
      const session = resolvePersistedSession(state.projects, targetProjectId, targetSessionId as string);

      for (const message of session?.messages ?? []) {
        if (message.turnId !== turnId) {
          continue;
        }

        try {
          await appendOrUpdateMessage({
            message,
            previewFiles: state.previewFiles,
            projectId: targetProjectId,
            sessionId: targetSessionId as string,
          });
        } catch (error) {
          if (isTurnAlreadyFinalizedError(error) || turnSettled) {
            continue;
          }
          handleMidStreamPersistFailure(error, "active_turn_messages");
        }
      }
    };

    const reconcileEditedSessionIfNeeded = async () => {
      if (!activeMessageEdit) {
        return;
      }

      const state = useWorkspaceStore.getState();
      const session = resolvePersistedSession(state.projects, targetProjectId, targetSessionId as string);

      if (!session) {
        return;
      }

      await reconcileEntireSessionForExplicitEditOrRepair({
        previewFiles: state.previewFiles,
        projectId: targetProjectId,
        selectedProjectId: targetProjectId,
        selectedSessionId: targetSessionId as string,
        session,
      });
    };

    const clearPendingFlush = () => {
      if (flushTimeoutId !== null) {
        window.clearTimeout(flushTimeoutId);
        flushTimeoutId = null;
      }
    };

    const clearPendingToolFlush = () => {
      if (toolFlushTimeoutId !== null) {
        window.clearTimeout(toolFlushTimeoutId);
        toolFlushTimeoutId = null;
      }
    };

    const clearPendingDurablePersist = () => {
      if (durablePersistTimeoutId !== null) {
        window.clearTimeout(durablePersistTimeoutId);
        durablePersistTimeoutId = null;
      }
    };

    const runDurablePersist = (reason: string) => {
      if (turnSettled) {
        return;
      }

      clearPendingDurablePersist();
      durablePersistChars = 0;
      lastDurablePersistAt = Date.now();
      durablePersistChain = durablePersistChain
        .catch(() => undefined)
        .then(() => {
          if (turnSettled || !activeAssistantMessageId) {
            return undefined;
          }

          return persistMessageFromState(activeAssistantMessageId);
        })
        .catch((error) => {
          handleMidStreamPersistFailure(error, reason);
        });
    };

    const persistMessageFromStateSoft = (messageId: string, reason: string) => {
      void persistMessageFromState(messageId).catch((error) => {
        handleMidStreamPersistFailure(error, reason);
      });
    };

    const noteDurableStreamProgress = (charCount: number) => {
      if (charCount <= 0) {
        return;
      }

      durablePersistChars += charCount;
      const elapsedMs = Date.now() - lastDurablePersistAt;

      if (
        durablePersistChars >= STREAM_PERSIST_CHAR_THRESHOLD ||
        elapsedMs >= STREAM_PERSIST_INTERVAL_MS
      ) {
        runDurablePersist("threshold");
        return;
      }

      if (durablePersistTimeoutId !== null) {
        return;
      }

      durablePersistTimeoutId = window.setTimeout(() => {
        runDurablePersist("interval");
      }, Math.max(0, STREAM_PERSIST_INTERVAL_MS - elapsedMs));
    };

    const flushBufferedChunks = () => {
      if (!isActiveRunRequest() || turnSettled) {
        bufferedContent = "";
        return;
      }

      if (!activeAssistantMessageId || !bufferedContent) {
        return;
      }

      const contentChunk = bufferedContent;
      const messageId = activeAssistantMessageId;
      bufferedContent = "";

      set((state) => {
        const nextProjects = updatePersistedSession(
          state.projects,
          targetProjectId,
          targetSessionId as string,
          (session) => {
            const targetMessage = session.messages.find((message) => message.id === messageId);

            if (!targetMessage) {
              return;
            }

            if (contentChunk) {
              const contentPartType =
                (targetMessage.toolCalls?.length ?? 0) > 0 ? "activity_content" : "content";
              const contentStepId =
                activeContentStepId ?? createMessagePartId(targetMessage.id, contentPartType);
              activeContentStepId = contentStepId;
              targetMessage.parts = upsertStreamingPart(
                targetMessage,
                {
                  createdAtMs: Date.now(),
                  id: contentStepId,
                  status: "streaming",
                  type: contentPartType,
                },
                contentChunk,
              );
            }

            targetMessage.status = "streaming";
            synchronizeMessageFromParts(targetMessage);
            session.updatedAtLabel = nowLabel();
            session.updatedAtMs = Date.now();
          },
        );

        return nextProjects ? { projects: nextProjects } : state;
      });
      persistMessageFromStateSoft(messageId, "assistant_chunks_flushed");
      noteDurableStreamProgress(contentChunk.length);
      frontendLogger.debug("frontend.workspace", "assistant_chunks_flushed", {
        contentLength: contentChunk.length,
        messageIdLength: messageId.length,
        reasoningLength: 0,
        sessionIdLength: targetSessionId.length,
      });
    };

    const flushBufferedToolChunks = () => {
      if (!isActiveRunRequest() || turnSettled) {
        bufferedToolOutputByCallId.clear();
        return;
      }

      const pendingToolOutputs = Array.from(bufferedToolOutputByCallId.entries());

      if (pendingToolOutputs.length === 0) {
        return;
      }

      bufferedToolOutputByCallId.clear();

      set((state) => {
        const nextProjects = updatePersistedSession(
          state.projects,
          targetProjectId,
          targetSessionId as string,
          (session) => {
            let didUpdateSession = false;

            for (const [toolCallId, buffer] of pendingToolOutputs) {
              const targetMessage = session.messages.find(
                (message) => message.id === `message-tool-${toolCallId}`,
              );

              if (
                !targetMessage ||
                targetMessage.status === "done" ||
                targetMessage.status === "error"
              ) {
                continue;
              }

              const existingPart = targetMessage.parts?.find(
                (part) =>
                  part.type === "tool_result" && (part.toolCallId ?? part.id) === toolCallId,
              );

              targetMessage.parts = appendMessagePart(
                targetMessage.parts,
                {
                  createdAtMs: existingPart?.createdAtMs ?? Date.now(),
                  id: existingPart?.id ?? `${targetMessage.id}-result`,
                  metadata: {
                    ...(existingPart?.metadata ?? {}),
                    status: "running",
                    toolName: targetMessage.toolName,
                  },
                  name: targetMessage.toolName,
                  output: createToolStreamOutput(buffer),
                  parentPartId: existingPart?.parentPartId,
                  status: "running",
                  toolCallId,
                  type: "tool_result",
                },
                (part) =>
                  part.type === "tool_result" && (part.toolCallId ?? part.id) === toolCallId,
              );
              targetMessage.status = "streaming";
              synchronizeMessageFromParts(targetMessage);
              didUpdateSession = true;
            }

            if (!didUpdateSession) {
              return;
            }

            session.updatedAtLabel = nowLabel();
            session.updatedAtMs = Date.now();
          },
        );

        return nextProjects ? { projects: nextProjects } : state;
      });
      void persistActiveTurnMessages().catch((error) => {
        handleMidStreamPersistFailure(error, "tool_chunks_flushed");
      });
      noteDurableStreamProgress(
        pendingToolOutputs.reduce((total, [, buffer]) => total + buffer.combinedOutput.length, 0),
      );
      frontendLogger.debug("frontend.workspace", "tool_chunks_flushed", {
        sessionIdLength: targetSessionId.length,
        toolCount: pendingToolOutputs.length,
      });
    };

    const scheduleChunkFlush = () => {
      if (flushTimeoutId !== null) {
        return;
      }

      flushTimeoutId = window.setTimeout(() => {
        flushTimeoutId = null;
        flushBufferedChunks();
      }, STREAM_FLUSH_INTERVAL_MS);
    };

    const scheduleToolChunkFlush = () => {
      if (toolFlushTimeoutId !== null) {
        return;
      }

      toolFlushTimeoutId = window.setTimeout(() => {
        toolFlushTimeoutId = null;
        flushBufferedToolChunks();
      }, STREAM_FLUSH_INTERVAL_MS);
    };

    const beginAssistantMessage = (message: Message) => {
      if (!isActiveRunRequest()) {
        return;
      }

      clearPendingFlush();
      clearPendingToolFlush();
      flushBufferedChunks();
      flushBufferedToolChunks();
      activeAssistantMessageId = message.id;
      activeContentStepId = null;
      bufferedContent = "";
      set((state) => {
        const nextProjects = updatePersistedSession(
          state.projects,
          targetProjectId,
          targetSessionId as string,
          (session) => {
            session.messages.push(message);
            session.updatedAtLabel = nowLabel();
            session.updatedAtMs = Date.now();
          },
        );

        return nextProjects ? { projects: nextProjects } : state;
      });
      persistMessageFromStateSoft(message.id, "assistant_message_created");
      frontendLogger.info("frontend.workspace", "assistant_message_created", {
        messageIdLength: message.id.length,
        sessionIdLength: targetSessionId.length,
        turnIdLength: turnId.length,
      });
    };

    const finishReasoningStep = (messageId: string) => {
      frontendLogger.debug("frontend.workspace", "assistant_reasoning_finished", {
        messageIdLength: messageId.length,
        reasoningStepIdLength: 0,
        sessionIdLength: targetSessionId.length,
      });
    };

    const finishAssistantStream = (messageId: string, phase: NonNullable<Message["assistantPhase"]>) => {
      if (!isActiveRunRequest()) {
        return;
      }

      clearPendingFlush();
      clearPendingToolFlush();
      flushBufferedChunks();
      flushBufferedToolChunks();
      activeContentStepId = null;

      set((state) => {
        const nextProjects = updatePersistedSession(
          state.projects,
          targetProjectId,
          targetSessionId as string,
          (session) => {
            const targetMessage = session.messages.find((message) => message.id === messageId);

            if (!targetMessage) {
              return;
            }

            const completedAtMs = Date.now();
            targetMessage.assistantPhase = phase;
            targetMessage.completedAtMs = completedAtMs;
            targetMessage.durationMs = targetMessage.startedAtMs
              ? Math.max(0, completedAtMs - targetMessage.startedAtMs)
              : undefined;
            targetMessage.reasoningDurationMs =
              targetMessage.reasoningDurationMs ??
              (targetMessage.startedAtMs
                ? Math.max(0, completedAtMs - targetMessage.startedAtMs)
                : undefined);
            // Content stream is finished; phase "working" still has tool_call parts (#15).
            targetMessage.status = "done";
            targetMessage.parts = (targetMessage.parts ?? []).map((part) => {
              if (
                part.status !== "streaming" ||
                !shouldFinalizeStreamingPartOnAssistantFinish(part.type)
              ) {
                return part;
              }
              return {
                ...part,
                durationMs: part.createdAtMs
                  ? Math.max(0, completedAtMs - part.createdAtMs)
                  : part.durationMs,
                status: "done",
              };
            });
            synchronizeMessageFromParts(targetMessage);
            session.updatedAtLabel = nowLabel();
            session.updatedAtMs = completedAtMs;
          },
        );

        return nextProjects ? { projects: nextProjects } : state;
      });
      persistMessageFromStateSoft(messageId, "assistant_stream_finished");
      frontendLogger.info("frontend.workspace", "assistant_stream_finished", {
        messageIdLength: messageId.length,
        sessionIdLength: targetSessionId.length,
      });
    };

    const syncAssistantToolCalls = (messageId: string, toolCalls: NonNullable<Message["toolCalls"]>) => {
      if (!isActiveRunRequest()) {
        return;
      }

      clearPendingFlush();
      clearPendingToolFlush();
      flushBufferedChunks();
      flushBufferedToolChunks();
      activeContentStepId = null;

      set((state) => {
        const nextProjects = updatePersistedSession(
          state.projects,
          targetProjectId,
          targetSessionId as string,
          (sessionEntry) => {
            const targetMessage = sessionEntry.messages.find((entry) => entry.id === messageId);

            if (!targetMessage) {
              return;
            }

            targetMessage.toolCalls = toolCalls;
            const existingParts = targetMessage.parts ?? [];
            const nonToolCallParts = existingParts.filter((part) => part.type !== "tool_call");
            const normalizedNonToolCallParts = nonToolCallParts.map((part) =>
              part.type === "content"
                ? {
                    ...part,
                    type: "activity_content" as const,
                  }
                : part,
            );
            const nextToolCallParts = toolCalls.map((toolCall) => {
              const existingPart = existingParts.find(
                (part) => part.type === "tool_call" && (part.toolCallId ?? part.id) === toolCall.id,
              );
              const toolCallPartId =
                existingPart?.id ?? `${targetMessage.id}-tool-call-${toolCall.id}`;
              // Parent is the assistant message, never the tool_call itself.
              const parentPartId =
                existingPart?.parentPartId &&
                existingPart.parentPartId !== toolCallPartId
                  ? existingPart.parentPartId
                  : targetMessage.id;

              return {
                createdAtMs: existingPart?.createdAtMs ?? Date.now(),
                id: toolCallPartId,
                input: toolCall.input,
                metadata: {
                  arguments: toolCall.input,
                  projectId: targetProjectId,
                  toolName: toolCall.name,
                },
                name: toolCall.name,
                parentPartId,
                status: toolCall.status,
                toolCallId: toolCall.id,
                type: "tool_call" as const,
              };
            });

            targetMessage.parts = [...normalizedNonToolCallParts, ...nextToolCallParts];
            targetMessage.assistantPhase = "working";
            synchronizeMessageFromParts(targetMessage);
            sessionEntry.updatedAtLabel = nowLabel();
            sessionEntry.updatedAtMs = Date.now();
          },
        );

        return nextProjects ? { projects: nextProjects } : state;
      });
      persistMessageFromStateSoft(messageId, "assistant_tool_calls_synced");
      frontendLogger.info("frontend.workspace", "assistant_tool_calls_synced", {
        messageIdLength: messageId.length,
        sessionIdLength: targetSessionId.length,
        toolCallCount: toolCalls.length,
      });
    };

    const appendToolChunk = (chunk: {
      chunk: string;
      stream: "stderr" | "stdout";
      toolCallId: string;
    }) => {
      if (!isActiveRunRequest()) {
        return;
      }

      const currentBuffer =
        bufferedToolOutputByCallId.get(chunk.toolCallId) ?? createEmptyToolStreamBuffer();
      bufferedToolOutputByCallId.set(
        chunk.toolCallId,
        appendBufferedToolChunk(currentBuffer, chunk.stream, chunk.chunk),
      );
      scheduleToolChunkFlush();
    };

    const appendToolMessage = async (message: Message) => {
      if (!isActiveRunRequest()) {
        return;
      }

      // Capture live stream before flush so interrupt/error can preserve partials (#37).
      const preFlushBuffer = message.toolCallId
        ? bufferedToolOutputByCallId.get(message.toolCallId)
        : undefined;

      clearPendingFlush();
      clearPendingToolFlush();
      flushBufferedChunks();
      flushBufferedToolChunks();
      activeAssistantMessageId = null;
      activeContentStepId = null;
      bufferedContent = "";

      let messageToStore = message;
      if (
        message.toolCallId &&
        (message.status === "interrupted" || message.status === "error")
      ) {
        const state = useWorkspaceStore.getState();
        const existing = resolvePersistedSession(
          state.projects,
          targetProjectId,
          targetSessionId as string,
        )?.messages.find((entry) => entry.id === message.id);
        const existingResult = existing?.parts?.find((part) => part.type === "tool_result");
        const partialSource =
          preFlushBuffer &&
          (preFlushBuffer.truncated ||
            preFlushBuffer.combinedOutput.length > 0 ||
            preFlushBuffer.stdout.length > 0 ||
            preFlushBuffer.stderr.length > 0)
            ? preFlushBuffer
            : (existingResult?.output ?? existing?.content ?? null);
        const hasPartial =
          (typeof partialSource === "string" && partialSource.trim().length > 0) ||
          (partialSource &&
            typeof partialSource === "object" &&
            (partialSource.truncated ||
              partialSource.combinedOutput.length > 0 ||
              partialSource.stdout.length > 0 ||
              partialSource.stderr.length > 0));

        if (hasPartial) {
          const reason =
            message.status === "interrupted"
              ? "User interrupted"
              : (message.parts?.find((part) => part.type === "tool_result")?.error ??
                "Tool failed.");
          const preserved = createInterruptedToolStreamOutput(partialSource, reason);
          messageToStore = {
            ...message,
            content: preserved,
            parts: (message.parts ?? []).map((part) =>
              part.type === "tool_result"
                ? {
                    ...part,
                    error: part.error ?? reason,
                    output: preserved,
                  }
                : part,
            ),
          };
        }
      } else if (message.toolCallId) {
        bufferedToolOutputByCallId.delete(message.toolCallId);
      }

      const linkedFile = extractLinkedFileFromToolResult({
        content: messageToStore.content,
        status: messageToStore.status,
        toolName: messageToStore.toolName,
      });
      let linkedFileIds: string[] = [];
      let previewFilesForMessage: PreviewFile[] = [];

      if (linkedFile) {
        try {
          previewFilesForMessage = await loadPreviewFilesFromPaths([
            {
              path: linkedFile.path,
              projectId: targetProjectId,
              projectRoot: targetProjectRoot,
              summary:
                linkedFile.action === "created"
                  ? "Created during assistant turn"
                  : linkedFile.action === "edited"
                    ? "Edited during assistant turn"
                    : "Read during assistant turn",
            },
          ]);
          linkedFileIds = previewFilesForMessage.map((previewFile) => previewFile.id);
        } catch (error) {
          frontendLogger.debug("frontend.workspace", "tool_preview_load_failed", {
            error,
            sessionIdLength: targetSessionId.length,
            toolCallIdLength: messageToStore.toolCallId?.length ?? 0,
            toolName: messageToStore.toolName ?? null,
          });
        }
      }

      set((state) => {
        const nextProjects = updatePersistedSession(
          state.projects,
          targetProjectId,
          targetSessionId as string,
          (session) => {
            upsertSessionMessage(session.messages, messageToStore);
            const targetMessage = session.messages.find((entry) => entry.id === messageToStore.id);

            if (targetMessage && linkedFileIds.length > 0) {
              targetMessage.linkedFileIds = linkedFileIds;
            }
            session.updatedAtLabel = nowLabel();
            session.updatedAtMs = Date.now();
          },
        );

        if (!nextProjects) {
          return state;
        }

        return {
          previewFiles:
            previewFilesForMessage.length > 0
              ? mergePreviewFiles(state.previewFiles, previewFilesForMessage)
              : state.previewFiles,
          projects: nextProjects,
        };
      });
      persistMessageFromStateSoft(messageToStore.id, "tool_message_appended");
      frontendLogger.info("frontend.workspace", "tool_message_appended", {
        messageIdLength: messageToStore.id.length,
        linkedFileCount: linkedFileIds.length,
        sessionIdLength: targetSessionId.length,
        status: messageToStore.status ?? null,
        toolCallIdLength: messageToStore.toolCallId?.length ?? 0,
      });
    };

    const settleTurn = (
      status: "done" | "error" | "interrupted",
      fallbackContent?: string,
    ) => {
      if (!isActiveRunRequest()) {
        return;
      }

      clearPendingFlush();
      clearPendingToolFlush();
      clearPendingDurablePersist();
      // Apply last buffered UI state before freezing stream writes.
      flushBufferedChunks();
      flushBufferedToolChunks();
      turnSettled = true;
      activeAssistantMessageId = null;
      activeContentStepId = null;

      set((state) => {
        const nextProjects = updatePersistedSession(
          state.projects,
          targetProjectId,
          targetSessionId as string,
          (sessionEntry) => {
            const turnMessages = sessionEntry.messages.filter((message) => message.turnId === turnId);
            const assistantMessages = turnMessages.filter((message) => message.role === "assistant");
            const changedFileIdsForTurn = turnMessages
              .filter((message) => message.role === "tool")
              .flatMap((message) => message.linkedFileIds ?? []);
            const completedAtMs = Date.now();
            let lastAssistantMessage = assistantMessages[assistantMessages.length - 1];

            if (!lastAssistantMessage && fallbackContent) {
              lastAssistantMessage = {
                assistantPhase: "final",
                content: "",
                createdAtLabel: formatExactMessageTimestamp(completedAtMs),
                createdAtMs: completedAtMs,
                id: `message-assistant-${crypto.randomUUID()}`,
                parts: [],
                reasoning: "",
                role: "assistant",
                startedAtMs: completedAtMs,
                status,
                toolCalls: [],
                toolResults: [],
                turnId,
              };
              sessionEntry.messages.push(lastAssistantMessage);
            }

            if (lastAssistantMessage && changedFileIdsForTurn.length > 0) {
              lastAssistantMessage.linkedFileIds = mergeLinkedFileIds(
                lastAssistantMessage.linkedFileIds,
                changedFileIdsForTurn,
              );
            }

            const assistantToolCallMetadata = new Map<
              string,
              {
                arguments?: string;
                parentPartId: string;
                startedAtMs?: number;
                toolName: string;
              }
            >();

            for (const assistantMessage of assistantMessages) {
              for (const toolCall of assistantMessage.toolCalls ?? []) {
                const toolCallPart = assistantMessage.parts?.find(
                  (part) =>
                    part.type === "tool_call" && (part.toolCallId ?? part.id) === toolCall.id,
                );
                assistantToolCallMetadata.set(toolCall.id, {
                  arguments: toolCall.input,
                  parentPartId:
                    toolCallPart?.id ?? `${assistantMessage.id}-tool-call-${toolCall.id}`,
                  startedAtMs: toolCallPart?.createdAtMs,
                  toolName: toolCall.name,
                });
              }
            }

            if (status === "interrupted") {
              const toolMessagesByCallId = new Set(
                sessionEntry.messages
                  .filter((message) => message.turnId === turnId && message.role === "tool")
                  .map((message) => message.toolCallId)
                  .filter((toolCallId): toolCallId is string => Boolean(toolCallId)),
              );

              for (const assistantMessage of assistantMessages) {
                for (const toolCall of assistantMessage.toolCalls ?? []) {
                  if (toolMessagesByCallId.has(toolCall.id)) {
                    continue;
                  }

                  const toolMessageId = `message-tool-${toolCall.id}`;
                  sessionEntry.messages.push({
                    content: "User interrupted",
                    completedAtMs,
                    createdAtLabel: formatExactMessageTimestamp(completedAtMs),
                    createdAtMs: completedAtMs,
                    id: toolMessageId,
                    parts: [
                      {
                        createdAtMs: completedAtMs,
                        error: "User interrupted",
                        id: `${toolMessageId}-result`,
                        metadata: {
                          arguments: toolCall.input,
                          finishedAtMs: completedAtMs,
                          projectId: targetProjectId,
                          startedAtMs:
                            assistantToolCallMetadata.get(toolCall.id)?.startedAtMs ?? completedAtMs,
                          status: "interrupted",
                          toolName: toolCall.name,
                        },
                        name: toolCall.name,
                        output: "User interrupted",
                        parentPartId:
                          assistantToolCallMetadata.get(toolCall.id)?.parentPartId ??
                          `${assistantMessage.id}-tool-call-${toolCall.id}`,
                        status: "interrupted",
                        toolCallId: toolCall.id,
                        type: "tool_result",
                      },
                    ],
                    role: "tool",
                    startedAtMs: completedAtMs,
                    status: "interrupted",
                    toolCallId: toolCall.id,
                    toolName: toolCall.name,
                    turnId,
                  });
                  toolMessagesByCallId.add(toolCall.id);
                }
              }
            }

            for (const targetMessage of sessionEntry.messages) {
              if (targetMessage.turnId !== turnId) {
                continue;
              }

              if (targetMessage.role === "tool") {
                if (targetMessage.status === "streaming") {
                  const settleReason =
                    status === "interrupted"
                      ? "User interrupted"
                      : status === "error"
                        ? "Tool failed."
                        : "Tool finished.";
                  const liveBuffer = targetMessage.toolCallId
                    ? bufferedToolOutputByCallId.get(targetMessage.toolCallId)
                    : undefined;
                  if (targetMessage.toolCallId) {
                    bufferedToolOutputByCallId.delete(targetMessage.toolCallId);
                  }
                  const toolCallMetadata = targetMessage.toolCallId
                    ? assistantToolCallMetadata.get(targetMessage.toolCallId)
                    : undefined;
                  let hasToolResultPart = false;

                  targetMessage.completedAtMs = targetMessage.completedAtMs ?? completedAtMs;
                  targetMessage.status =
                    status === "error"
                      ? "error"
                      : status === "interrupted"
                        ? "interrupted"
                        : "done";
                  targetMessage.parts = (targetMessage.parts ?? []).map((part) => {
                    if (part.type === "tool_result") {
                      hasToolResultPart = true;
                    }

                    const nextStatus =
                      status === "error"
                        ? "error"
                        : part.status === "error"
                          ? part.status
                          : status === "interrupted"
                            ? "interrupted"
                            : "done";
                    // #37: keep partial stream text; mark interrupted/truncated honestly.
                    const nextOutput =
                      (status === "interrupted" || status === "error") &&
                      part.type === "tool_result"
                        ? createInterruptedToolStreamOutput(
                            liveBuffer ?? part.output ?? null,
                            settleReason,
                          )
                        : part.output;

                    return {
                      ...part,
                      error:
                        (status === "interrupted" || status === "error") &&
                        part.type === "tool_result"
                          ? part.error ?? settleReason
                          : part.error,
                      metadata:
                        part.type === "tool_result"
                          ? {
                              ...(part.metadata ?? {}),
                              finishedAtMs: completedAtMs,
                              parentPartId: part.parentPartId ?? toolCallMetadata?.parentPartId,
                              projectId: targetProjectId,
                              startedAtMs:
                                typeof part.metadata?.startedAtMs === "number"
                                  ? part.metadata.startedAtMs
                                  : toolCallMetadata?.startedAtMs,
                              status:
                                status === "interrupted"
                                  ? "interrupted"
                                  : status === "error"
                                    ? "error"
                                    : part.status === "error"
                                      ? part.status
                                      : "done",
                            }
                          : part.metadata,
                      output: nextOutput,
                      status: nextStatus,
                    };
                  });

                  if (
                    (status === "interrupted" || status === "error") &&
                    !hasToolResultPart
                  ) {
                    const interruptedOutput = createInterruptedToolStreamOutput(
                      liveBuffer ?? null,
                      settleReason,
                    );
                    targetMessage.parts = appendMessagePart(targetMessage.parts, {
                      createdAtMs: completedAtMs,
                      error: settleReason,
                      id: `${targetMessage.id}-result`,
                      metadata: {
                        arguments: toolCallMetadata?.arguments,
                        finishedAtMs: completedAtMs,
                        parentPartId: toolCallMetadata?.parentPartId,
                        projectId: targetProjectId,
                        startedAtMs: toolCallMetadata?.startedAtMs ?? completedAtMs,
                        status: status === "error" ? "error" : "interrupted",
                        toolName: targetMessage.toolName ?? toolCallMetadata?.toolName,
                      },
                      name: targetMessage.toolName ?? toolCallMetadata?.toolName,
                      output: interruptedOutput,
                      parentPartId: toolCallMetadata?.parentPartId,
                      status: status === "error" ? "error" : "interrupted",
                      toolCallId: targetMessage.toolCallId,
                      type: "tool_result",
                    });
                  }

                  synchronizeMessageFromParts(targetMessage);
                }

                continue;
              }

              if (
                fallbackContent &&
                targetMessage.role === "assistant" &&
                targetMessage.id === lastAssistantMessage?.id &&
                targetMessage.content.trim().length === 0 &&
                (targetMessage.reasoning ?? "").trim().length === 0
              ) {
                targetMessage.parts = appendMessagePart(targetMessage.parts, {
                  content: fallbackContent,
                  createdAtMs: completedAtMs,
                  id: createMessagePartId(targetMessage.id, "content"),
                  status,
                  type: "content",
                });
              }

              settleNonToolTurnMessage(targetMessage, status, completedAtMs);
              if (targetMessage.role === "assistant" || targetMessage.role === "user") {
                synchronizeMessageFromParts(targetMessage);
              }
            }

            sessionEntry.updatedAtLabel = nowLabel();
            sessionEntry.updatedAtMs = completedAtMs;
          },
        );

        return nextProjects ? { projects: nextProjects } : state;
      });

      const settledState = useWorkspaceStore.getState();
      const settledProject = settledState.projects.find((entry) => entry.id === targetProjectId);
      const settledSession = settledProject?.sessions.find((entry) => entry.id === targetSessionId);
      let settledTurnSummary: PersistedTurnSummaryRecord | null = null;

      if (settledSession) {
        const turnMessages = settledSession.messages.filter((message) => message.turnId === turnId);
        const turnSummary = buildTurnReplaySummary({
          messages: turnMessages,
          previewFileMap: new Map(
            settledState.previewFiles.map((file) => [file.id, file] as const),
          ),
          turnId,
        });

        if (turnSummary) {
          settledTurnSummary = turnSummary;
          set((state) => {
            const nextProjects = updatePersistedSession(
              state.projects,
              targetProjectId,
              targetSessionId as string,
              (sessionEntry) => {
                sessionEntry.replayTurnSummaries = upsertTurnSummary(
                  sessionEntry.replayTurnSummaries,
                  turnSummary,
                );
              },
            );

            return nextProjects ? { projects: nextProjects } : state;
          });
        }
      }

      clearPendingDurablePersist();

      const messageIds = collectActiveTurnMessageIds();
      const summaryToPersist = settledTurnSummary;

      durablePersistChain = durablePersistChain
        .catch(() => undefined)
        .then(async () => {
          const result = await runSettledTurnPersistence({
            finalize: async () => {
              await finalizeTurn({
                sessionId: targetSessionId as string,
                status: status === "error" ? "failed" : status,
                turnId,
              });
            },
            messageIds,
            persistMessage: async (messageId) => {
              const state = useWorkspaceStore.getState();
              const session = resolvePersistedSession(
                state.projects,
                targetProjectId,
                targetSessionId as string,
              );
              const message = session?.messages.find((entry) => entry.id === messageId);

              if (!message || message.turnId !== turnId) {
                return;
              }

              await appendOrUpdateMessage({
                message,
                previewFiles: state.previewFiles,
                projectId: targetProjectId,
                sessionId: targetSessionId as string,
              });
            },
            persistSummary: summaryToPersist
              ? async () => {
                  await persistTurnSummary({
                    sessionId: targetSessionId as string,
                    summary: summaryToPersist,
                  });
                }
              : undefined,
          });

          settledTurnPersistResult = result;

          if (result.finalizeError || result.messageErrors.length > 0 || result.summaryError) {
            frontendLogger.error("frontend.workspace", "turn_targeted_persist_incomplete", {
              finalizeError: result.finalizeError,
              messageErrorCount: result.messageErrors.length,
              sessionIdLength: targetSessionId.length,
              summaryError: result.summaryError,
              turnIdLength: turnId.length,
            });
          }
        })
        .catch((error) => {
          settledTurnPersistResult = {
            finalizeError: error instanceof Error ? error.message : "Turn persistence failed.",
            messageErrors: [],
            summaryError: null,
          };
          frontendLogger.error("frontend.workspace", "turn_targeted_persist_failed", {
            error,
            sessionIdLength: targetSessionId.length,
            turnIdLength: turnId.length,
          });
        });
      frontendLogger.info("frontend.workspace", "turn_settled", {
        fallbackContentLength: fallbackContent?.length ?? 0,
        sessionIdLength: targetSessionId.length,
        status,
        turnIdLength: turnId.length,
      });
    };

    const awaitSettledTurnPersist = async () => {
      await durablePersistChain.catch(() => undefined);
      return settledTurnPersistResult;
    };

    const applySettledPersistOutcome = (result: SettledTurnPersistResult | null) => {
      const description = result ? describeSettledTurnPersistResult(result) : null;

      if (!description) {
        return;
      }

      set({ chatError: description });
    };

    const finishRuntimeRun = async () => {
      if (!didBeginRuntimeRun) {
        return;
      }

      didBeginRuntimeRun = false;

      try {
        const { shouldWake } = await completeSessionRunFinish({
          finish: () => finishSessionRun(targetSessionId),
          sessionId: targetSessionId,
          wake: wakeSessionRun,
        });
        if (shouldWake) {
          frontendLogger.info("frontend.workspace", "session_run_wake_drained", {
            sessionIdLength: targetSessionId.length,
          });
        }
      } catch (error) {
        frontendLogger.debug("frontend.workspace", "runtime_finish_failed", {
          error,
          sessionIdLength: targetSessionId.length,
        });
      }
    };

    try {
      const currentState = useWorkspaceStore.getState();
      const project = currentState.projects.find((entry) => entry.id === targetProjectId);
      const session = project?.sessions.find((entry) => entry.id === targetSessionId);

      if (!project || !session) {
        throw new Error("The active chat could not be prepared.");
      }

      const selectedProviderModel = currentState.providerModels.find(
        (model) => model.id === currentState.modelId,
      );

      if (!selectedProviderModel) {
        throw new Error("Choose a provider model before sending a message.");
      }

      const selectedProvider = currentState.providers.find(
        (provider) => provider.id === selectedProviderModel.providerId,
      );
      const effectiveTokenizer = resolveEffectiveTokenizer(
        selectedProviderModel,
        selectedProvider,
      );
      await activateTokenizer(effectiveTokenizer.localPath);

      await runWorkspaceAgent({
        chatId: targetSessionId,
        history: session.messages,
        modelId: currentState.modelId,
        modelCapabilities: selectedProviderModel.capabilities,
        compactedContext: session.compactedContext ?? null,
        onAssistantChunk: ({ kind, text, messageId }) => {
          if (activeAssistantMessageId !== messageId) {
            activeAssistantMessageId = messageId;
          }

          if (kind === "reasoning") {
            void text;
          } else {
            bufferedContent += text;
            scheduleChunkFlush();
          }
        },
        onAssistantCreated: beginAssistantMessage,
        onReasoningFinished: finishReasoningStep,
        onAssistantStreamFinished: finishAssistantStream,
        onAssistantToolCalls: syncAssistantToolCalls,
        onCompactionStarted: async () => {
          const state = useWorkspaceStore.getState();
          const session = resolvePersistedSession(
            state.projects,
            targetProjectId,
            targetSessionId as string,
          );
          const messageCount = session?.messages.length ?? 0;
          set((current) => ({
            sessionContextStatus: {
              ...current.sessionContextStatus,
              [targetSessionId as string]: beginContextCompaction(
                current.sessionContextStatus[targetSessionId as string],
                messageCount,
              ),
            },
          }));
          void setSessionRuntimeState(targetSessionId as string, "compacting").catch(() => undefined);
        },
        onCompactedContext: async (compactedContext) => {
          let compactedSession: Session | null = null;
          set((state) => {
            const nextProjects = updatePersistedSession(
              state.projects,
              targetProjectId,
              targetSessionId as string,
              (sessionEntry) => {
                sessionEntry.compactedContext = compactedContext;
                sessionEntry.updatedAtLabel = nowLabel();
                sessionEntry.updatedAtMs = Date.now();
                compactedSession = sessionEntry;
              },
            );

            return {
              ...(nextProjects ? { projects: nextProjects } : {}),
              sessionContextStatus: {
                ...state.sessionContextStatus,
                [targetSessionId as string]: completeContextCompaction(
                  state.sessionContextStatus[targetSessionId as string],
                ),
              },
            };
          });

          if (compactedSession) {
            await createSessionIfNeeded({
              projectId: targetProjectId,
              selectedProjectId: targetProjectId,
              selectedSessionId: targetSessionId as string,
              session: compactedSession,
            });
          }
        },
        onCompactionEnded: async (result) => {
          if (result === "compacted") {
            void setSessionRuntimeState(targetSessionId as string, "busy").catch(() => undefined);
            return;
          }

          set((state) => {
            const next = { ...state.sessionContextStatus };
            delete next[targetSessionId as string];
            return { sessionContextStatus: next };
          });
          void setSessionRuntimeState(targetSessionId as string, "busy").catch(() => undefined);
        },
        onToolChunk: appendToolChunk,
        onToolMessage: appendToolMessage,
        onSessionPromptMetadata: async (metadata) => {
          let sessionToPersist: Session | null = null;
          set((state) => {
            const nextProjects = updatePersistedSession(
              state.projects,
              targetProjectId,
              targetSessionId as string,
              (sessionEntry) => {
                sessionEntry.systemPromptHash = metadata.systemPromptHash;
                sessionEntry.toolDefsHash = metadata.toolDefsHash;
                sessionEntry.toolDefTokens = metadata.toolDefTokens;
                if (metadata.tokenizerKind) {
                  sessionEntry.tokenizerKind = metadata.tokenizerKind;
                }
                sessionEntry.updatedAtMs = Date.now();
                sessionToPersist = sessionEntry;
              },
            );
            return nextProjects ? { projects: nextProjects } : state;
          });

          if (sessionToPersist) {
            await createSessionIfNeeded({
              projectId: targetProjectId,
              selectedProjectId: targetProjectId,
              selectedSessionId: targetSessionId as string,
              session: sessionToPersist,
            });
          }
        },
        onTurnFinished: () => undefined,
        permissionMode: currentState.permissionMode,
        previewFileMap: new Map(currentState.previewFiles.map((file) => [file.id, file] as const)),
        projectId: targetProjectId,
        reasoningLevel: selectedProviderModel.reasoningLevels.includes(currentState.reasoningLevel)
          ? currentState.reasoningLevel
          : selectedProviderModel.reasoningLevels[0],
        requestToolApproval: (request) =>
          useWorkspaceStore.getState().requestToolApproval(request),
        selectedModel: selectedProviderModel,
        turnSummaries: session.replayTurnSummaries ?? [],
        turnId,
        tokenizerKind: effectiveTokenizer.kind,
      });
      settleTurn("done", "The model returned an empty response.");
      const persistResult = await awaitSettledTurnPersist();
      applySettledPersistOutcome(persistResult);
      await reconcileEditedSessionIfNeeded();
      await finishRuntimeRun();
      if (isActiveRunRequest()) {
        activeRunRequestIdsBySession.delete(targetSessionId);
      }
      set((state) => ({
        ...withSendingSessionState(
          state.selectedSessionId,
          removeSendingSessionId(targetSessionId, state.sendingSessionIds),
        ),
      }));
      requestComposerQueueDrain(targetSessionId);
      frontendLogger.info("frontend.workspace", "agent_run_completed", {
        finalizeError: persistResult?.finalizeError ?? null,
        messageErrorCount: persistResult?.messageErrors.length ?? 0,
        sessionIdLength: targetSessionId.length,
        turnIdLength: turnId.length,
      });
      frontendLogger.info("frontend.workspace", "turn_persisted_after_run", {
        sessionIdLength: targetSessionId.length,
        turnIdLength: turnId.length,
      });
      // #44: accepted keeps draft cleared / queue dequeued; ok reflects durable settle.
      if (persistResult && isSettledTurnPersistIncomplete(persistResult)) {
        const error =
          describeSettledTurnPersistResult(persistResult) ??
          "The reply finished, but some chat data may not be fully saved.";
        return { accepted: true, error, ok: false, turnId };
      }
      return { accepted: true, ok: true, turnId };
    } catch (error) {
      if (isInterruptedWorkspaceChatError(error)) {
        settleTurn("interrupted", "Stopped.");
        const persistResult = await awaitSettledTurnPersist();
        applySettledPersistOutcome(persistResult);
        await reconcileEditedSessionIfNeeded();
        await finishRuntimeRun();
        if (isActiveRunRequest()) {
          activeRunRequestIdsBySession.delete(targetSessionId);
        }
        set((state) => ({
          ...withSendingSessionState(
            state.selectedSessionId,
            removeSendingSessionId(targetSessionId, state.sendingSessionIds),
          ),
        }));
        requestComposerQueueDrain(targetSessionId);
        frontendLogger.info("frontend.workspace", "agent_run_interrupted", {
          finalizeError: persistResult?.finalizeError ?? null,
          sessionIdLength: targetSessionId.length,
          turnIdLength: turnId.length,
        });
        frontendLogger.info("frontend.workspace", "turn_persisted_after_interrupt", {
          sessionIdLength: targetSessionId.length,
          turnIdLength: turnId.length,
        });
        if (persistResult && isSettledTurnPersistIncomplete(persistResult)) {
          const error =
            describeSettledTurnPersistResult(persistResult) ??
            "The reply finished, but some chat data may not be fully saved.";
          return { accepted: true, error, ok: false, turnId };
        }
        return { accepted: true, ok: true, turnId };
      }

      const message =
        error instanceof Error && error.message.trim()
          ? error.message
          : "Wizzle could not complete the request.";

      settleTurn("error", message);
      frontendLogger.error("frontend.workspace", "agent_run_failed", {
        error,
        sessionIdLength: targetSessionId.length,
        turnIdLength: turnId.length,
      });

      let errorMessage = message;

      try {
        const persistResult = await awaitSettledTurnPersist();
        if (persistResult?.finalizeError) {
          errorMessage = `${message} (Also could not close the turn: ${persistResult.finalizeError})`;
        }
        await reconcileEditedSessionIfNeeded();
        frontendLogger.info("frontend.workspace", "turn_persisted_after_failure", {
          finalizeError: persistResult?.finalizeError ?? null,
          sessionIdLength: targetSessionId.length,
          turnIdLength: turnId.length,
        });
      } catch {
        // Keep the original request error visible in the UI.
      }
      await finishRuntimeRun();
      if (isActiveRunRequest()) {
        activeRunRequestIdsBySession.delete(targetSessionId);
      }

      // #19 C: show under the assistant bubble (not a global banner); no mid-stream retry.
      const settledSession = resolvePersistedSession(
        useWorkspaceStore.getState().projects,
        targetProjectId,
        targetSessionId as string,
      );
      const hadPartialContent = turnHasPartialAssistantContent(
        settledSession?.messages ?? [],
        turnId,
      );
      const streamErrorMessage = formatStreamStepUserMessage(errorMessage, {
        hadPartialContent,
      });

      set((state) => ({
        chatError: null,
        sessionStreamErrors: setSessionStreamErrorMap(state.sessionStreamErrors, targetSessionId, {
          message: streamErrorMessage,
          turnId,
        }),
        ...withSendingSessionState(
          state.selectedSessionId,
          removeSendingSessionId(targetSessionId, state.sendingSessionIds),
        ),
      }));
      requestComposerQueueDrain(targetSessionId);
      // Message was accepted into the session; keep accepted so composer does not restore draft (#79).
      return { accepted: true, error: streamErrorMessage, ok: false, turnId };
    }
  },
}));
