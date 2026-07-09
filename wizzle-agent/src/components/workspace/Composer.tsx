import {
  ArrowUp,
  Check,
  Command,
  ChevronDown,
  CornerDownLeft,
  FileCode2,
  FileImage,
  FileText,
  Paperclip,
  Pencil,
  Search,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useScrollActivity } from "../../hooks/use-scroll-activity";
import {
  buildAttachmentPreviewFromBytes,
  MAX_IMAGE_ATTACHMENT_SOURCE_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  pickAttachmentPreviews,
} from "../../lib/attachments";
import {
  enhanceWorkspacePrompt,
  interruptWorkspacePromptEnhancement,
  isInterruptedWorkspaceChatError,
  resolvePromptInputLimit,
} from "../../lib/chat-stream";
import { MAX_REPLAY_INPUT, selectReplayHistoryWithinBudget } from "../../lib/context-budget";
import { loadComposerState, saveComposerState } from "../../lib/local-workspace";
import { SESSION_RUN_WAKE_EVENT } from "../../lib/session-run-wake";
import { useWorkspaceStore } from "../../store/workspace-store";
import type {
  MessageEditState,
  ModelCapability,
  PermissionMode,
  PreviewFile,
} from "../../types/workspace";

interface ComposerProps {
  expanded?: boolean;
  placeholder: string;
  showFloatingEnhanceAction?: boolean;
}

interface QueuedSubmission {
  attachments: PreviewFile[];
  id: string;
  prompt: string;
  status?: "queued" | "sending" | "sent" | "failed";
}

interface SessionComposerMemory {
  attachments: PreviewFile[];
  draft: string;
  queuedSubmissions: QueuedSubmission[];
}

const MAX_ATTACHMENTS = 5;
const MAX_QUEUED_SUBMISSIONS = 6;
const TEXT_ENTRY_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='textbox']",
].join(",");
const GLOBAL_CAPTURE_TARGET_BLOCKLIST_SELECTOR = [
  TEXT_ENTRY_SELECTOR,
  "button",
  "a[href]",
  "[role='button']",
  "[role='menu']",
  "[role='menuitem']",
  "[data-sidebar-menu]",
  "[data-provider-dialog]",
  "[data-model-selector]",
  "[data-tool-approval]",
  "[data-file-panel]",
  "[data-file-search]",
  "[data-terminal-output]",
  "[data-code-block]",
  ".markdown-code-block",
  ".markdown-body pre",
  ".markdown-body code",
  "pre",
  "code",
].join(",");
const GLOBAL_CAPTURE_OVERLAY_BLOCKLIST_SELECTOR = [
  "[data-modal]",
  "[role='dialog']",
  "[data-sidebar-menu]",
  "[role='menu']",
].join(",");
const GLOBAL_CAPTURE_SELECTION_BLOCKLIST_SELECTOR = [
  "[data-terminal-output]",
  "[data-code-block]",
  ".markdown-code-block",
  ".markdown-body pre",
  ".markdown-body code",
  "pre",
  "code",
].join(",");
const markdownExtensions = new Set(["md", "mdx", "markdown"]);
const textExtensions = new Set([
  "txt",
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "css",
  "html",
  "htm",
  "sh",
  "yaml",
  "yml",
  "xml",
]);
const ENHANCE_SHORTCUT_KEY = "e";
const MAX_PROMPT_SIZE = resolvePromptInputLimit();

function getExtension(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return extension ?? "";
}

function fileIcon(kind: PreviewFile["kind"]) {
  switch (kind) {
    case "image":
      return <FileImage className="h-3.5 w-3.5" />;
    case "markdown":
      return <FileText className="h-3.5 w-3.5" />;
    default:
      return <FileCode2 className="h-3.5 w-3.5" />;
  }
}

function inferPreviewKind(file: File, capabilities: ModelCapability[]): PreviewFile["kind"] | null {
  if (file.type.startsWith("image/")) {
    if (!capabilities.includes("image")) {
      return null;
    }

    return "image";
  }

  const extension = getExtension(file.name);

  if (markdownExtensions.has(extension)) {
    return "markdown";
  }

  if (
    file.type.startsWith("text/") ||
    file.type === "application/json" ||
    file.type === "application/xml" ||
    textExtensions.has(extension)
  ) {
    return "text";
  }

  return null;
}

function dedupeAttachmentKey(attachment: PreviewFile) {
  if (attachment.path.trim()) {
    return `${attachment.kind}:${attachment.path}`;
  }

  if (attachment.imageSrc?.trim()) {
    return `${attachment.kind}:${attachment.name}:${attachment.imageSrc.slice(0, 96)}`;
  }

  if (attachment.content?.trim()) {
    return `${attachment.kind}:${attachment.name}:${attachment.content.slice(0, 96)}`;
  }

  return `${attachment.kind}:${attachment.name}`;
}

function elementFromTarget(target: EventTarget | Node | null) {
  if (target instanceof HTMLElement) {
    return target;
  }

  if (target instanceof Node) {
    return target.parentElement;
  }

  return null;
}

function isGlobalCaptureTargetBlocked(target: EventTarget | Node | null) {
  const element = elementFromTarget(target);
  return Boolean(element?.closest(GLOBAL_CAPTURE_TARGET_BLOCKLIST_SELECTOR));
}

function hasBlockingCaptureOverlay() {
  return Boolean(document.querySelector(GLOBAL_CAPTURE_OVERLAY_BLOCKLIST_SELECTOR));
}

function hasSelectionInBlockedRegion() {
  const selection = window.getSelection();

  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    return false;
  }

  return [selection.anchorNode, selection.focusNode].some((node) =>
    Boolean(elementFromTarget(node)?.closest(GLOBAL_CAPTURE_SELECTION_BLOCKLIST_SELECTOR)),
  );
}

function canUseGlobalComposerCapture(event: Event) {
  if (event.defaultPrevented || hasBlockingCaptureOverlay()) {
    return false;
  }

  if (
    isGlobalCaptureTargetBlocked(document.activeElement) ||
    isGlobalCaptureTargetBlocked(event.target)
  ) {
    return false;
  }

  return !hasSelectionInBlockedRegion();
}

function isComposerCaptureKey(event: KeyboardEvent) {
  return (
    event.key.length === 1 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing
  );
}

