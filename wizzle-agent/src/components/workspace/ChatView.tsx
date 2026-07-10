import { ArrowDown, FolderOpenDot } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useScrollActivity } from "../../hooks/use-scroll-activity";
import {
  hasEarlierUserTurns,
  initialVisibleTurnCount,
  nextVisibleTurnCount,
  reconcileVisibleTurnCountAfterHydrate,
  visibleRawStartIndexForTurns,
} from "../../lib/chat-turn-pagination";
import { interleaveContextStatus } from "../../lib/context-status";
import { buildDisplayMessages } from "../../lib/message-parts";
import { useWorkspaceStore } from "../../store/workspace-store";
import type { DisplayMessage, SessionEvent } from "../../types/workspace";
import { Composer } from "./Composer";
import { ContextStatusDivider } from "./ContextStatusDivider";
import { MessageBubble } from "./MessageBubble";

import { ToolApprovalPrompt } from "./ToolApprovalPrompt";

const AUTO_SCROLL_RESUME_DELAY_MS = 420;
const BOTTOM_SNAP_THRESHOLD_PX = 80;

function isNearBottom(container: HTMLDivElement, threshold = BOTTOM_SNAP_THRESHOLD_PX) {
  const distanceFromBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight;
  return distanceFromBottom <= threshold;
}

function displayIndexForRawBoundary(messages: DisplayMessage[], rawBoundary: number) {
  const boundary = Math.max(0, rawBoundary);
  let consumedRawMessages = 0;

  for (let index = 0; index < messages.length; index += 1) {
    if (consumedRawMessages >= boundary) {
      return index;
    }

    consumedRawMessages += messages[index]?.messages.length ?? 0;
    if (consumedRawMessages >= boundary) {
      return index + 1;
    }
  }

  return messages.length;
}

function collapseContextEvents(events: SessionEvent[]) {
  const eventByPosition = new Map<number, SessionEvent>();

  for (const event of events) {
    const existing = eventByPosition.get(event.afterMessageCount);
    if (
      !existing ||
      event.updatedAtMs > existing.updatedAtMs ||
      (event.updatedAtMs === existing.updatedAtMs && event.phase === "compacted")
    ) {
      eventByPosition.set(event.afterMessageCount, event);
    }
  }

  return Array.from(eventByPosition.values()).sort(
    (left, right) =>
      left.afterMessageCount - right.afterMessageCount || left.createdAtMs - right.createdAtMs,
  );
}

