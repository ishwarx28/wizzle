import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { resolveToolDefinitionsMetadata } from "./agent/tool-definitions";
import { frontendLogger } from "./logger";
import type {
  Message,
  MessagePart,
  ModelId,
  PermissionMode,
  PersistedTurnSummaryRecord,
  PreviewFile,
  ProviderInfo,
  ProviderModelInfo,
  SessionRuntimeState,
  Session,
  WorkspaceProcess,
  WorkspaceComposerState,
  WorkspaceSessionLoad,
  WorkspaceSnapshot,
} from "../types/workspace";

export async function loadWorkspaceSnapshot() {
  frontendLogger.info("frontend.workspace-api", "load_snapshot_requested");
  return invoke<WorkspaceSnapshot>("load_workspace_snapshot");
}

export async function getSessionRuntimeState(sessionId: string) {
  return invoke<SessionRuntimeState>("get_session_runtime_state", {
    input: {
      sessionId,
    },
  });
}

export async function setSessionRuntimeState(
  sessionId: string,
  state: SessionRuntimeState["state"],
) {
  return invoke<SessionRuntimeState>("set_session_runtime_state", {
    input: {
      sessionId,
      state,
    },
  });
}

export async function listSessionRuntimeStates() {
  return invoke<SessionRuntimeState[]>("list_session_runtime_states");
}

export async function wakeSessionRun(sessionId: string) {
  return invoke("wake_session_run", {
    input: {
      sessionId,
    },
  });
}

export async function beginSessionRun(sessionId: string) {
  return invoke("begin_session_run", {
    input: {
      sessionId,
    },
  });
}

export async function finishSessionRun(sessionId: string) {
  return invoke<boolean>("finish_session_run", {
    input: {
      sessionId,
    },
  });
}

export async function interruptSessionRun(sessionId: string) {
  return invoke("interrupt_session_run", {
    input: {
      sessionId,
    },
  });
}

export async function listAgentProcesses(sessionId: string) {
  return invoke<WorkspaceProcess[]>("list_agent_processes", {
    input: {
      sessionId,
    },
  });
}

export async function readAgentProcess(sessionId: string, processId: string) {
  return invoke<WorkspaceProcess>("read_agent_process", {
    input: {
      processId,
      sessionId,
    },
  });
}

export async function stopAgentProcess(sessionId: string, processId: string) {
  return invoke<WorkspaceProcess>("stop_agent_process", {
    input: {
      processId,
      sessionId,
    },
  });
}

export async function listProviders() {
  return invoke<ProviderInfo[]>("list_providers");
}

export async function listProviderModels() {
  return invoke<ProviderModelInfo[]>("list_provider_models");
}

export async function upsertProvider(input: {
  apiKey?: string;
  defaultModelId?: string;
  endpoint: string;
  id?: string;
  models?: Array<{
    capabilities?: string[];
    displayName?: string;
    maxContext?: number;
    maxOutputTokens?: number;
    modelId: string;
    reasoningLevels?: string[];
    tokenizerKind?: string;
  }>;
  name: string;
  onlySpecifiedModels?: boolean;
  providerType: string;
}) {
  return invoke<string>("upsert_provider", { input });
}

export async function deleteProvider(providerId: string) {
  return invoke("delete_provider", {
    input: {
      providerId,
    },
  });
}

export async function refreshProviderModels(providerId: string) {
  return invoke<ProviderModelInfo[]>("refresh_provider_models", {
    input: {
      providerId,
    },
  });
}

export async function importProviderYaml(yaml: string, source?: string) {
  return invoke("import_provider_yaml", {
    input: {
      source: source ?? null,
      yaml,
    },
  });
}

export async function loadWorkspaceSession(projectId: string, sessionId: string) {
  frontendLogger.info("frontend.workspace-api", "load_session_requested", {
    projectIdLength: projectId.length,
    sessionIdLength: sessionId.length,
  });
  return invoke<WorkspaceSessionLoad>("load_workspace_session", {
    input: {
      projectId,
      sessionId,
    },
  });
}

export async function loadComposerState(sessionId: string) {
  return invoke<WorkspaceComposerState>("load_composer_state", {
    input: {
      sessionId,
    },
  });
}

export async function saveComposerState(input: {
  draftText: string;
  queuedMessages: Array<{
    attachments: PreviewFile[];
    content: string;
    id: string;
    status?: "queued" | "sending" | "sent" | "failed";
  }>;
  sessionId: string;
}) {
  return invoke("save_composer_state", {
    input,
  });
}

