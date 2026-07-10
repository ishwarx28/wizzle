import { AlertTriangle, Command, FilePenLine, FilePlus2, FileText } from "lucide-react";

import { useWorkspaceStore } from "../../store/workspace-store";
import type { ToolApprovalRequest } from "../../types/workspace";

function requestTitle(toolName: ToolApprovalRequest["toolName"]) {
  if (toolName === "bash") {
    return "bash";
  }

  if (toolName === "read") {
    return "read";
  }

  if (toolName === "write") {
    return "write";
  }

  return "edit";
}

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

function warningLabel(warning: NonNullable<ToolApprovalRequest["warning"]>) {
  if (warning.title) {
    return warning.title;
  }

  if (warning.kind === "dangerous-command") {
    return "Dangerous";
  }

  if (warning.kind === "sensitive-path") {
    return "Sensitive";
  }

  return "External";
}

export function ToolApprovalPrompt() {
  const pendingToolApproval = useWorkspaceStore((state) => state.pendingToolApproval);
  const resolveToolApproval = useWorkspaceStore((state) => state.resolveToolApproval);

  if (!pendingToolApproval) {
    return null;
  }

  const title = requestTitle(pendingToolApproval.toolName);
  const value = requestValue(pendingToolApproval);
  const warning = pendingToolApproval.warning;
  const isWarning = Boolean(warning);

  return (
    <div
      className={[
        "mb-2 overflow-hidden rounded-2xl border",
        isWarning
          ? "border-[color-mix(in_srgb,var(--color-danger)_50%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-panel)_90%,var(--color-danger)_10%)]"
          : "border-[var(--color-border-strong)] bg-[color-mix(in_srgb,var(--color-panel)_94%,transparent)]",
      ].join(" ")}
      data-tool-approval
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <div
          className={[
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-xl",
            isWarning
              ? "bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] text-[var(--color-danger)]"
              : "bg-[var(--color-panel-muted)] text-[var(--color-text-secondary)]",
          ].join(" ")}
        >
          {isWarning ? <AlertTriangle className="h-3.5 w-3.5" /> : requestIcon(pendingToolApproval.toolName)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={[
                "shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em]",
                isWarning
                  ? "bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)] text-[var(--color-danger)]"
                  : "bg-[var(--color-panel-muted)] text-[var(--color-text-secondary)]",
              ].join(" ")}
            >
              {title}
            </span>
            {warning ? (
              <span className="shrink-0 text-[11px] font-medium text-[var(--color-danger)]">
                {warningLabel(warning)}
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
                Approve
              </span>
            )}
            <span
              className={[
                "min-w-0 truncate font-mono text-[12px]",
                isWarning ? "text-[var(--color-danger)]" : "text-[var(--color-text)]",
              ].join(" ")}
              title={value}
            >
              {value}
            </span>
          </div>
          {warning?.message ? (
            <p className="mt-0.5 truncate text-[11px] leading-4 text-[color-mix(in_srgb,var(--color-danger)_80%,var(--color-text-secondary))]" title={warning.message}>
              {warning.message}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <span className="hidden text-[11px] text-[var(--color-text-tertiary)] sm:inline">
            {pendingToolApproval.timeout}
          </span>
          <button
            className="rounded-lg px-2.5 py-1 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            onClick={() => resolveToolApproval(false, pendingToolApproval.toolCallId)}
            type="button"
          >
            Reject
          </button>
          <button
            className={[
              "rounded-lg px-2.5 py-1 text-[12px] transition",
              isWarning
                ? "bg-[var(--color-danger)] text-white hover:opacity-90"
                : "bg-[var(--color-accent)] text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)]",
            ].join(" ")}
            onClick={() => resolveToolApproval(true, pendingToolApproval.toolCallId)}
            type="button"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