export function ChatView() {
  const activeMessageEdit = useWorkspaceStore((state) => state.activeMessageEdit);
  const sessionStreamErrors = useWorkspaceStore((state) => state.sessionStreamErrors);
  const loadingSessionId = useWorkspaceStore((state) => state.loadingSessionId);
  const previewFiles = useWorkspaceStore((state) => state.previewFiles);
  const draftSessions = useWorkspaceStore((state) => state.draftSessions);
  const projects = useWorkspaceStore((state) => state.projects);
  const selectedProjectId = useWorkspaceStore((state) => state.selectedProjectId);
  const selectedSessionId = useWorkspaceStore((state) => state.selectedSessionId);
  const sendingSessionIds = useWorkspaceStore((state) => state.sendingSessionIds);
  // Per selected session only — background runs on other sessions must not block edit UI.
  const isSendingMessage = Boolean(
    selectedSessionId && sendingSessionIds.includes(selectedSessionId),
  );
  const openFile = useWorkspaceStore((state) => state.openFile);
  const startMessageEdit = useWorkspaceStore((state) => state.startMessageEdit);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollAfterSendRef = useRef(false);
  const shouldScrollAfterSessionChangeRef = useRef(false);
  const autoScrollEnabledRef = useRef(true);
  const autoScrollResumeTimeoutRef = useRef<number | null>(null);
  const previousSessionIdRef = useRef<string | null>(null);
  const lastEffectSessionIdRef = useRef<string | null>(null);
  const previousMessageCountRef = useRef(0);
  const prependRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [visibleTurnCount, setVisibleTurnCount] = useState(() => initialVisibleTurnCount());
  const { handleScrollActivity, isScrolling } = useScrollActivity();

  const currentProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const currentDraftSession = currentProject ? draftSessions[currentProject.id] ?? null : null;
  const isDraftSession = currentDraftSession?.id === selectedSessionId;
  const currentSession = isDraftSession
    ? currentDraftSession
    : currentProject?.sessions.find((session) => session.id === selectedSessionId);
  const isSessionHistoryLoading = currentSession
    ? !currentSession.messagesLoaded && loadingSessionId === currentSession.id
    : false;
  const fileMap = useMemo(() => new Map(previewFiles.map((file) => [file.id, file])), [previewFiles]);
  const currentMessages = currentSession?.messages ?? [];
  const userTurnStartIndexes = useMemo(
    () =>
      currentMessages.reduce<number[]>((indexes, message, index) => {
        if (message.role === "user") {
          indexes.push(index);
        }

        return indexes;
      }, []),
    [currentMessages],
  );
  const totalTurnCount = userTurnStartIndexes.length;
  const visibleRawStartIndex = useMemo(
    () => visibleRawStartIndexForTurns(userTurnStartIndexes, visibleTurnCount),
    [userTurnStartIndexes, visibleTurnCount],
  );
  const visibleRawMessages = useMemo(
    () => currentMessages.slice(visibleRawStartIndex),
    [currentMessages, visibleRawStartIndex],
  );
  const displayMessages = useMemo(() => buildDisplayMessages(visibleRawMessages), [visibleRawMessages]);
  const visibleMessages = displayMessages;
  const contextEvents = useMemo<Array<Pick<SessionEvent, "afterMessageCount" | "id" | "phase">>>(
    () =>
      collapseContextEvents(currentSession?.events ?? [])
        .filter(
          (event) =>
            event.afterMessageCount >= visibleRawStartIndex &&
            event.afterMessageCount <= currentMessages.length,
        )
        .map((event) => ({
          ...event,
          afterMessageCount: displayIndexForRawBoundary(
            visibleMessages,
            event.afterMessageCount - visibleRawStartIndex,
          ),
        })),
    [currentMessages.length, currentSession?.events, visibleMessages, visibleRawStartIndex],
  );
  const chatItems = useMemo(
    () => interleaveContextStatus(visibleMessages, contextEvents),
    [contextEvents, visibleMessages],
  );
  const hasMessages = displayMessages.length > 0;
  const hasEarlierTurns = hasEarlierUserTurns(totalTurnCount, visibleTurnCount);
  const latestUserMessage = useMemo(
    () =>
      [...currentMessages]
        .reverse()
        .find((message) => message.role === "user") ?? null,
    [currentMessages],
  );
  const latestUserMessageId = latestUserMessage?.id ?? null;
  const latestUserMessageIndex = useMemo(
    () =>
      latestUserMessageId
        ? currentMessages.findIndex((message) => message.id === latestUserMessageId)
        : -1,
    [currentMessages, latestUserMessageId],
  );
  const latestUserTurnIsStreaming = useMemo(() => {
    if (latestUserMessageIndex < 0) {
      return false;
    }

    const latestUserTurnMessages = latestUserMessage?.turnId
      ? currentMessages.filter((message) => message.turnId === latestUserMessage.turnId)
      : currentMessages.slice(latestUserMessageIndex);

    return latestUserTurnMessages.some((message) => message.status === "streaming");
  }, [currentMessages, latestUserMessage, latestUserMessageIndex]);
  const canEditLatestUserTurn =
    Boolean(latestUserMessageId) &&
    latestUserMessage?.isStored !== false &&
    !isSendingMessage &&
    !latestUserTurnIsStreaming &&
    !isDraftSession;
  const sessionStreamError = useMemo(() => {
    const sessionId = currentSession?.id ?? selectedSessionId;
    if (!sessionId) {
      return null;
    }
    return sessionStreamErrors[sessionId] ?? null;
  }, [currentSession?.id, selectedSessionId, sessionStreamErrors]);

  useEffect(() => {
    function handleComposerSend() {
      shouldScrollAfterSendRef.current = true;
    }

    window.addEventListener("wizzle:composer-send", handleComposerSend);

    return () => {
      window.removeEventListener("wizzle:composer-send", handleComposerSend);
    };
  }, []);

  useEffect(
    () => () => {
      if (autoScrollResumeTimeoutRef.current !== null) {
        window.clearTimeout(autoScrollResumeTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const nextSessionId = currentSession?.id ?? null;
    const sessionChanged = lastEffectSessionIdRef.current !== nextSessionId;

    if (sessionChanged) {
      if (autoScrollResumeTimeoutRef.current !== null) {
        window.clearTimeout(autoScrollResumeTimeoutRef.current);
        autoScrollResumeTimeoutRef.current = null;
      }

      autoScrollEnabledRef.current = true;
      lastEffectSessionIdRef.current = nextSessionId;
      previousMessageCountRef.current = currentMessages.length;
      prependRestoreRef.current = null;
      // Full first page always — do not clamp to totalTurnCount while history is empty (I-1).
      setVisibleTurnCount(initialVisibleTurnCount());
      setShowScrollToBottom(false);
      return;
    }

    // History may hydrate after session select; unstick a too-small window (I-1).
    const reconciled = reconcileVisibleTurnCountAfterHydrate(totalTurnCount, visibleTurnCount);
    if (reconciled !== visibleTurnCount) {
      setVisibleTurnCount(reconciled);
      return;
    }

    const prependedScrollState = prependRestoreRef.current;

    if (prependedScrollState) {
      prependRestoreRef.current = null;

      requestAnimationFrame(() => {
        const container = scrollContainerRef.current;

        if (!container) {
          return;
        }

        container.scrollTop =
          container.scrollHeight - prependedScrollState.scrollHeight + prependedScrollState.scrollTop;
        updateScrollState();
      });

      return;
    }

    const container = scrollContainerRef.current;

    if (!container || !hasMessages) {
      previousMessageCountRef.current = currentMessages.length;
      return;
    }

    const previousMessageCount = previousMessageCountRef.current;
    previousMessageCountRef.current = currentMessages.length;

    if (shouldScrollAfterSendRef.current && autoScrollEnabledRef.current) {
      shouldScrollAfterSendRef.current = false;
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      return;
    }

    shouldScrollAfterSendRef.current = false;

    if (!autoScrollEnabledRef.current) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    if (distanceFromBottom < BOTTOM_SNAP_THRESHOLD_PX) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      return;
    }

    if (currentMessages.length > previousMessageCount && distanceFromBottom < 200) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    }
  }, [currentMessages, currentSession?.id, hasMessages, totalTurnCount, visibleTurnCount]);

  useLayoutEffect(() => {
    const nextSessionId = currentSession?.id ?? null;
    const sessionChanged = previousSessionIdRef.current !== nextSessionId;

    if (sessionChanged) {
      previousSessionIdRef.current = nextSessionId;
      shouldScrollAfterSessionChangeRef.current = true;
    }

    if (!shouldScrollAfterSessionChangeRef.current) {
      return;
    }

    const container = scrollContainerRef.current;
    const bottomAnchor = bottomAnchorRef.current;

    if (!container) {
      return;
    }

    const scrollToLatest = () => {
      if (bottomAnchor) {
        bottomAnchor.scrollIntoView({ block: "end" });
      }

      container.scrollTop = container.scrollHeight;
      updateScrollState("programmatic");
    };

    scrollToLatest();

    requestAnimationFrame(() => {
      scrollToLatest();
      shouldScrollAfterSessionChangeRef.current = false;
    });
  }, [selectedSessionId, currentSession?.id, visibleRawStartIndex, hasMessages]);

  function updateScrollState(source: "manual" | "programmatic" = "programmatic") {
    const container = scrollContainerRef.current;

    if (!container) {
      return;
    }

    const nearBottom = isNearBottom(container);
    setShowScrollToBottom(!nearBottom);

    if (source !== "manual") {
      return;
    }

    if (!nearBottom) {
      autoScrollEnabledRef.current = false;

      if (autoScrollResumeTimeoutRef.current !== null) {
        window.clearTimeout(autoScrollResumeTimeoutRef.current);
        autoScrollResumeTimeoutRef.current = null;
      }

      return;
    }

    if (autoScrollResumeTimeoutRef.current !== null) {
      window.clearTimeout(autoScrollResumeTimeoutRef.current);
    }

    autoScrollResumeTimeoutRef.current = window.setTimeout(() => {
      const latestContainer = scrollContainerRef.current;

      if (latestContainer && isNearBottom(latestContainer)) {
        autoScrollEnabledRef.current = true;
      }

      autoScrollResumeTimeoutRef.current = null;
    }, AUTO_SCROLL_RESUME_DELAY_MS);
  }

  function scrollToBottom() {
    const container = scrollContainerRef.current;

    if (!container) {
      return;
    }

    autoScrollEnabledRef.current = true;

    if (autoScrollResumeTimeoutRef.current !== null) {
      window.clearTimeout(autoScrollResumeTimeoutRef.current);
      autoScrollResumeTimeoutRef.current = null;
    }

    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }

  function loadPreviousMessages() {
    const container = scrollContainerRef.current;

    if (!container || !hasEarlierTurns) {
      return;
    }

    prependRestoreRef.current = {
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    };
    setVisibleTurnCount((currentCount) => nextVisibleTurnCount(totalTurnCount, currentCount));
  }

  if (!currentProject) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10">
        <div className="w-full max-w-[930px]">
          <div className="flex flex-col items-center text-center">
            <div className="mb-6 flex h-24 w-24 items-center justify-center rounded-[32px] bg-[var(--color-panel-muted)] ring-1 ring-[var(--color-border)]">
              <FolderOpenDot className="h-11 w-11 text-[var(--color-text)]" />
            </div>
            <h1 className="text-[2rem] font-semibold tracking-[-0.05em] text-[var(--color-text)]">
              Add a project to get started
            </h1>
            <p className="mt-3 max-w-[460px] text-[14px] leading-7 text-[var(--color-text-secondary)]">
              Choose a local folder from the left sidebar and Wizzle will create its local project state inside your home directory.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!currentSession) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10">
        <div className="w-full max-w-[930px]">
          <div className="flex flex-col items-center text-center">
            <div className="mb-6 flex h-24 w-24 items-center justify-center rounded-[32px] bg-[var(--color-panel-muted)] ring-1 ring-[var(--color-border)]">
              <FolderOpenDot className="h-11 w-11 text-[var(--color-text)]" />
            </div>
            <h1 className="text-[2rem] font-semibold tracking-[-0.05em] text-[var(--color-text)]">
              Choose a session to start
            </h1>
            <p className="mt-3 max-w-[460px] text-[14px] leading-7 text-[var(--color-text-secondary)]">
              Create a new session from the sidebar, then Wizzle will open the chat workspace here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (isSessionHistoryLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10">
        <div className="w-full max-w-[930px]">
          <div className="flex flex-col items-center text-center">
            <div className="mb-6 flex h-24 w-24 items-center justify-center rounded-[32px] bg-[var(--color-panel-muted)] ring-1 ring-[var(--color-border)]">
              <FolderOpenDot className="h-11 w-11 text-[var(--color-text)]" />
            </div>
            <h1 className="text-[2rem] font-semibold tracking-[-0.05em] text-[var(--color-text)]">
              Loading session
            </h1>
            <p className="mt-3 max-w-[460px] text-[14px] leading-7 text-[var(--color-text-secondary)]">
              Wizzle is loading the selected chat history before we continue.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return hasMessages ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          className={[
            "auto-hide-scrollbar min-h-0 h-full overflow-y-auto px-8 pb-6 pt-8",
            isScrolling ? "is-scrolling" : "",
          ].join(" ")}
          onScroll={() => {
            handleScrollActivity();
            updateScrollState("manual");

            if (scrollContainerRef.current && scrollContainerRef.current.scrollTop <= 80) {
              loadPreviousMessages();
            }
          }}
          ref={scrollContainerRef}
        >
          <div className="mx-auto flex max-w-[920px] flex-col gap-4">
            {hasEarlierTurns ? (
              <div className="flex justify-center pb-2">
                <button
                  className="rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] px-3.5 py-1.5 text-[12px] text-[var(--color-text-secondary)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                  onClick={loadPreviousMessages}
                  type="button"
                >
                  Show earlier turns
                </button>
              </div>
            ) : null}
            {chatItems.map((item, index) => {
              if (item.type === "context-status") {
                return (
                  <ContextStatusDivider
                    key={`context-status-${item.eventId}-${index}`}
                    phase={item.phase}
                  />
                );
              }

              const message = item.message;

              return (
                <MessageBubble
                  canEditUserMessage={
                    message.role === "user" &&
                    message.id === latestUserMessageId &&
                    canEditLatestUserTurn &&
                    activeMessageEdit?.messageId !== message.id
                  }
                  fileMap={fileMap}
                  inlineStreamError={
                    sessionStreamError &&
                    (message.id === sessionStreamError.turnId ||
                      message.messages.some(
                        (entry) => entry.turnId === sessionStreamError.turnId,
                      ))
                      ? // Prefer the last bubble of the failed turn (assistant if present).
                        message.role === "assistant" ||
                        !visibleMessages.some(
                          (other) =>
                            other.role === "assistant" &&
                            (other.id === sessionStreamError.turnId ||
                              other.messages.some(
                                (entry) => entry.turnId === sessionStreamError.turnId,
                              )),
                        )
                        ? sessionStreamError.message
                        : null
                      : null
                  }
                  isEditingUserMessage={activeMessageEdit?.messageId === message.id}
                  isLatest={index === chatItems.length - 1}
                  key={message.id}
                  message={message}
                  onEditUserMessage={({ attachments, messageId, prompt, turnId }) => {
                    if (!currentProject || !currentSession) {
                      return;
                    }

                    startMessageEdit({
                      attachments,
                      messageId,
                      projectId: currentProject.id,
                      prompt,
                      sessionId: currentSession.id,
                      turnId,
                    });
                  }}
                  onOpenFile={openFile}
                />
              );
            })}
            <div aria-hidden className="h-px w-full shrink-0" ref={bottomAnchorRef} />
          </div>
        </div>
        {showScrollToBottom ? (
          <button
            aria-label="Scroll to latest message"
            className="absolute bottom-5 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-panel)] text-[var(--color-text-secondary)] shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            onClick={scrollToBottom}
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <div className="px-8 pb-[14px]">
        <div className="mx-auto max-w-[920px]">
          <ToolApprovalPrompt />
          <Composer
            placeholder="Ask Wizzle to inspect, edit, or debug this project"
            showFloatingEnhanceAction={!showScrollToBottom}
          />
        </div>
      </div>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10">
      <div className="w-full max-w-[930px]">
        <div className="mb-12 flex flex-col items-center text-center">
          <div className="mb-6 flex h-24 w-24 items-center justify-center rounded-[32px] bg-[var(--color-panel-muted)] ring-1 ring-[var(--color-border)]">
            <FolderOpenDot className="h-11 w-11 text-[var(--color-text)]" />
          </div>
          <h1 className="text-[2.3rem] font-semibold tracking-[-0.05em] text-[var(--color-text)]">
            What should we work on?
          </h1>
        </div>
        <ToolApprovalPrompt />
        <Composer
          expanded
          placeholder="Ask Wizzle what to build, fix, or explain"
          showFloatingEnhanceAction
        />
      </div>
    </div>
  );
}