export async function selectProjectFolder() {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select project folder",
  });

  return typeof selected === "string" ? selected : null;
}

export async function addProjectFromPath(rootPath: string) {
  frontendLogger.info("frontend.workspace-api", "add_project_requested", {
    rootPathLength: rootPath.length,
  });
  return invoke<WorkspaceSnapshot>("add_project_from_path", { rootPath });
}

export async function removeProjectById(projectId: string) {
  frontendLogger.info("frontend.workspace-api", "remove_project_requested", {
    projectIdLength: projectId.length,
  });
  return invoke<WorkspaceSnapshot>("remove_project_by_id", { projectId });
}

export async function saveWorkspaceSettings(input: {
  isFilePanelOpen: boolean;
  isSidebarOpen: boolean;
  modelId: ModelId;
  permissionMode: PermissionMode;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
}) {
  return invoke("save_workspace_settings", {
    input,
  });
}

export async function setProjectExpanded(projectId: string, isExpanded: boolean) {
  return invoke("set_project_expanded", {
    input: {
      isExpanded,
      projectId,
    },
  });
}

export async function renameWorkspaceSession(projectId: string, sessionId: string, title: string) {
  return invoke<WorkspaceSnapshot>("rename_workspace_session", {
    input: {
      projectId,
      sessionId,
      title,
    },
  });
}

export async function deleteWorkspaceSession(projectId: string, sessionId: string) {
  return invoke<WorkspaceSnapshot>("delete_workspace_session", {
    input: {
      projectId,
      sessionId,
    },
  });
}

function buildPersistedMessageParts(parts: MessagePart[] | undefined) {
  return (parts ?? [])
    .filter((part) => part.type !== "reasoning")
    .map((part) => ({
      content: part.content ?? null,
      createdAtMs: part.createdAtMs ?? null,
      durationMs: part.durationMs ?? null,
      error: part.error ?? null,
      id: part.id,
      input: part.input ?? null,
      metadata: part.metadata ?? null,
      name: part.name ?? null,
      output: part.output ?? null,
      parentPartId: part.parentPartId ?? null,
      pruned: part.pruned ?? false,
      status: part.status ?? null,
      tokens: part.tokens ?? null,
      toolArguments: part.toolArguments ?? part.input ?? null,
      toolCallId: part.toolCallId ?? null,
      type: part.type,
    }));
}

function buildPersistedMessages(messages: Message[]) {
  return messages.map((message) => ({
    assistantPhase: message.assistantPhase ?? null,
    completedAtMs: message.completedAtMs ?? null,
    content: message.content,
    createdAtMs: message.createdAtMs ?? Date.now(),
    durationMs: message.durationMs ?? null,
    editedAtMs: message.editedAtMs ?? null,
    id: message.id,
    linkedFileIds: message.linkedFileIds ?? [],
    reasoning: null,
    reasoningDurationMs: null,
    role: message.role,
    startedAtMs: message.startedAtMs ?? null,
    status: message.status ?? "done",
    toolCallId: message.toolCallId ?? null,
    toolName: message.toolName ?? null,
    turnId: message.turnId ?? null,
    parts: buildPersistedMessageParts(message.parts),
    toolCalls: message.toolCalls ?? [],
    toolResults: message.toolResults ?? [],
  }));
}

function buildPersistedTurnSummaries(turnSummaries: PersistedTurnSummaryRecord[] | undefined) {
  return (turnSummaries ?? []).map((summary) => ({
    completedAtMs: summary.completedAtMs,
    estimatedTokensImageCapable: summary.estimatedTokensImageCapable,
    estimatedTokensTextOnly: summary.estimatedTokensTextOnly,
    estimatorVersion: summary.estimatorVersion,
    messageIds: summary.messageIds,
    replayMessageCountImageCapable: summary.replayMessageCountImageCapable,
    replayMessageCountTextOnly: summary.replayMessageCountTextOnly,
    turnId: summary.turnId,
  }));
}

