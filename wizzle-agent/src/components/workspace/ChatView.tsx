import { ArrowDown, FolderOpenDot } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useScrollActivity } from "../../hooks/use-scroll-activity";
import { useWorkspaceStore } from "../../store/workspace-store";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";

export function ChatView() {
  const previewFiles = useWorkspaceStore((state) => state.previewFiles);
  const projects = useWorkspaceStore((state) => state.projects);
  const selectedProjectId = useWorkspaceStore((state) => state.selectedProjectId);
  const selectedSessionId = useWorkspaceStore((state) => state.selectedSessionId);
  const draftSessionProjectId = useWorkspaceStore((state) => state.draftSessionProjectId);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollAfterSendRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const { handleScrollActivity, isScrolling } = useScrollActivity();

  const currentProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const isDraftSession = currentProject?.id === draftSessionProjectId && selectedSessionId === null;
  const currentSession = isDraftSession
    ? null
    : currentProject?.sessions.find((session) => session.id === selectedSessionId) ??
      currentProject?.sessions[0];
  const fileMap = new Map(previewFiles.map((file) => [file.id, file]));
  const currentMessages = currentSession?.messages ?? [];
  const hasMessages = currentMessages.length > 0;

  useEffect(() => {
    function handleComposerSend() {
      shouldScrollAfterSendRef.current = true;
    }

    window.addEventListener("wizzle:composer-send", handleComposerSend);

    return () => {
      window.removeEventListener("wizzle:composer-send", handleComposerSend);
    };
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;

    if (!container || !hasMessages) {
      return;
    }

    if (shouldScrollAfterSendRef.current) {
      shouldScrollAfterSendRef.current = false;
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    if (distanceFromBottom < 80) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    }
  }, [currentSession?.messages, hasMessages]);

  function updateScrollState() {
    const container = scrollContainerRef.current;

    if (!container) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    setShowScrollToBottom(distanceFromBottom > 120);
  }

  function scrollToBottom() {
    const container = scrollContainerRef.current;

    if (!container) {
      return;
    }

    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }

  if (!currentProject || (!currentSession && !isDraftSession)) {
    return null;
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
            updateScrollState();
          }}
          ref={scrollContainerRef}
        >
          <div className="mx-auto flex max-w-[920px] flex-col gap-4">
            {currentMessages.map((message, index) => (
              <MessageBubble
                fileMap={fileMap}
                isLatest={index === currentMessages.length - 1}
                key={message.id}
                message={message}
                onOpenFile={openFile}
              />
            ))}
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
      <div className="px-8 pb-7">
        <div className="mx-auto max-w-[920px]">
          <Composer placeholder="Ask Wizzle to inspect, edit, or debug this project" />
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
        <Composer expanded placeholder="Ask Wizzle what to build, fix, or explain" />
      </div>
    </div>
  );
}
