import {
  AlertTriangle,
  ChevronDown,
  Command,
  FilePenLine,
  FilePlus2,
  FileText,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useWorkspaceStore } from "../../store/workspace-store";
import type { ToolApprovalRequest } from "../../types/workspace";

const BASH_EXTERNAL_PATH_WARNING =
  "This command would access a file outside the selected project. Approve only if you trust this command.";

function requestValue(request: {
  command?: string;
  path?: string;
  summary: string;
  toolName: ToolApprovalRequest["toolName"];
}) {
  return request.toolName === "bash"
    ? request.command?.trim() || request.summary
    : request.path?.trim() || request.summary;
}

function requestIcon(toolName: ToolApprovalRequest["toolName"]) {
  if (toolName === "bash") {
    return <Command className="h-3.5 w-3.5" />;
  }

  if (toolName === "read") {
    return <FileText className="h-3.5 w-3.5" />;
  }

  if (toolName === "write") {
    return <FilePlus2 className="h-3.5 w-3.5" />;
  }

  return <FilePenLine className="h-3.5 w-3.5" />;
}

function warningTone(warning: ToolApprovalRequest["warning"]) {
  if (!warning || warning.kind === "external-path") {
    return {
      border: "border-[color-mix(in_srgb,#6aa8ff_28%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-panel)_94%,#6aa8ff_6%)]",
      icon: "bg-[color-mix(in_srgb,#6aa8ff_12%,transparent)] text-[#8bbcff]",
    };
  }

  if (warning.kind === "dangerous-command") {
    return {
      border: "border-[color-mix(in_srgb,var(--color-danger)_34%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-panel)_94%,var(--color-danger)_6%)]",
      icon: "bg-[color-mix(in_srgb,var(--color-danger)_11%,transparent)] text-[var(--color-danger)]",
    };
  }

  return {
    border: "border-[color-mix(in_srgb,#d99a1e_30%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-panel)_94%,#d99a1e_6%)]",
    icon: "bg-[color-mix(in_srgb,#d99a1e_13%,transparent)] text-[#d99a1e]",
  };
}

function detailLabel(toolName: ToolApprovalRequest["toolName"]) {
  return toolName === "bash" ? "Command" : "Path";
}

function approvalMessageLines(request: ToolApprovalRequest) {
  const description = request.toolName === "bash" ? request.description?.trim() : "";

  if (request.toolName === "bash" && request.warning?.kind === "external-path") {
    return [
      description
        ? `Agent wants to ${description}; this would access a file outside the selected project. Approve only if you trust this command.`
        : BASH_EXTERNAL_PATH_WARNING,
    ];
  }

  return [description, request.warning?.message].filter((line): line is string => Boolean(line));
}

function approvalRequests(request: ToolApprovalRequest) {
  return request.batchRequests?.length ? request.batchRequests : [request];
}

function strongestWarning(requests: ToolApprovalRequest[]) {
  const priority: Record<NonNullable<ToolApprovalRequest["warning"]>["kind"], number> = {
    "dangerous-command": 3,
    "sensitive-path": 2,
    "external-path": 1,
  };

  return requests
    .map((request) => request.warning)
    .filter((warning): warning is NonNullable<ToolApprovalRequest["warning"]> => Boolean(warning))
    .sort((left, right) => priority[right.kind] - priority[left.kind])[0];
}