async function createAttachmentPreview(
  file: File,
  capabilities: ModelCapability[],
): Promise<PreviewFile | null> {
  const kind = inferPreviewKind(file, capabilities);

  if (!kind) {
    return null;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  return buildAttachmentPreviewFromBytes({
    capabilities,
    bytes,
    name: file.name,
    virtualPath: `Attachments/${file.name}`,
  });
}

function attachmentSourceLimit(file: File) {
  return file.type.startsWith("image/")
    ? MAX_IMAGE_ATTACHMENT_SOURCE_BYTES
    : MAX_TEXT_ATTACHMENT_BYTES;
}

function attachmentSourceLimitLabel(file: File) {
  const limitBytes = attachmentSourceLimit(file);
  const limitMb = Math.floor(limitBytes / (1024 * 1024));
  return `${limitMb} MB`;
}

function formatTokenCount(value: number) {
  return Math.round(value).toLocaleString();
}

function resolveActiveTurnId(messages: Array<{ status?: string; turnId?: string }>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.status === "streaming") {
      return message.turnId;
    }
  }

  return undefined;
}

function resolveBudgetColor(usageRatio: number) {
  if (usageRatio >= 0.9) {
    return "#ff7a6b";
  }

  if (usageRatio >= 0.7) {
    return "#f2a35b";
  }

  return "#62c98b";
}

