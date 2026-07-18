import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ChevronUp, Copy, FileCode2, FileImage, FileText, Pencil, RefreshCw } from "lucide-react";

import { MarkdownRenderer } from "../common/MarkdownRenderer";
import { ToolActivityGroup } from "./ToolActivityGroup";
import { useAutoDisclosure } from "../../hooks/use-auto-disclosure";
import {
  hasVisibleActivityBody,
  resolveActiveToolGroupSegmentId,
  shouldOpenWorkingSection,
  shouldShowReasoningWorkingEvent,
  shouldShowWorkingPlaceholder,
} from "../../lib/activity-disclosure";
import { buildActivitySegments } from "../../lib/tool-activity";
import { compactFailedTurnError } from "../../lib/failed-turn-recovery";
import type { DisplayMessage, MessagePart, PreviewFile } from "../../types/workspace";
import { copyText } from "../../utils/clipboard";
import { formatExactMessageTimestamp } from "../../utils/time";

interface MessageBubbleProps {
  canEditUserMessage: boolean;
  failedTurnRecovery?: {
    canChooseDifferentModel: boolean;
    canRetry: boolean;
    isRetrying: boolean;
    onChooseDifferentModel: () => void;
    onRetry: () => void;
  };
  fileMap: Map<string, PreviewFile>;
  /** Stream/step failure for this turn (#19 C); cleared when user sends again. */
  inlineStreamError?: string | null;
  isEditingUserMessage: boolean;
  isLatest: boolean;
  message: DisplayMessage;
  onEditUserMessage: (input: {
    attachments: PreviewFile[];
    messageId: string;
    prompt: string;
    turnId?: string;
  }) => void;
  onOpenFile: (fileId: string) => void;
}

function fileIcon(kind: PreviewFile["kind"]) {
  switch (kind) {
    case "markdown":
    case "text":
      return <FileText className="h-4 w-4" />;
    case "image":
      return <FileImage className="h-4 w-4" />;
    default:
      return <FileCode2 className="h-4 w-4" />;
  }
}

function formatElapsedDuration(durationMs: number) {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.round(totalSeconds / 60);

  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  return `${Math.round(totalMinutes / 60)}h`;
}