export function ToolApprovalPrompt({ subagentTaskId }: { subagentTaskId?: string } = {}) {
  const pendingToolApproval = useWorkspaceStore((state) => state.pendingToolApproval);
  const resolveToolApproval = useWorkspaceStore((state) => state.resolveToolApproval);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    setIsExpanded(false);
  }, [pendingToolApproval?.toolCallId]);

  if (
    !pendingToolApproval ||
    (subagentTaskId && pendingToolApproval.subagentTaskId !== subagentTaskId)
  ) {
    return null;
  }

  const requests = approvalRequests(pendingToolApproval);
  const value = requestValue(requests[0] ?? pendingToolApproval);
  const hiddenRequestCount = Math.max(0, requests.length - 1);
  const isBatch = requests.length > 1;
  const warning = strongestWarning(requests);
  const isWarning = Boolean(warning);
  const tone = warningTone(warning);
  const hasDetails = requests.some((request) => Boolean(requestValue(request)));
  const messageLines = isBatch
    ? [warning?.message].filter((line): line is string => Boolean(line))
    : approvalMessageLines(pendingToolApproval);
  const messageTitle = messageLines.join("\n");

  return (
    <div
      className={[
        "mb-2 overflow-hidden rounded-xl border shadow-[0_10px_28px_rgba(0,0,0,0.16)]",
        tone.border,
      ].join(" ")}
      data-tool-approval
    >
      <div className="flex items-start gap-2.5 px-3 py-2">
        <div
          className={[
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
            tone.icon,
          ].join(" ")}
        >
          {isWarning ? <AlertTriangle className="h-3.5 w-3.5" /> : requestIcon(pendingToolApproval.toolName)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-[13px] font-medium text-[var(--color-text)]">
              {isBatch ? `${requests.length} approvals required` : "Approval required"}
            </span>
          </div>
          <div className="mt-1 min-w-0">
            {hasDetails ? (
              <button
                aria-expanded={isExpanded}
                className="flex max-w-full items-center gap-1 rounded-md pr-1 text-left transition hover:bg-[var(--color-panel-hover)]"
                onClick={() => setIsExpanded((current) => !current)}
                type="button"
              >
                <ChevronDown
                  className={[
                    "h-3.5 w-3.5 shrink-0 text-[var(--color-text-secondary)] transition-transform",
                    isExpanded ? "rotate-0" : "-rotate-90",
                  ].join(" ")}
                />
                <span
                  className="min-w-0 truncate font-mono text-[13px] leading-5 text-[var(--color-text)]"
                  title={value}
                >
                  {value}
                </span>
                {hiddenRequestCount > 0 ? (
                  <span className="shrink-0 rounded-full bg-[var(--color-panel-muted)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                    +{hiddenRequestCount} more
                  </span>
                ) : null}
              </button>
            ) : (
              <span
                className="min-w-0 truncate font-mono text-[13px] leading-5 text-[var(--color-text)]"
                title={value}
              >
                {value}
              </span>
            )}
          </div>
          {messageLines.length > 0 ? (
            <div className="mt-0.5 text-[12px] leading-4 text-[var(--color-text-secondary)]" title={messageTitle}>
              {messageLines.map((line, index) => (
                <p className="break-words" key={`${index}-${line}`}>
                  {line}
                </p>
              ))}
            </div>
          ) : null}
          {pendingToolApproval.subagentName ? (
            <p
              className="mt-0.5 truncate text-[11px] text-[var(--color-text-tertiary)]"
              title={pendingToolApproval.subagentTask}
            >
              Requested by {pendingToolApproval.subagentName.slice(0, 1).toUpperCase() + pendingToolApproval.subagentName.slice(1)}
              {pendingToolApproval.subagentTask ? ` · ${pendingToolApproval.subagentTask}` : ""}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <span className="hidden text-[12px] text-[var(--color-text-tertiary)] sm:inline">
            {pendingToolApproval.timeout}
          </span>
          <button
            className="rounded-lg px-2.5 py-1 text-ui-tight text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            onClick={() => resolveToolApproval(false, pendingToolApproval.toolCallId)}
            type="button"
          >
            {isBatch ? "Reject all" : "Reject"}
          </button>
          <button
            className={[
              "rounded-lg px-2.5 py-1 text-ui-tight transition",
              "bg-[var(--color-accent)] text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)]",
            ].join(" ")}
            onClick={() => resolveToolApproval(true, pendingToolApproval.toolCallId)}
            type="button"
          >
            {isBatch ? "Approve all" : "Approve"}
          </button>
        </div>
      </div>
      {isExpanded ? (
        <div className="border-t border-[var(--color-border)] px-3 pb-3 pt-2">
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {requests.map((request, index) => {
              const requestDetail = requestValue(request);
              const requestMessages = approvalMessageLines(request);

              return (
                <div
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-subtle)] p-2.5"
                  key={request.toolCallId}
                >
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
                    {requestIcon(request.toolName)}
                    <span>
                      {detailLabel(request.toolName)} {requests.length > 1 ? index + 1 : ""}
                    </span>
                  </div>
                  <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-4 text-[var(--color-text)]">
                    {requestDetail}
                  </pre>
                  {requestMessages.length > 0 ? (
                    <div className="mt-1.5 space-y-0.5 text-[11px] leading-4 text-[var(--color-text-secondary)]">
                      {requestMessages.map((line, lineIndex) => (
                        <p className="break-words" key={`${lineIndex}-${line}`}>
                          {line}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