export async function reconcileEntireSessionForExplicitEditOrRepair(input: {
  previewFiles: PreviewFile[];
  projectId: string;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  session: Session;
}) {
  const toolDefinitionsMetadata = resolveToolDefinitionsMetadata();

  frontendLogger.info("frontend.workspace-api", "persist_session_requested", {
    messageCount: input.session.messages.length,
    projectIdLength: input.projectId.length,
    sessionIdLength: input.session.id.length,
    toolDefsHash: toolDefinitionsMetadata.hash,
  });
  return invoke("persist_workspace_session", {
    input: {
      previewFiles: input.previewFiles,
      projectId: input.projectId,
      selectedProjectId: input.selectedProjectId,
      selectedSessionId: input.selectedSessionId,
      session: {
        createdAtMs: input.session.createdAtMs ?? Date.now(),
        id: input.session.id,
        messages: buildPersistedMessages(input.session.messages),
        modelId: input.session.modelId ?? null,
        permissionMode: input.session.permissionMode ?? null,
        compactedContext: input.session.compactedContext ?? null,
        replayTurnSummaries: buildPersistedTurnSummaries(input.session.replayTurnSummaries),
        selectedModelUuid: input.session.selectedModelUuid ?? input.session.modelId ?? null,
        systemPromptHash: input.session.systemPromptHash ?? null,
        tokenizerKind: input.session.tokenizerKind ?? null,
        title: input.session.title,
        toolDefTokens: toolDefinitionsMetadata.tokens,
        toolDefsHash: input.session.toolDefsHash ?? toolDefinitionsMetadata.hash,
        updatedAtMs: input.session.updatedAtMs ?? Date.now(),
      },
    },
  });
}

function buildPersistedSessionMetadata(session: Session) {
  const toolDefinitionsMetadata = resolveToolDefinitionsMetadata();

  return {
    compactedContext: session.compactedContext ?? null,
    createdAtMs: session.createdAtMs ?? Date.now(),
    id: session.id,
    modelId: null,
    permissionMode: session.permissionMode ?? null,
    selectedModelUuid: session.selectedModelUuid ?? session.modelId ?? null,
    systemPromptHash: session.systemPromptHash ?? null,
    title: session.title,
    tokenizerKind: session.tokenizerKind ?? null,
    toolDefTokens: toolDefinitionsMetadata.tokens,
    toolDefsHash: session.toolDefsHash ?? toolDefinitionsMetadata.hash,
    updatedAtMs: session.updatedAtMs ?? Date.now(),
  };
}

export async function createSessionIfNeeded(input: {
  projectId: string;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  session: Session;
}) {
  return invoke("create_session_if_needed", {
    input: {
      projectId: input.projectId,
      selectedProjectId: input.selectedProjectId,
      selectedSessionId: input.selectedSessionId,
      session: buildPersistedSessionMetadata(input.session),
    },
  });
}

export async function updateSessionTitle(input: {
  sessionId: string;
  title: string;
  updatedAtMs?: number;
}) {
  return invoke("update_session_title", {
    input: {
      sessionId: input.sessionId,
      title: input.title,
      updatedAtMs: input.updatedAtMs ?? Date.now(),
    },
  });
}

export async function updateSessionSelection(input: {
  projectId: string;
  selectedModelUuid?: string | null;
  permissionMode?: PermissionMode | null;
  sessionId: string;
  tokenizerKind?: string | null;
  updatedAtMs?: number;
}) {
  const toolDefinitionsMetadata = resolveToolDefinitionsMetadata();

  return invoke("update_session_selection", {
    input: {
      permissionMode: input.permissionMode ?? null,
      projectId: input.projectId,
      selectedModelUuid: input.selectedModelUuid ?? null,
      sessionId: input.sessionId,
      tokenizerKind: input.tokenizerKind ?? null,
      toolDefTokens: toolDefinitionsMetadata.tokens,
      toolDefsHash: toolDefinitionsMetadata.hash,
      updatedAtMs: input.updatedAtMs ?? Date.now(),
    },
  });
}

export async function appendOrUpdateMessage(input: {
  message: Message;
  previewFiles: PreviewFile[];
  projectId: string;
  sessionId: string;
}) {
  return invoke("append_or_update_message", {
    input: {
      message: buildPersistedMessages([input.message])[0],
      previewFiles: input.previewFiles,
      projectId: input.projectId,
      sessionId: input.sessionId,
    },
  });
}

export async function upsertTurnSummary(input: {
  sessionId: string;
  summary: PersistedTurnSummaryRecord;
}) {
  return invoke("upsert_turn_summary", {
    input: {
      sessionId: input.sessionId,
      summary: buildPersistedTurnSummaries([input.summary])[0],
    },
  });
}

export async function finalizeTurn(input: {
  sessionId: string;
  status: "done" | "interrupted" | "failed";
  turnId: string;
  updatedAtMs?: number;
}) {
  return invoke("finalize_turn", {
    input: {
      sessionId: input.sessionId,
      status: input.status,
      turnId: input.turnId,
      updatedAtMs: input.updatedAtMs ?? Date.now(),
    },
  });
}