function ReasoningStepItem({
  part,
}: {
  part: MessagePart;
}) {
  const isStreaming = part.status === "streaming";
  const { isOpen, toggle } = useAutoDisclosure(isStreaming);
  const [liveDurationMs, setLiveDurationMs] = useState(() =>
    part.createdAtMs ? Math.max(0, Date.now() - part.createdAtMs) : 0,
  );
  const content = part.content?.trim() ?? "";

  useEffect(() => {
    if (!isStreaming || !part.createdAtMs) {
      return;
    }

    setLiveDurationMs(Math.max(0, Date.now() - part.createdAtMs));
    const intervalId = window.setInterval(() => {
      setLiveDurationMs(Math.max(0, Date.now() - part.createdAtMs!));
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isStreaming, part.createdAtMs]);

  if (!content) {
    return null;
  }

  const durationMs = isStreaming ? liveDurationMs : part.durationMs ?? 0;
  const durationLabel = formatElapsedDuration(durationMs);

  return (
    <div className="py-1">
      <button
        className="flex w-full items-center gap-1.5 text-left text-tiny text-[var(--color-text-secondary)] transition hover:text-[var(--color-text)]"
        onClick={toggle}
        type="button"
      >
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-[var(--color-text-tertiary)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[var(--color-text-tertiary)]" />
        )}
        <span>{isStreaming ? `Thinking ${durationLabel}` : `Thought for ${durationLabel}`}</span>
      </button>
      <div
        className="grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out"
        style={{
          gridTemplateRows: isOpen ? "1fr" : "0fr",
          opacity: isOpen ? 1 : 0,
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="pt-1.5 pl-5">
            <MarkdownRenderer
              className="text-ui text-[var(--color-text)]"
              content={content}
              streaming={isStreaming}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ActivityContentItem({
  part,
}: {
  part: MessagePart;
}) {
  const content = part.content?.trim() ?? "";

  if (!content) {
    return null;
  }

  return (
    <div className="py-1">
      <MarkdownRenderer
        className="text-ui text-[var(--color-text)]"
        content={content}
        streaming={part.status === "streaming"}
      />
    </div>
  );
}

function SubagentResponseItem({ part }: { part: MessagePart }) {
  const { isOpen, toggle } = useAutoDisclosure(false);
  const content = part.content?.trim() ?? "";
  const isManualInterruption = part.metadata?.trigger === "manual";

  if (!content) {
    return null;
  }

  return (
    <div className="my-1 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel-muted)_68%,transparent)]">
      <button
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-meta text-[var(--color-text-secondary)] transition hover:text-[var(--color-text)]"
        onClick={toggle}
        type="button"
      >
        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span>{isManualInterruption ? "Subagent interrupted" : "Subagent responded"}</span>
      </button>
      <div
        className="grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out"
        style={{ gridTemplateRows: isOpen ? "1fr" : "0fr", opacity: isOpen ? 1 : 0 }}
      >
        <div className="min-h-0 overflow-hidden border-t border-[var(--color-border)]">
          <MarkdownRenderer
            className="max-h-[360px] overflow-auto px-3 py-2 text-meta text-[var(--color-text-secondary)]"
            content={content}
          />
        </div>
      </div>
    </div>
  );
}

function ReasoningWorkingItem() {
  return (
    <div className="py-1 text-ui text-[var(--color-text-secondary)]">
      <span className="composer-text-shimmer">Thinking ...</span>
    </div>
  );
}

export function MessageBubble({
  canEditUserMessage,
  failedTurnRecovery,
  fileMap,
  inlineStreamError = null,
  isEditingUserMessage,
  isLatest,
  message,
  onEditUserMessage,
  onOpenFile,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [isCopied, setIsCopied] = useState(false);
  const [showAllLinkedFiles, setShowAllLinkedFiles] = useState(false);
  const [manualToolExpansionSegmentIds, setManualToolExpansionSegmentIds] = useState(
    () => new Set<string>(),
  );
  const renderedContent = message.content;
  const [elapsedMs, setElapsedMs] = useState(() =>
    message.startedAtMs ? Math.max(0, Date.now() - message.startedAtMs) : 0,
  );
  const parts = useMemo(() => message.parts, [message.parts]);
  const activityParts = useMemo(() => parts.filter((part) => part.type !== "content"), [parts]);
  const activitySegments = useMemo(() => buildActivitySegments(activityParts), [activityParts]);
  const linkedFiles = useMemo(() => {
    const uniqueFiles = new Map<string, PreviewFile>();

    for (const fileId of [...(message.linkedFileIds ?? [])].reverse()) {
      const file = fileMap.get(fileId);

      if (!file) {
        continue;
      }

      const dedupeKey = isUser ? file.id : file.path;

      if (!uniqueFiles.has(dedupeKey)) {
        uniqueFiles.set(dedupeKey, file);
      }
    }

    return Array.from(uniqueFiles.values()).reverse();
  }, [fileMap, isUser, message.linkedFileIds]);
  const visibleLinkedFiles = showAllLinkedFiles ? linkedFiles : linkedFiles.slice(0, 3);
  const hiddenLinkedFileCount = Math.max(0, linkedFiles.length - 3);

  useEffect(() => {
    setShowAllLinkedFiles(false);
  }, [message.id]);

  useEffect(() => {
    if (!isCopied) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsCopied(false);
    }, 1600);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isCopied]);

  useEffect(() => {
    if (message.status !== "streaming" || !message.startedAtMs) {
      return;
    }

    setElapsedMs(Math.max(0, Date.now() - message.startedAtMs));
    const intervalId = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - message.startedAtMs!));
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [message.startedAtMs, message.status]);

  const isStreaming = message.status === "streaming";
  const workingDurationMs = isStreaming && message.startedAtMs
    ? elapsedMs
    : message.durationMs ?? (message.startedAtMs ? elapsedMs : 0);
  const activityLabel =
    isStreaming
      ? `Working for ${formatElapsedDuration(workingDurationMs)}`
      : `Worked for ${formatElapsedDuration(workingDurationMs)}`;
  const visibleActivityBody = useMemo(
    () => hasVisibleActivityBody(activitySegments),
    [activitySegments],
  );
  const hasManualToolExpansion = manualToolExpansionSegmentIds.size > 0;
  // I-2: temporary placeholder until tools or final answer appear (reasoning stays hidden).
  const showWorkingPlaceholder = shouldShowWorkingPlaceholder({
    hasFinalContent: Boolean(renderedContent.trim()),
    hasStreamStarted: Boolean(message.transientStreamStarted),
    hasToolOrVisibleActivity: visibleActivityBody,
    isAssistant: !isUser,
    status: message.status,
  });
  const showReasoningWorkingEvent = shouldShowReasoningWorkingEvent({
    isAssistant: !isUser,
    isReasoningActive: Boolean(message.transientReasoningActive),
    status: message.status,
  });
  const hasActivitySection =
    !isUser && !showWorkingPlaceholder && (visibleActivityBody || showReasoningWorkingEvent);
  const activityDisclosure = useAutoDisclosure(
    shouldOpenWorkingSection({
      hasManualToolExpansion,
      hasVisibleActivityBody: hasActivitySection,
      isStreaming,
    }),
  );
  const activeToolGroupSegmentId = useMemo(
    () => (isStreaming ? resolveActiveToolGroupSegmentId(activitySegments) : null),
    [activitySegments, isStreaming],
  );
  const shouldShowLinkedFiles =
    linkedFiles.length > 0 && (isUser || message.status !== "streaming");
  const shouldShowFooter = message.status !== "streaming";
  const isEditedUserMessage = isUser && typeof message.editedAtMs === "number";
  const shouldHighlightFooter = isLatest || canEditUserMessage || isEditingUserMessage;
  const editTargetTurnId = isUser ? message.messages[0]?.turnId : undefined;
  const timestampLabel =
    typeof message.createdAtMs === "number"
      ? formatExactMessageTimestamp(message.createdAtMs)
      : "Time unavailable";

  return (
    <div className={isUser ? "group flex justify-end" : "group flex w-full"}>
      <div className={isUser ? "max-w-[78%]" : "w-full"}>
        <div
          className={[
            isUser
              ? "rounded-[24px] rounded-br-md bg-[var(--color-user-bubble)] px-4 py-3 text-ui text-[var(--color-text)]"
              : "px-1 py-0.5 text-ui text-[var(--color-text)]",
            isUser && isEditingUserMessage ? "ring-1 ring-[var(--color-border-strong)]" : "",
          ].join(" ")}
        >
          {isUser ? (
            <MarkdownRenderer
              className="text-ui text-[var(--color-text)]"
              content={message.content}
            />
          ) : showWorkingPlaceholder ? (
            <div className="flex items-center gap-2 py-1 text-ui text-[var(--color-text-secondary)]">
              <span>Working...</span>
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 animate-pulse rounded-full bg-current [animation-delay:-0.2s]" />
                <span className="h-2 w-2 animate-pulse rounded-full bg-current [animation-delay:-0.1s]" />
                <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              {hasActivitySection ? (
                <div className="space-y-1">
                  <div className="border-b border-[var(--color-border)] pb-1.5">
                    <button
                      className="flex w-full items-center gap-1.5 py-0.5 text-left text-meta text-[var(--color-text-secondary)] transition hover:text-[var(--color-text)]"
                      onClick={activityDisclosure.toggle}
                      type="button"
                    >
                      {activityDisclosure.isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 text-[var(--color-text-tertiary)]" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-[var(--color-text-tertiary)]" />
                      )}
                      <span className="tracking-[0.01em]">{activityLabel}</span>
                    </button>
                  </div>
                  <div
                    className="grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out"
                    style={{
                      gridTemplateRows: activityDisclosure.isOpen ? "1fr" : "0fr",
                      opacity: activityDisclosure.isOpen ? 1 : 0,
                    }}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="space-y-1 pt-1">
                        {activitySegments.map((segment) => {
                          if (segment.type === "tool_group") {
                            return (
                              <ToolActivityGroup
                                isActiveGroup={
                                  isStreaming && segment.id === activeToolGroupSegmentId
                                }
                                isStreamingTurn={isStreaming}
                                key={segment.id}
                                onManualExpandChange={(hasManualExpansion) => {
                                  setManualToolExpansionSegmentIds((current) => {
                                    const next = new Set(current);

                                    if (hasManualExpansion) {
                                      next.add(segment.id);
                                    } else {
                                      next.delete(segment.id);
                                    }

                                    return next;
                                  });
                                }}
                                runs={segment.runs}
                              />
                            );
                          }

                          const part = segment.part;

                          if (part.type === "reasoning") {
                            return <ReasoningStepItem key={part.id} part={part} />;
                          }

                          if (part.type === "activity_content") {
                            return <ActivityContentItem key={part.id} part={part} />;
                          }

                          if (part.type === "subagent_response") {
                            return <SubagentResponseItem key={part.id} part={part} />;
                          }

                          return null;
                        })}
                        {showReasoningWorkingEvent ? <ReasoningWorkingItem /> : null}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {renderedContent.trim() ? (
                <MarkdownRenderer
                  className="text-ui text-[var(--color-text)]"
                  content={renderedContent}
                  streaming={message.status === "streaming"}
                />
              ) : null}
            </div>
          )}
        </div>

        {shouldShowLinkedFiles ? (
          <div className="mt-3 space-y-1.5">
            {visibleLinkedFiles.map((file) => {
              const isImplementationPlan = file.name === "implementation-plan.md";
              return (
                <button
                  className={[
                    "flex w-full items-center justify-between gap-3 rounded-[20px] border border-[var(--color-border)] bg-[var(--color-panel-card)] px-3.5 py-3 text-left transition",
                    isUser && isEditingUserMessage
                      ? "cursor-default opacity-70"
                      : "hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-hover)]",
                  ].join(" ")}
                  disabled={isUser && isEditingUserMessage}
                  key={file.id}
                  onClick={() => onOpenFile(file.id)}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-panel-muted)] text-[var(--color-text)]">
                      {fileIcon(file.kind)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-ui-tight font-medium text-[var(--color-text)]">
                        {isImplementationPlan ? "Implementation plan" : file.name}
                      </p>
                      <p className="truncate text-meta-tight text-[var(--color-text-tertiary)]">
                        {file.summary}
                      </p>
                    </div>
                  </div>
                  <span className="text-meta-tight text-[var(--color-text-secondary)]">
                    {isImplementationPlan ? "Read plan" : "Open"}
                  </span>
                </button>
              );
            })}
            {hiddenLinkedFileCount > 0 ? (
              <button
                className="flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-meta-tight text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={() => setShowAllLinkedFiles((current) => !current)}
                type="button"
              >
                {showAllLinkedFiles ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
                {showAllLinkedFiles
                  ? "Collapse attachments"
                  : `Show ${hiddenLinkedFileCount} more`}
              </button>
            ) : null}
          </div>
        ) : null}

        {shouldShowFooter ? (
          <div
            className={[
              "mt-1.5 flex items-center gap-3 px-1 text-meta-tight text-[var(--color-text-tertiary)] transition-opacity",
              isUser ? "justify-end" : "justify-start",
              shouldHighlightFooter ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            ].join(" ")}
          >
            {isEditingUserMessage ? (
              <span className="inline-flex items-center rounded-full border border-[var(--color-border)] px-2 py-1 text-tiny text-[var(--color-text-secondary)]">
                Editing in composer
              </span>
            ) : null}
            {canEditUserMessage ? (
              <button
                aria-label={isEditedUserMessage ? "Re-edit message" : "Edit message"}
                className="inline-flex items-center rounded-full p-1.5 transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={() => {
                  onEditUserMessage({
                    attachments: linkedFiles,
                    messageId: message.id,
                    prompt: message.content,
                    turnId: editTargetTurnId,
                  });
                }}
                title={isEditedUserMessage ? "Re-edit" : "Edit"}
                type="button"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            ) : null}
            <button
              aria-label={isCopied ? "Copied" : "Copy message"}
              className={[
                "inline-flex items-center rounded-full p-1.5 transition",
                isCopied || isEditingUserMessage
                  ? "cursor-default text-[var(--color-text-secondary)]"
                  : "hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]",
              ].join(" ")}
              disabled={isCopied || isEditingUserMessage}
              onClick={async () => {
                const didCopy = await copyText(renderedContent);

                if (didCopy) {
                  setIsCopied(true);
                }
              }}
              title={isCopied ? "Copied" : "Copy"}
              type="button"
            >
              {isCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            {isEditedUserMessage ? (
              <span className="inline-flex items-center rounded-full border border-[var(--color-border)] px-2 py-1 text-tiny text-[var(--color-text-secondary)]">
                Edited
              </span>
            ) : null}
            <span>{timestampLabel}</span>
          </div>
        ) : null}

        {inlineStreamError ? (
          <div
            className={[
              "mt-1.5 flex min-h-8 items-center gap-1.5 rounded-xl border border-[color-mix(in_srgb,var(--color-danger)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-danger)_8%,var(--color-panel))] px-2 py-1 text-[12px] text-[var(--color-danger)]",
              isUser ? "text-right" : "",
            ].join(" ")}
            role="alert"
            title={inlineStreamError}
          >
            <AlertTriangle aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              {compactFailedTurnError(inlineStreamError)}
            </span>
            {failedTurnRecovery ? (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  aria-label="Retry failed turn with the same model"
                  className="inline-flex h-6 items-center gap-1 rounded-lg px-1.5 font-medium text-[var(--color-danger)] transition hover:bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] disabled:cursor-not-allowed disabled:opacity-55"
                  disabled={
                    failedTurnRecovery.isRetrying || !failedTurnRecovery.canRetry
                  }
                  onClick={failedTurnRecovery.onRetry}
                  type="button"
                >
                  <RefreshCw
                    aria-hidden
                    className={`h-3 w-3 ${failedTurnRecovery.isRetrying ? "animate-spin" : ""}`}
                  />
                  {failedTurnRecovery.isRetrying ? "Retrying" : "Retry"}
                </button>
                <button
                  aria-label="Retry failed turn with a different model"
                  className="inline-flex h-6 items-center rounded-lg px-1.5 font-medium text-[var(--color-danger)] transition hover:bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] disabled:cursor-not-allowed disabled:opacity-55"
                  disabled={
                    failedTurnRecovery.isRetrying ||
                    !failedTurnRecovery.canChooseDifferentModel
                  }
                  onClick={failedTurnRecovery.onChooseDifferentModel}
                  type="button"
                >
                  Different model
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
