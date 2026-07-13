import {
  ArrowDown,
  Bot,
  ChevronDown,
  ChevronRight,
  Eye,
  LoaderCircle,
  Square,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useWindowDrag } from "../../hooks/use-window-drag";
import { CLOSE_SUBAGENT_VIEW_EVENT } from "../../lib/app-window-events";
import {
  workspaceSubagentManager,
  type SubagentSnapshot,
} from "../../lib/agent/subagent-manager";
import { buildDisplayMessages } from "../../lib/message-parts";
import type { PreviewFile } from "../../types/workspace";
import { MessageBubble } from "./MessageBubble";
import { ToolApprovalPrompt } from "./ToolApprovalPrompt";

function roleLabel(name: SubagentSnapshot["name"]) {
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

function statusLabel(status: SubagentSnapshot["status"]) {
  return status === "waiting_permission" ? "Waiting for permission" : status.replace("_", " ");
}

function formatTime(value: number | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

function formatElapsed(start: number, end: number | null, nowMs: number) {
  const seconds = Math.max(0, Math.round(((end ?? nowMs) - start) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function isActive(task: SubagentSnapshot) {
  return task.status === "working" || task.status === "waiting_permission";
}

function useSessionSubagents(sessionId: string | null) {
  const [tasks, setTasks] = useState<SubagentSnapshot[]>([]);

  useEffect(() => {
    if (!sessionId) {
      setTasks([]);
      return;
    }

    const update = () => setTasks(workspaceSubagentManager.list(sessionId));
    update();
    const unsubscribe = workspaceSubagentManager.subscribe(sessionId, update);
    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  return tasks;
}

function DetailFields({ nowMs, task }: { nowMs: number; task: SubagentSnapshot }) {
  const endAtMs = task.completedAtMs ?? task.interruptedAtMs;
  const rows = [
    ["Name", roleLabel(task.name)],
    ["Task", task.task],
    ["Join", task.join],
    ["State", statusLabel(task.status)],
    ["Created", formatTime(task.createdAtMs)],
    ["Elapsed", formatElapsed(task.createdAtMs, endAtMs, nowMs)],
    ...(task.completedAtMs ? [["Completed", formatTime(task.completedAtMs)]] : []),
    ...(task.interruptedAtMs ? [["Interrupted", formatTime(task.interruptedAtMs)]] : []),
    ["Task ID", task.taskId],
    ...(task.activeOwnerTurnId ? [["Owner turn", task.activeOwnerTurnId]] : []),
    ...(task.pendingMessageCount > 0
      ? [["Queued messages", String(task.pendingMessageCount)]]
      : []),
  ];

  return (
    <dl className="grid grid-cols-[82px_minmax(0,1fr)] gap-x-2 gap-y-1 text-tiny">
      {rows.map(([label, value]) => (
        <div className="contents" key={label}>
          <dt className="text-[var(--color-text-tertiary)]">{label}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SubagentConversation({
  onClose,
  sessionId,
  task,
}: {
  onClose: () => void;
  sessionId: string;
  task: SubagentSnapshot;
}) {
  const tasks = useSessionSubagents(sessionId);
  const currentTask = tasks.find((entry) => entry.taskId === task.taskId) ?? task;
  const messages = workspaceSubagentManager.conversation(sessionId, task.taskId);
  const displayMessages = useMemo(() => buildDisplayMessages(messages), [messages]);
  const emptyFiles = useMemo(() => new Map<string, PreviewFile>(), []);
  const windowDrag = useWindowDrag();
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const didInitialScrollRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  useEffect(() => {
    window.addEventListener(CLOSE_SUBAGENT_VIEW_EVENT, onClose);
    return () => window.removeEventListener(CLOSE_SUBAGENT_VIEW_EVENT, onClose);
  }, [onClose]);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      const viewport = scrollViewportRef.current;
      if (!viewport) {
        return;
      }
      if (!didInitialScrollRef.current || isNearBottomRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
        didInitialScrollRef.current = true;
      }
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      isNearBottomRef.current = distance <= 80;
      setShowScrollToBottom(!isNearBottomRef.current);
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [currentTask.updatedAtMs, displayMessages.length]);

  function handleConversationScroll() {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return;
    }
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    isNearBottomRef.current = distance <= 80;
    setShowScrollToBottom(!isNearBottomRef.current);
  }

  function scrollToBottom() {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return;
    }
    isNearBottomRef.current = true;
    setShowScrollToBottom(false);
    viewport.scrollTo({ behavior: "smooth", top: viewport.scrollHeight });
  }

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[var(--color-app-bg)]" data-subagent-conversation>
      <header
        className="app-titlebar-region app-titlebar-main-safe flex h-[calc(3rem+var(--titlebar-top-padding))] shrink-0 items-center justify-between border-b border-[var(--color-border)] pr-3"
        onPointerDownCapture={windowDrag.onPointerDownCapture}
      >
        <div className="min-w-0">
          <p className="truncate text-ui-tight font-medium text-[var(--color-text)]">{roleLabel(currentTask.name)}</p>
          <p className="truncate text-[11px] text-[var(--color-text-tertiary)]">Read-only subagent conversation · {statusLabel(currentTask.status)}</p>
        </div>
        <button
          aria-label="Close subagent conversation"
          className="rounded-xl p-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          onClick={onClose}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="relative min-h-0 flex-1" data-no-window-drag>
        <div
          className="h-full overflow-y-auto px-4 py-5 sm:px-8 sm:py-6"
          onScroll={handleConversationScroll}
          ref={scrollViewportRef}
        >
          <div className="mx-auto max-w-[920px] space-y-5">
          {displayMessages.length > 0 ? displayMessages.map((message, index) => (
            <div key={message.id}>
              <p className={`mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)] ${message.role === "user" ? "text-right" : "text-left"}`}>
                {message.role === "user" ? "Parent agent" : roleLabel(currentTask.name)}
              </p>
              <MessageBubble
                canEditUserMessage={false}
                fileMap={emptyFiles}
                isEditingUserMessage={false}
                isLatest={index === displayMessages.length - 1}
                message={message}
                onEditUserMessage={() => undefined}
                onOpenFile={() => undefined}
              />
            </div>
          )) : (
            <p className="py-10 text-center text-ui text-[var(--color-text-tertiary)]">The conversation has not started yet.</p>
          )}
          </div>
        </div>
        {showScrollToBottom ? (
          <button
            aria-label="Scroll to latest subagent message"
            className="absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-panel)] text-[var(--color-text-secondary)] shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            onClick={scrollToBottom}
            type="button"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-[var(--color-border)] px-4 py-3 sm:px-8" data-no-window-drag>
        <div className="mx-auto max-w-[920px]">
          <ToolApprovalPrompt />
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-4 py-3 text-center text-meta text-[var(--color-text-tertiary)]">
            This conversation is read-only.
          </div>
        </div>
      </div>
    </div>
  );
}

export function SessionSubagentMenu({ sessionId }: { sessionId: string | null }) {
  const tasks = useSessionSubagents(sessionId);
  const [isOpen, setIsOpen] = useState(false);
  const [expandedTaskIds, setExpandedTaskIds] = useState(() => new Set<string>());
  const [viewingTask, setViewingTask] = useState<SubagentSnapshot | null>(null);
  const [interruptingTaskId, setInterruptingTaskId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activeCount = tasks.filter(isActive).length;

  useEffect(() => {
    if (!tasks.some(isActive)) {
      return;
    }
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [tasks]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [isOpen]);

  if (!sessionId) {
    return null;
  }

  async function interrupt(taskId: string) {
    if (!sessionId) {
      return;
    }
    setInterruptingTaskId(taskId);
    try {
      await workspaceSubagentManager.interruptManually(sessionId, taskId);
    } finally {
      setInterruptingTaskId(null);
    }
  }

  return (
    <>
      <div className="relative z-10" data-no-window-drag ref={rootRef}>
        <button
          aria-expanded={isOpen}
          aria-label="Manage subagents"
          className="relative rounded-xl p-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          onClick={() => setIsOpen((value) => !value)}
          type="button"
        >
          <Bot className="h-4 w-4" />
          {tasks.length > 0 ? (
            <span className="absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-accent)] px-0.5 text-[10px] font-medium leading-none text-[var(--color-accent-foreground)]">{activeCount || tasks.length}</span>
          ) : null}
        </button>
        {isOpen ? (
          <div className="absolute right-0 top-full z-40 mt-1 w-[360px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel)_97%,transparent)] shadow-[0_12px_32px_rgba(0,0,0,0.22)] backdrop-blur-xl">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
              <span className="text-[12px] font-medium text-[var(--color-text-tertiary)]">Subagents</span>
              <span className="text-[11px] text-[var(--color-text-tertiary)]">{tasks.length}/3</span>
            </div>
            <div className="max-h-[420px] overflow-y-auto divide-y divide-[var(--color-border)]">
              {tasks.length === 0 ? (
                <p className="px-3 py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">No subagents created in this session.</p>
              ) : tasks.map((task) => {
                const expanded = expandedTaskIds.has(task.taskId);
                const stopping = interruptingTaskId === task.taskId;
                return (
                  <div key={task.taskId}>
                    <div className="flex w-full items-center gap-2 px-3 py-2 transition hover:bg-[var(--color-panel-hover)]">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => setExpandedTaskIds((current) => {
                          const next = new Set(current);
                          if (expanded) next.delete(task.taskId); else next.add(task.taskId);
                          return next;
                        })}
                        type="button"
                      >
                        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-tertiary)]" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-tertiary)]" />}
                        <div className="min-w-0 flex-1">
                          <p className="text-ui-tight font-medium text-[var(--color-text)]">{roleLabel(task.name)}</p>
                          <p className="truncate text-[11px] text-[var(--color-text-tertiary)]">{statusLabel(task.status)} · {formatElapsed(task.createdAtMs, task.completedAtMs ?? task.interruptedAtMs, nowMs)}</p>
                        </div>
                      </button>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          aria-label="View subagent"
                          className="rounded-lg p-1.5 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                          onClick={() => setViewingTask(task)}
                          type="button"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                        {isActive(task) ? (
                          <button
                            aria-label="Interrupt subagent"
                            className="rounded-lg p-1.5 text-[var(--color-text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] hover:text-[var(--color-danger)] disabled:opacity-50"
                            disabled={stopping}
                            onClick={() => void interrupt(task.taskId)}
                            type="button"
                          >
                            {stopping ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3 w-3 fill-current" />}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {expanded ? (
                      <div className="space-y-2 bg-[color-mix(in_srgb,var(--color-panel-muted)_55%,transparent)] px-4 py-3">
                        <DetailFields nowMs={nowMs} task={task} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      {viewingTask && sessionId ? <SubagentConversation onClose={() => setViewingTask(null)} sessionId={sessionId} task={viewingTask} /> : null}
    </>
  );
}