export function Composer({
  expanded = false,
  placeholder,
  showFloatingEnhanceAction = true,
}: ComposerProps) {
  const activeMessageEdit = useWorkspaceStore((state) => state.activeMessageEdit);
  const cancelMessageEdit = useWorkspaceStore((state) => state.cancelMessageEdit);
  const clearChatError = useWorkspaceStore((state) => state.clearChatError);
  const draftSessions = useWorkspaceStore((state) => state.draftSessions);
  const interruptPrompt = useWorkspaceStore((state) => state.interruptPrompt);
  const isSendingMessage = useWorkspaceStore((state) => state.isSendingMessage);
  const modelId = useWorkspaceStore((state) => state.modelId);
  const pendingToolApproval = useWorkspaceStore((state) => state.pendingToolApproval);
  const permissionMode = useWorkspaceStore((state) => state.permissionMode);
  const previewFiles = useWorkspaceStore((state) => state.previewFiles);
  const projects = useWorkspaceStore((state) => state.projects);
  const providerModels = useWorkspaceStore((state) => state.providerModels);
  const reasoningLevel = useWorkspaceStore((state) => state.reasoningLevel);
  const selectedProjectId = useWorkspaceStore((state) => state.selectedProjectId);
  const selectedSessionId = useWorkspaceStore((state) => state.selectedSessionId);
  const sendPrompt = useWorkspaceStore((state) => state.sendPrompt);
  const setModelId = useWorkspaceStore((state) => state.setModelId);
  const setPermissionMode = useWorkspaceStore((state) => state.setPermissionMode);
  const setReasoningLevel = useWorkspaceStore((state) => state.setReasoningLevel);
  const resolveToolApproval = useWorkspaceStore((state) => state.resolveToolApproval);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PreviewFile[]>([]);
  const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false);
  const [queuedSubmissions, setQueuedSubmissions] = useState<QueuedSubmission[]>([]);
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [renderFloatingEnhanceAction, setRenderFloatingEnhanceAction] = useState(false);
  const [showFloatingEnhanceActionState, setShowFloatingEnhanceActionState] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const shimmerOverlayRef = useRef<HTMLDivElement | null>(null);
  const modelSelectorRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const queuedSubmissionsRef = useRef<QueuedSubmission[]>([]);
  const attachmentsRef = useRef<PreviewFile[]>([]);
  const draftRef = useRef("");
  const activeComposerKeyRef = useRef<string | null>(null);
  const composerMemoryRef = useRef(new Map<string, SessionComposerMemory>());
  const composerStateSaveTimeoutRef = useRef<number | null>(null);
  const persistedComposerSessionIdRef = useRef<string | null>(null);
  const enhanceOriginalDraftRef = useRef<string | null>(null);
  const enhanceRequestIdRef = useRef(0);
  const isDispatchingQueuedPromptRef = useRef(false);
  const [queueDrainTick, setQueueDrainTick] = useState(0);
  const [isComposerStateReady, setIsComposerStateReady] = useState(false);
  const floatingEnhanceHideTimeoutRef = useRef<number | null>(null);
  const composerDraftBeforeEditRef = useRef<{
    attachments: PreviewFile[];
    draft: string;
    sessionId: string | null;
  } | null>(null);
  const shouldRestoreComposerAfterEditRef = useRef(true);
  const activeEditMessageIdRef = useRef<string | null>(null);
  const { handleScrollActivity, isScrolling } = useScrollActivity();

  const hasDraftContent = draft.trim().length > 0 || attachments.length > 0;
  const hasEnhanceableDraft = draft.trim().length > 0;
  const shouldShowInterrupt = isSendingMessage && !hasDraftContent;
  const selectedProviderModel = providerModels.find((model) => model.id === modelId) ?? null;
  const isModelMissing = !selectedProviderModel;
  const isDisabled = isEnhancingPrompt || isModelMissing || (!isSendingMessage && !hasDraftContent);
  const shouldShowFloatingEnhanceAction =
    showFloatingEnhanceAction && hasEnhanceableDraft && !isEnhancingPrompt && !isSendingMessage;
  const isMacPlatform =
    typeof document !== "undefined" && document.documentElement.dataset.platform === "macos";
  const permissionModeLabel =
    permissionMode === "full-access" ? "Full access" : "Manual approve";
  const modelIdLabel =
    selectedProviderModel?.displayName ??
    selectedProviderModel?.modelId ??
    (providerModels.length > 0 ? "Choose model" : "No models");
  const selectedReasoningLevels = selectedProviderModel?.reasoningLevels ?? [];
  const selectedReasoningLevel =
    selectedReasoningLevels.includes(reasoningLevel)
      ? reasoningLevel
      : selectedReasoningLevels[0] ?? "";
  const reasoningLevelLabel = selectedReasoningLevel
    ? selectedReasoningLevel.charAt(0).toUpperCase() + selectedReasoningLevel.slice(1)
    : "Default";
  const modelCapabilities = selectedProviderModel?.capabilities ?? ["text"];
  const modelContextLimit = selectedProviderModel?.maxContext ?? MAX_REPLAY_INPUT;
  const modelsByProvider = useMemo(() => {
    const grouped = new Map<string, typeof providerModels>();

    for (const model of providerModels) {
      const key = model.providerName;
      grouped.set(key, [...(grouped.get(key) ?? []), model]);
    }

    return [...grouped.entries()];
  }, [providerModels]);
  const filteredModelsByProvider = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();

    if (!query) {
      return modelsByProvider;
    }

    return modelsByProvider
      .map(([providerName, models]) => [
        providerName,
        models.filter((model) =>
          [
            providerName,
            model.displayName ?? "",
            model.modelId,
            model.providerType,
            ...model.reasoningLevels,
          ]
            .join(" ")
            .toLowerCase()
            .includes(query),
        ),
      ] as const)
      .filter(([, models]) => models.length > 0);
  }, [modelSearch, modelsByProvider]);
  const currentProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const currentDraftSession = useMemo(
    () => (currentProject ? draftSessions[currentProject.id] ?? null : null),
    [currentProject, draftSessions],
  );
  const currentSession = useMemo(() => {
    if (!currentProject) {
      return null;
    }

    if (currentDraftSession?.id === selectedSessionId) {
      return currentDraftSession;
    }

    return currentProject.sessions.find((session) => session.id === selectedSessionId) ?? null;
  }, [currentDraftSession, currentProject, selectedSessionId]);
  const isCurrentDraftSession = currentDraftSession?.id === selectedSessionId;
  const persistedComposerSessionId =
    currentSession && !isCurrentDraftSession ? currentSession.id : null;
  const previewFileMap = useMemo(
    () => new Map(previewFiles.map((file) => [file.id, file] as const)),
    [previewFiles],
  );
  const budgetUsage = useMemo(() => {
    if (!currentSession?.messagesLoaded) {
      return {
        percentage: 0,
        ratio: 0,
        total: modelContextLimit,
        used: 0,
      };
    }

    if (currentSession.messages.length === 0) {
      return {
        percentage: 0,
        ratio: 0,
        total: modelContextLimit,
        used: 0,
      };
    }

    try {
      const selection = selectReplayHistoryWithinBudget({
        compactedContext: currentSession.compactedContext ?? null,
        currentTurnId: resolveActiveTurnId(currentSession.messages),
        history: currentSession.messages,
        maxContext: selectedProviderModel?.maxContext ?? modelContextLimit,
        maxOutputTokens: selectedProviderModel?.maxOutputTokens ?? null,
        modelCapabilities,
        previewFileMap,
        selectedModelUuid: modelId,
        systemPrompt: "",
        tokenizerKind: selectedProviderModel?.tokenizerKind,
        turnSummaries: currentSession.replayTurnSummaries ?? [],
      });
      const used = selection.estimatedTokens;
      const ratio = Math.min(used / modelContextLimit, 1);

      return {
        percentage: Math.round(ratio * 100),
        ratio,
        total: modelContextLimit,
        used,
      };
    } catch {
      return {
        percentage: 100,
        ratio: 1,
        total: modelContextLimit,
        used: modelContextLimit,
      };
    }
  }, [
    currentSession,
    modelCapabilities,
    modelContextLimit,
    modelId,
    previewFileMap,
    selectedProviderModel?.maxContext,
    selectedProviderModel?.maxOutputTokens,
    selectedProviderModel?.tokenizerKind,
  ]);
  const budgetColor = budgetUsage.ratio === 0 ? "var(--color-text-tertiary)" : resolveBudgetColor(budgetUsage.ratio);
  const budgetRingSize = 30;
  const budgetStrokeWidth = 2.5;
  const budgetRadius = (budgetRingSize - budgetStrokeWidth) / 2;
  const budgetCircumference = 2 * Math.PI * budgetRadius;
  const budgetDashOffset = budgetCircumference * (1 - budgetUsage.ratio);

  function showToast(message: string) {
    setToastMessage(message);
  }

  const handleEnhancePrompt = useCallback(async () => {
    const nextDraft = draft.trim();
    const activeChatId = useWorkspaceStore.getState().selectedSessionId;

    if (
      isEnhancingPrompt ||
      isSendingMessage ||
      !selectedProjectId ||
      !activeChatId ||
      isModelMissing ||
      nextDraft.length === 0
    ) {
      return;
    }

    clearChatError();
    const requestId = enhanceRequestIdRef.current + 1;
    enhanceRequestIdRef.current = requestId;
    enhanceOriginalDraftRef.current = draftRef.current;
    setIsEnhancingPrompt(true);

    try {
      const enhancedDraft = await enhanceWorkspacePrompt({
        chatId: activeChatId,
        draft: nextDraft,
        modelId,
        onDraft: (partialDraft) => {
          if (enhanceRequestIdRef.current !== requestId) {
            return;
          }

          setDraft(partialDraft);
        },
        projectId: selectedProjectId,
        reasoningLevel: selectedReasoningLevel,
        reasoningLevels: selectedProviderModel?.reasoningLevels,
      });
      if (enhanceRequestIdRef.current !== requestId) {
        return;
      }
      setDraft(enhancedDraft);
      enhanceOriginalDraftRef.current = null;
      focusComposer();
    } catch (error) {
      if (enhanceRequestIdRef.current === requestId) {
        if (enhanceOriginalDraftRef.current !== null) {
          setDraft(enhanceOriginalDraftRef.current);
        }

        if (!isInterruptedWorkspaceChatError(error)) {
          showToast("Wizzle could not enhance that prompt.");
        }
      }
    } finally {
      if (enhanceRequestIdRef.current === requestId) {
        enhanceOriginalDraftRef.current = null;
        setIsEnhancingPrompt(false);
      }
    }
  }, [
    clearChatError,
    draft,
    isEnhancingPrompt,
    isSendingMessage,
    isModelMissing,
    modelId,
    selectedProjectId,
    selectedReasoningLevel,
    selectedProviderModel?.reasoningLevels,
  ]);

  const cancelEnhancement = useCallback(() => {
    if (!isEnhancingPrompt) {
      return false;
    }

    enhanceRequestIdRef.current += 1;
    setIsEnhancingPrompt(false);
    void interruptWorkspacePromptEnhancement().catch(() => undefined);

    if (enhanceOriginalDraftRef.current !== null) {
      setDraft(enhanceOriginalDraftRef.current);
      enhanceOriginalDraftRef.current = null;
    }

    focusComposer();
    return true;
  }, [isEnhancingPrompt]);

  function buildQueuedSubmission(prompt: string, nextAttachments: PreviewFile[]): QueuedSubmission {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? `queue-${crypto.randomUUID()}`
        : `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      attachments: nextAttachments,
      id,
      prompt,
      status: "queued",
    };
  }

  function queueLabel(submission: QueuedSubmission) {
    const prompt = submission.prompt.trim();

    if (prompt.length > 0) {
      return prompt;
    }

    const attachmentCount = submission.attachments.length;
    return attachmentCount === 1 ? "1 attachment" : `${attachmentCount} attachments`;
  }

  function focusComposer() {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;

      if (!textarea) {
        return;
      }

      textarea.focus();
      const cursorPosition = textarea.value.length;
      textarea.setSelectionRange(cursorPosition, cursorPosition);
    });
  }

  function beginComposerEditSession(nextEdit: MessageEditState) {
    composerDraftBeforeEditRef.current = {
      attachments,
      draft,
      sessionId: selectedSessionId,
    };
    shouldRestoreComposerAfterEditRef.current = true;
    activeEditMessageIdRef.current = nextEdit.messageId;
    clearChatError();
    setDraft(nextEdit.prompt);
    setAttachments(nextEdit.attachments);
    focusComposer();
  }

  function mergeAttachments(
    nextAttachments: PreviewFile[],
    selectedCount: number,
    rejectedMessages: string[] = [],
  ) {
    const dedupedAttachments = nextAttachments.filter((attachment) => {
      const nextKey = dedupeAttachmentKey(attachment);

      return !attachments.some((currentAttachment) => dedupeAttachmentKey(currentAttachment) === nextKey);
    });
    const remainingSlots = Math.max(MAX_ATTACHMENTS - attachments.length, 0);
    const rejectedCount = rejectedMessages.length;

    if (remainingSlots === 0) {
      showToast("You can attach up to 5 items.");
      return;
    }

    const acceptedAttachments = dedupedAttachments.slice(0, remainingSlots);
    const unsupportedCount = Math.max(selectedCount - nextAttachments.length - rejectedCount, 0);
    const duplicateCount = Math.max(nextAttachments.length - dedupedAttachments.length, 0);
    const overflowCount = Math.max(dedupedAttachments.length - acceptedAttachments.length, 0);

    if (acceptedAttachments.length > 0) {
      setAttachments((current) => [...current, ...acceptedAttachments]);
    }

    if (unsupportedCount > 0 && (overflowCount > 0 || duplicateCount > 0)) {
      showToast("Some files were skipped. Only supported files and 5 total items are allowed.");
      return;
    }

    if (rejectedCount > 0) {
      showToast(
        rejectedCount === 1
          ? rejectedMessages[0] ?? "A file could not be attached."
          : `${rejectedCount} files could not be attached.`,
      );
      return;
    }

    if (unsupportedCount > 0) {
      showToast(
        modelCapabilities.includes("image")
          ? "Only supported text, markdown, code files, and images can be attached."
          : "The selected model supports text attachments only.",
      );
      return;
    }

    if (overflowCount > 0) {
      showToast("Only the first 5 attachments were kept.");
      return;
    }

    if (duplicateCount > 0) {
      showToast("Duplicate attachments were skipped.");
    }
  }

  async function addAttachments(files: File[]) {
    if (files.length === 0) {
      return;
    }

    clearChatError();
    const oversizedFiles = files.filter((file) => file.size > attachmentSourceLimit(file));
    const supportedFiles = files.filter((file) => file.size <= attachmentSourceLimit(file));
    const previewResults = await Promise.allSettled(
      supportedFiles.map((file) => createAttachmentPreview(file, modelCapabilities)),
    );
    const previews = previewResults
      .filter(
        (result): result is PromiseFulfilledResult<PreviewFile | null> => result.status === "fulfilled",
      )
      .map((result) => result.value)
      .filter((preview): preview is PreviewFile => Boolean(preview));
    const rejectedMessages = previewResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => {
        if (result.reason instanceof Error && result.reason.message.trim()) {
          return result.reason.message.trim();
        }

        return "A file could not be attached.";
      });
    mergeAttachments(
      previews,
      files.length,
      [
        ...oversizedFiles.map(
          (file) => `${file.name} is larger than ${attachmentSourceLimitLabel(file)} and cannot be attached.`,
        ),
        ...rejectedMessages,
      ],
    );
  }

  async function handleAttachmentSelection() {
    clearChatError();

    if (!selectedProjectId) {
      showToast("Select a project before attaching files.");
      return;
    }

    try {
      const { previews, rejectedMessages, selectedCount } = await pickAttachmentPreviews(
        selectedProjectId,
        modelCapabilities,
      );

      if (selectedCount === 0) {
        return;
      }

      mergeAttachments(previews, selectedCount, rejectedMessages);
    } catch {
      showToast("Wizzle could not attach those files.");
    }
  }

  async function handleSend() {
    const nextPrompt = draft.trim();

    if (isEnhancingPrompt) {
      return;
    }

    if (isSendingMessage) {
      if (nextPrompt.length === 0 && attachments.length === 0) {
        void interruptPrompt();
        return;
      }

      if (queuedSubmissionsRef.current.length >= MAX_QUEUED_SUBMISSIONS) {
        showToast("You can queue up to 6 prompts.");
        return;
      }

      setQueuedSubmissions((current) => [...current, buildQueuedSubmission(nextPrompt, attachments)]);
      setDraft("");
      setAttachments([]);
      showToast("Queued for after the current response.");
      clearChatError();
      return;
    }

    if (nextPrompt.length === 0 && attachments.length === 0) {
      return;
    }

    if (activeMessageEdit) {
      shouldRestoreComposerAfterEditRef.current = false;
    }

    // Clear as soon as send starts; restore only if the message was never accepted (#79).
    const draftSnapshot = nextPrompt;
    const attachmentSnapshot = attachments;
    setDraft("");
    setAttachments([]);

    window.dispatchEvent(new CustomEvent("wizzle:composer-send"));
    const result = await sendPrompt(nextPrompt, attachmentSnapshot);

    if (!result.accepted) {
      setDraft(draftSnapshot);
      setAttachments(attachmentSnapshot);
      showToast(result.error);
      return;
    }

    if (!result.ok && "error" in result && result.error) {
      showToast(result.error);
    }
  }

  function handleCancelEdit() {
    shouldRestoreComposerAfterEditRef.current = true;
    cancelMessageEdit();
  }

  useEffect(() => {
    queuedSubmissionsRef.current = queuedSubmissions;
  }, [queuedSubmissions]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  function rememberCurrentComposerState(key: string | null) {
    if (!key) {
      return;
    }

    composerMemoryRef.current.set(key, {
      attachments: attachmentsRef.current,
      draft: draftRef.current,
      queuedSubmissions: queuedSubmissionsRef.current,
    });
  }

  async function persistComposerStateForSession(sessionId: string | null) {
    if (!sessionId) {
      return;
    }

    await saveComposerState({
      draftText: draftRef.current,
      queuedMessages: queuedSubmissionsRef.current.map((submission) => ({
        attachments: submission.attachments,
        content: submission.prompt,
        id: submission.id,
        status: submission.status ?? "queued",
      })),
      sessionId,
    });
  }

  async function persistActiveComposerStateNow() {
    await persistComposerStateForSession(persistedComposerSessionIdRef.current);
  }

  useEffect(() => {
    const nextComposerKey = selectedSessionId ?? null;
    const previousComposerKey = activeComposerKeyRef.current;

    if (previousComposerKey !== nextComposerKey) {
      rememberCurrentComposerState(previousComposerKey);
      void persistComposerStateForSession(persistedComposerSessionIdRef.current).catch(() => undefined);
      activeComposerKeyRef.current = nextComposerKey;
    }

    persistedComposerSessionIdRef.current = persistedComposerSessionId;

    if (composerStateSaveTimeoutRef.current !== null) {
      window.clearTimeout(composerStateSaveTimeoutRef.current);
      composerStateSaveTimeoutRef.current = null;
    }

    if (!nextComposerKey) {
      setDraft("");
      setAttachments([]);
      setQueuedSubmissions([]);
      setIsComposerStateReady(false);
      return;
    }

    const cachedState = composerMemoryRef.current.get(nextComposerKey);

    if (cachedState) {
      setDraft(cachedState.draft);
      setAttachments(cachedState.attachments);
      setQueuedSubmissions(cachedState.queuedSubmissions);
      setIsComposerStateReady(Boolean(persistedComposerSessionId));
      return;
    }

    setDraft("");
    setAttachments([]);
    setQueuedSubmissions([]);

    if (!persistedComposerSessionId) {
      setIsComposerStateReady(false);
      return;
    }

    setIsComposerStateReady(false);
    let isCurrent = true;

    void loadComposerState(persistedComposerSessionId)
      .then((composerState) => {
        if (!isCurrent || activeComposerKeyRef.current !== nextComposerKey) {
          return;
        }

        setDraft(composerState.draftText);
        setAttachments([]);
        setQueuedSubmissions(
          composerState.queuedMessages.map((message) => ({
            attachments: message.attachments,
            id: message.id,
            prompt: message.content,
            status: message.status,
          })),
        );
        setIsComposerStateReady(true);
      })
      .catch(() => {
        if (isCurrent && activeComposerKeyRef.current === nextComposerKey) {
          setIsComposerStateReady(true);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [persistedComposerSessionId, selectedSessionId]);

  useEffect(() => {
    if (!persistedComposerSessionId || !isComposerStateReady) {
      return;
    }

    if (composerStateSaveTimeoutRef.current !== null) {
      window.clearTimeout(composerStateSaveTimeoutRef.current);
    }

    composerStateSaveTimeoutRef.current = window.setTimeout(() => {
      composerStateSaveTimeoutRef.current = null;
      void persistActiveComposerStateNow().catch(() => undefined);
    }, 400);

    return () => {
      if (composerStateSaveTimeoutRef.current !== null) {
        window.clearTimeout(composerStateSaveTimeoutRef.current);
        composerStateSaveTimeoutRef.current = null;
      }
    };
  }, [draft, isComposerStateReady, persistedComposerSessionId, queuedSubmissions]);

  useEffect(
    () => () => {
      rememberCurrentComposerState(activeComposerKeyRef.current);
      if (composerStateSaveTimeoutRef.current !== null) {
        window.clearTimeout(composerStateSaveTimeoutRef.current);
        composerStateSaveTimeoutRef.current = null;
      }
      void persistActiveComposerStateNow().catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (
      isSendingMessage ||
      isDispatchingQueuedPromptRef.current ||
      !queuedSubmissionsRef.current.some((submission) => (submission.status ?? "queued") === "queued")
    ) {
      return;
    }

    const nextSubmission = queuedSubmissionsRef.current.find(
      (submission) => (submission.status ?? "queued") === "queued",
    );

    if (!nextSubmission) {
      return;
    }

    isDispatchingQueuedPromptRef.current = true;
    clearChatError();
    setQueuedSubmissions((current) =>
      current.map((submission) =>
        submission.id === nextSubmission.id ? { ...submission, status: "sending" } : submission,
      ),
    );
    window.dispatchEvent(new CustomEvent("wizzle:composer-send"));
    void sendPrompt(nextSubmission.prompt, nextSubmission.attachments)
      .then((result) => {
        setQueuedSubmissions((current) => {
          // Accepted means the user message entered the session; drop queue item.
          if (result.accepted) {
            return current.filter((submission) => submission.id !== nextSubmission.id);
          }

          // Coalesced while a run is active: keep queued for wake drain (#29).
          if ("retryable" in result && result.retryable) {
            return current.map((submission) =>
              submission.id === nextSubmission.id
                ? { ...submission, status: "queued" }
                : submission,
            );
          }

          return current.map((submission) =>
            submission.id === nextSubmission.id ? { ...submission, status: "failed" } : submission,
          );
        });

        if (!result.accepted) {
          if (!("retryable" in result && result.retryable)) {
            showToast(result.error || "Queued prompt failed. Retry or delete it.");
          }
        } else if (!result.ok && "error" in result && result.error) {
          showToast(result.error);
        }
      })
      .catch(() => {
        setQueuedSubmissions((current) =>
          current.map((submission) =>
            submission.id === nextSubmission.id ? { ...submission, status: "failed" } : submission,
          ),
        );
        showToast("Queued prompt failed. Retry or delete it.");
      })
      .finally(() => {
        isDispatchingQueuedPromptRef.current = false;
        setQueueDrainTick((current) => current + 1);
      });
  }, [clearChatError, isSendingMessage, queueDrainTick, sendPrompt, queuedSubmissions]);

  // When finishSessionRun reports a coalesced wake, re-tick the queue drain (#29).
  useEffect(() => {
    const onSessionRunWake = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      const wakeSessionId = detail?.sessionId;
      if (wakeSessionId && selectedSessionId && wakeSessionId !== selectedSessionId) {
        return;
      }
      setQueueDrainTick((current) => current + 1);
    };

    window.addEventListener(SESSION_RUN_WAKE_EVENT, onSessionRunWake);
    return () => {
      window.removeEventListener(SESSION_RUN_WAKE_EVENT, onSessionRunWake);
    };
  }, [selectedSessionId]);

  useEffect(() => {
    if (activeMessageEdit) {
      if (activeEditMessageIdRef.current === activeMessageEdit.messageId) {
        return;
      }

      beginComposerEditSession(activeMessageEdit);
      return;
    }

    if (!activeEditMessageIdRef.current) {
      return;
    }

    const previousDraft = composerDraftBeforeEditRef.current;
    const shouldRestoreComposer = shouldRestoreComposerAfterEditRef.current;
    const shouldRestoreSession = previousDraft?.sessionId === selectedSessionId;

    activeEditMessageIdRef.current = null;
    composerDraftBeforeEditRef.current = null;
    shouldRestoreComposerAfterEditRef.current = true;

    if (!shouldRestoreComposer || !shouldRestoreSession) {
      return;
    }

    setDraft(previousDraft?.draft ?? "");
    setAttachments(previousDraft?.attachments ?? []);
    focusComposer();
  }, [activeMessageEdit, clearChatError, draft, attachments, selectedSessionId]);

  useEffect(() => {
    if (floatingEnhanceHideTimeoutRef.current !== null) {
      window.clearTimeout(floatingEnhanceHideTimeoutRef.current);
      floatingEnhanceHideTimeoutRef.current = null;
    }

    if (shouldShowFloatingEnhanceAction) {
      setRenderFloatingEnhanceAction(true);

      window.requestAnimationFrame(() => {
        setShowFloatingEnhanceActionState(true);
      });

      return;
    }

    setShowFloatingEnhanceActionState(false);

    if (!renderFloatingEnhanceAction) {
      return;
    }

    floatingEnhanceHideTimeoutRef.current = window.setTimeout(() => {
      setRenderFloatingEnhanceAction(false);
      floatingEnhanceHideTimeoutRef.current = null;
    }, 160);
  }, [renderFloatingEnhanceAction, shouldShowFloatingEnhanceAction]);

  useEffect(
    () => () => {
      if (floatingEnhanceHideTimeoutRef.current !== null) {
        window.clearTimeout(floatingEnhanceHideTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!toastMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setToastMessage(null);
    }, 2600);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [toastMessage]);

  useEffect(() => {
    if (!isModelSelectorOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (modelSelectorRef.current?.contains(event.target as Node)) {
        return;
      }

      setIsModelSelectorOpen(false);
    }

    function handleModelSelectorEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      setIsModelSelectorOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleModelSelectorEscape);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleModelSelectorEscape);
    };
  }, [isModelSelectorOpen]);

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (!canUseGlobalComposerCapture(event)) {
          return;
        }

        if (cancelEnhancement()) {
          event.preventDefault();
          return;
        }

        if (pendingToolApproval) {
          event.preventDefault();
          resolveToolApproval(false, pendingToolApproval.toolCallId);
          return;
        }

        if (isSendingMessage) {
          event.preventDefault();
          void interruptPrompt();
        }

        return;
      }

      const isEnhanceShortcut =
        event.key.toLowerCase() === ENHANCE_SHORTCUT_KEY &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;

      if (isEnhanceShortcut) {
        if (!canUseGlobalComposerCapture(event)) {
          return;
        }

        if (!hasEnhanceableDraft || isEnhancingPrompt || isSendingMessage) {
          return;
        }

        event.preventDefault();
        void handleEnhancePrompt();
        return;
      }

      if (!canUseGlobalComposerCapture(event)) {
        return;
      }

      if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        handleSend();
        return;
      }

      if (!isComposerCaptureKey(event)) {
        return;
      }

      event.preventDefault();
      clearChatError();
      setDraft((currentDraft) => `${currentDraft}${event.key}`);
      focusComposer();
    }

    function handleGlobalPaste(event: ClipboardEvent) {
      if (!canUseGlobalComposerCapture(event) || isEnhancingPrompt) {
        return;
      }

      const clipboardData = event.clipboardData;

      if (!clipboardData) {
        return;
      }

      const files = Array.from(clipboardData.files);
      const text = clipboardData.getData("text/plain");

      if (files.length === 0 && !text) {
        return;
      }

      event.preventDefault();
      clearChatError();

      if (text) {
        setDraft((currentDraft) => `${currentDraft}${text}`);
        focusComposer();
      }

      if (files.length > 0) {
        void addAttachments(files);
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown);
    window.addEventListener("paste", handleGlobalPaste);

    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
      window.removeEventListener("paste", handleGlobalPaste);
    };
  }, [
    cancelEnhancement,
    clearChatError,
    handleEnhancePrompt,
    hasEnhanceableDraft,
    isEnhancingPrompt,
    isSendingMessage,
    interruptPrompt,
    pendingToolApproval,
    resolveToolApproval,
  ]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const overlay = shimmerOverlayRef.current;

    if (!textarea || !overlay) {
      return;
    }

    overlay.scrollTop = textarea.scrollTop;
  }, [draft, isEnhancingPrompt]);

  useEffect(() => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    const minHeight = 20;
    const maxHeight = 256;

    textarea.style.height = "0px";

    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft, expanded]);

  return (
    <>
      {queuedSubmissions.length > 0 ? (
        <div className="mb-3 overflow-hidden rounded-[22px] border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel)_88%,transparent)] shadow-[0_10px_30px_rgba(0,0,0,0.16)] backdrop-blur-xl">
          <div className="flex flex-col">
            {queuedSubmissions.map((submission, index) => (
              <div
                className={[
                  "flex items-center gap-2.5 px-3.5 py-2.5 text-[12px] text-[var(--color-text-secondary)]",
                  submission.status === "failed" ? "bg-[color-mix(in_srgb,var(--color-danger)_8%,transparent)]" : "",
                  index > 0 ? "border-t border-[color-mix(in_srgb,var(--color-border)_60%,transparent)]" : "",
                ].join(" ")}
                key={submission.id}
              >
                <span className="flex shrink-0 items-center gap-0.5 text-[var(--color-text-tertiary)]">
                  <ChevronDown className="h-3 w-3" />
                  <CornerDownLeft className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate">{queueLabel(submission)}</span>
                {submission.status === "sending" ? (
                  <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-tertiary)]">
                    Sending
                  </span>
                ) : null}
                {submission.status === "failed" ? (
                  <span className="shrink-0 rounded-full border border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)] px-2 py-1 text-[11px] text-[var(--color-danger)]">
                    Failed
                  </span>
                ) : null}
                <div className="flex shrink-0 items-center gap-1">
                  {submission.status === "failed" ? (
                    <button
                      className="flex items-center gap-1 rounded-md px-1.5 py-0.75 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                      onClick={() => {
                        clearChatError();
                        setQueuedSubmissions((current) =>
                          current.map((currentSubmission) =>
                            currentSubmission.id === submission.id
                              ? { ...currentSubmission, status: "queued" }
                              : currentSubmission,
                          ),
                        );
                      }}
                      type="button"
                    >
                      <CornerDownLeft className="h-3 w-3" />
                      <span>Retry</span>
                    </button>
                  ) : null}
                  {(submission.status ?? "queued") === "queued" ? (
                    <button
                      className="flex items-center gap-1 rounded-md px-1.5 py-0.75 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                      onClick={() => {
                        setQueuedSubmissions((current) =>
                          current.filter((currentSubmission) => currentSubmission.id !== submission.id),
                        );
                        setDraft(submission.prompt);
                        setAttachments(submission.attachments);
                        focusComposer();
                      }}
                      type="button"
                    >
                      <Pencil className="h-3 w-3" />
                      <span>Edit</span>
                    </button>
                  ) : null}
                  <button
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.75 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={submission.status === "sending"}
                    onClick={() => {
                      setQueuedSubmissions((current) =>
                        current.filter((currentSubmission) => currentSubmission.id !== submission.id),
                      );
                    }}
                    type="button"
                  >
                    <Trash2 className="h-3 w-3" />
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="relative">
        {renderFloatingEnhanceAction ? (
          <button
            className={[
              "absolute -top-10 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.25 rounded-full border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel)_94%,transparent)] px-2.5 py-1 text-[var(--color-text)] shadow-[0_8px_20px_rgba(0,0,0,0.14)] backdrop-blur-xl transition-all duration-150 hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-hover)]",
              showFloatingEnhanceActionState
                ? "translate-y-0 scale-100 opacity-100"
                : "translate-y-1 scale-[0.98] opacity-0 pointer-events-none",
            ].join(" ")}
            onClick={() => {
              void handleEnhancePrompt();
            }}
            type="button"
          >
            <Sparkles className="h-[11px] w-[11px] text-[var(--color-text-secondary)]" />
            <span className="text-[10px] font-medium leading-none tracking-[0.01em] text-[var(--color-text)]">
              Enhance prompt
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-panel-muted)] px-1.5 py-0.5 text-[9px] leading-none text-[var(--color-text-secondary)]">
              {isMacPlatform ? <Command className="h-[10px] w-[10px]" /> : <span className="font-medium">Ctrl</span>}
              <span className="font-medium">E</span>
            </span>
          </button>
        ) : null}
        <div className="rounded-[24px] border border-[var(--color-border)] bg-[var(--color-composer)]">
          {activeMessageEdit ? (
            <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-[var(--color-text)]">
                  Editing last user turn
                </p>
                <p className="mt-0.5 text-[11px] leading-5 text-[var(--color-text-secondary)]">
                  Sending replaces the current turn, removes its current response, and marks the message as edited.
                </p>
              </div>
              <button
                className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={handleCancelEdit}
                type="button"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </button>
            </div>
          ) : null}
          <div className="relative px-6 pt-5 text-[14px] font-normal leading-5">
            <textarea
              ref={textareaRef}
              className={[
                "auto-hide-scrollbar w-full resize-none bg-transparent p-0 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-tertiary)]",
                isScrolling ? "is-scrolling" : "",
                isEnhancingPrompt ? "text-transparent caret-transparent selection:bg-transparent" : "",
              ].join(" ")}
              disabled={isEnhancingPrompt}
              data-native-context-menu
              maxLength={MAX_PROMPT_SIZE}
              onChange={(event) => {
                clearChatError();
                setDraft(event.currentTarget.value);
              }}
              onContextMenu={(event) => {
                event.stopPropagation();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  if (cancelEnhancement()) {
                    event.preventDefault();
                    return;
                  }

                  if (pendingToolApproval) {
                    event.preventDefault();
                    resolveToolApproval(false, pendingToolApproval.toolCallId);
                    return;
                  }

                  if (isSendingMessage) {
                    event.preventDefault();
                    void interruptPrompt();
                  }

                  return;
                }

                if (
                  event.key.toLowerCase() === ENHANCE_SHORTCUT_KEY &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.altKey &&
                  !event.shiftKey
                ) {
                  if (!hasEnhanceableDraft || isEnhancingPrompt || isSendingMessage) {
                    return;
                  }

                  event.preventDefault();
                  void handleEnhancePrompt();
                  return;
                }

                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);

                if (files.length === 0) {
                  return;
                }

                event.preventDefault();
                void addAttachments(files);
              }}
              onScroll={(event) => {
                handleScrollActivity();

                if (shimmerOverlayRef.current) {
                  shimmerOverlayRef.current.scrollTop = event.currentTarget.scrollTop;
                }
              }}
              placeholder={placeholder}
              rows={1}
              value={draft}
            />
            {isEnhancingPrompt ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-6 top-5 bottom-0 overflow-hidden"
                ref={shimmerOverlayRef}
              >
                <div className="composer-text-shimmer whitespace-pre-wrap break-words">
                  {draft}
                </div>
              </div>
            ) : null}
          </div>
          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-4 py-2">
              {attachments.map((attachment) => (
                <div
                  className="flex items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-2.5 py-1.5 text-[12px] text-[var(--color-text-secondary)]"
                  key={attachment.id}
                >
                  <span className="text-[var(--color-text)]">{fileIcon(attachment.kind)}</span>
                  <span className="max-w-[180px] truncate">{attachment.name}</span>
                  <button
                    aria-label={`Remove ${attachment.name}`}
                    className="rounded-full p-0.5 text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                    onClick={() => {
                      clearChatError();
                      setAttachments((current) =>
                        current.filter((currentAttachment) => currentAttachment.id !== attachment.id),
                      );
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex items-center px-4 pb-2"> 
            <div className="flex items-center gap-3">
              <button
                className="flex h-10 w-10 items-center justify-center rounded-2xl text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                disabled={isEnhancingPrompt}
                onClick={() => {
                  void handleAttachmentSelection();
                }}
                title="Attach file or image"
                type="button"
              >
                <Paperclip className="h-4 w-4" />
              </button>

              <div className="relative inline-flex items-center">
                <span
                  className={[
                    "pointer-events-none pr-5 text-[14px] font-normal leading-none tracking-[0.01em]",
                    permissionMode === "full-access"
                      ? "text-[#ff9b6b]"
                      : "text-[var(--color-text-secondary)]",
                  ].join(" ")}
                >
                  {permissionModeLabel}
                </span>
                <select
                  className={[
                    "absolute inset-0 w-full cursor-pointer appearance-none opacity-0 outline-none",
                  ].join(" ")}
                  onChange={(event) => setPermissionMode(event.currentTarget.value as PermissionMode)}
                  value={permissionMode}
                >
                  <option value="full-access">Full access</option>
                  <option value="manual-approve">Manual approve</option>
                </select>
                <ChevronDown
                  className={[
                    "pointer-events-none absolute right-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2",
                    permissionMode === "full-access"
                      ? "text-[#ff9b6b]"
                      : "text-[var(--color-text-secondary)]",
                  ].join(" ")}
                />
              </div>
            </div>

            <div className="flex-1" />

            <div className="flex items-center gap-3">
              <div className="group relative">
                <button
                  aria-label={`Replay budget used ${budgetUsage.percentage}%`}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] focus-visible:bg-[var(--color-panel-hover)] focus-visible:outline-none"
                  type="button"
                >
                  <svg
                    aria-hidden="true"
                    className="overflow-visible"
                    height={budgetRingSize}
                    viewBox={`0 0 ${budgetRingSize} ${budgetRingSize}`}
                    width={budgetRingSize}
                  >
                    <circle
                      cx={budgetRingSize / 2}
                      cy={budgetRingSize / 2}
                      fill="none"
                      r={budgetRadius}
                      stroke="color-mix(in srgb, var(--color-border) 78%, transparent)"
                      strokeWidth={budgetStrokeWidth}
                    />
                    <circle
                      cx={budgetRingSize / 2}
                      cy={budgetRingSize / 2}
                      fill="none"
                      r={budgetRadius}
                      stroke={budgetColor}
                      strokeDasharray={budgetCircumference}
                      strokeDashoffset={budgetDashOffset}
                      strokeLinecap="round"
                      strokeWidth={budgetStrokeWidth}
                      transform={`rotate(-90 ${budgetRingSize / 2} ${budgetRingSize / 2})`}
                    />
                  </svg>
                  <span className="pointer-events-none absolute text-[8px] font-semibold leading-none text-[var(--color-text)]">
                    {budgetUsage.percentage}
                  </span>
                </button>
                <div className="pointer-events-none absolute right-0 bottom-full z-20 mb-2 w-[220px] translate-y-1 rounded-[18px] border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel)_94%,transparent)] p-3 text-left opacity-0 shadow-[0_14px_36px_rgba(0,0,0,0.22)] backdrop-blur-xl transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
                  <p className="text-[12px] font-medium text-[var(--color-text)]">
                    Replay Budget
                  </p>
                  <div className="mt-2 space-y-1 text-[11px] text-[var(--color-text-secondary)]">
                    <div className="flex items-center justify-between gap-3">
                      <span>Used</span>
                      <span className="text-[var(--color-text)]">
                        {formatTokenCount(budgetUsage.used)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Total</span>
                      <span className="text-[var(--color-text)]">
                        {formatTokenCount(budgetUsage.total)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Usage</span>
                      <span className="text-[var(--color-text)]">
                        {budgetUsage.percentage}%
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div
                className="relative"
                data-model-selector
                ref={modelSelectorRef}
              >
                <button
                  aria-expanded={isModelSelectorOpen}
                  className="inline-flex max-w-[260px] items-center gap-1.5 rounded-full px-2 py-1 text-[14px] font-normal leading-none tracking-[0.01em] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                  disabled={providerModels.length === 0}
                  onClick={() => {
                    setIsModelSelectorOpen((current) => !current);
                    setModelSearch("");
                  }}
                  type="button"
                >
                  <span className="min-w-0 truncate">{modelIdLabel}</span>
                  {selectedReasoningLevel ? (
                    <span className="hidden shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--color-text-tertiary)] sm:inline">
                      {reasoningLevelLabel}
                    </span>
                  ) : null}
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-secondary)]" />
                </button>

                {isModelSelectorOpen ? (
                  <div className="absolute right-0 bottom-full z-30 mb-2 w-[340px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[20px] border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel)_96%,transparent)] shadow-[0_18px_48px_rgba(0,0,0,0.26)] backdrop-blur-xl">
                    <div className="border-b border-[var(--color-border)] p-2.5">
                      <label className="flex h-9 items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[12px] text-[var(--color-text-tertiary)]">
                        <Search className="h-3.5 w-3.5 shrink-0" />
                        <input
                          autoFocus
                          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-tertiary)]"
                          onChange={(event) => setModelSearch(event.currentTarget.value)}
                          placeholder="Search models or providers"
                          value={modelSearch}
                        />
                      </label>
                    </div>

                    {selectedReasoningLevels.length > 0 ? (
                      <div className="border-b border-[var(--color-border)] px-3 py-2">
                        <div className="mb-1.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">
                          Reasoning
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {selectedReasoningLevels.map((level) => {
                            const isSelectedLevel = level === selectedReasoningLevel;
                            const label = level.charAt(0).toUpperCase() + level.slice(1);

                            return (
                              <button
                                className={[
                                  "rounded-full border px-2.5 py-1 text-[12px] transition",
                                  isSelectedLevel
                                    ? "border-[var(--color-border-strong)] bg-[var(--color-accent)] text-[var(--color-accent-foreground)]"
                                    : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]",
                                ].join(" ")}
                                key={level}
                                onClick={() => setReasoningLevel(level)}
                                type="button"
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}

                    <div className="auto-hide-scrollbar max-h-[320px] overflow-y-auto py-1">
                      {filteredModelsByProvider.length === 0 ? (
                        <div className="px-3 py-5 text-center text-[13px] text-[var(--color-text-tertiary)]">
                          No models match that search.
                        </div>
                      ) : (
                        filteredModelsByProvider.map(([providerName, models]) => (
                          <div className="py-1" key={providerName}>
                            <div className="px-3 py-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">
                              {providerName}
                            </div>
                            <div className="space-y-0.5 px-1.5">
                              {models.map((model) => {
                                const isSelectedModel = model.id === modelId;

                                return (
                                  <button
                                    className={[
                                      "flex w-full items-center gap-2 rounded-2xl px-2.5 py-2 text-left transition",
                                      isSelectedModel
                                        ? "bg-[var(--color-panel-active)] text-[var(--color-text)]"
                                        : "text-[var(--color-text-secondary)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]",
                                    ].join(" ")}
                                    key={model.id}
                                    onClick={() => {
                                      setModelId(model.id);
                                      setReasoningLevel(model.reasoningLevels[0] ?? "");
                                      setIsModelSelectorOpen(false);
                                      setModelSearch("");
                                    }}
                                    type="button"
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-[13px]">
                                        {model.displayName ?? model.modelId}
                                      </div>
                                      <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-tertiary)]">
                                        {model.modelId}
                                      </div>
                                    </div>
                                    {model.reasoningLevels.length > 0 ? (
                                      <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-tertiary)]">
                                        {model.reasoningLevels.join(", ")}
                                      </span>
                                    ) : null}
                                    {isSelectedModel ? (
                                      <Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-text)]" />
                                    ) : null}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </div>

              <button
                className={[
                  "flex h-10 w-10 items-center justify-center rounded-full transition",
                  isDisabled
                    ? "cursor-not-allowed bg-[var(--color-panel-muted)] text-[var(--color-text-tertiary)]"
                    : "bg-[var(--color-send-button)] text-[var(--color-send-button-foreground)] hover:bg-[var(--color-send-button-hover)]",
                ].join(" ")}
                disabled={isDisabled}
                onClick={handleSend}
                title={shouldShowInterrupt ? "Interrupt response" : isSendingMessage ? "Queue message" : "Send message"}
              >
                {shouldShowInterrupt ? (
                  <Square className="h-3.5 w-3.5 fill-current" />
                ) : (
                  <ArrowUp className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
      {toastMessage ? (
        <div className="pointer-events-none fixed bottom-6 right-6 z-[120] rounded-2xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel)_92%,transparent)] px-3.5 py-2 text-[12px] font-medium text-[var(--color-text)] shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          {toastMessage}
        </div>
      ) : null}
    </>
  );
}
