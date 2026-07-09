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
    return <Command className="h-4 w-4" />;
  }

  if (toolName === "read") {
    return <FileText className="h-4 w-4" />;
  }

  if (toolName === "write") {
    return <FilePlus2 className="h-4 w-4" />;
  }

  return <FilePenLine className="h-4 w-4" />;
}

function warningTitle(warning: NonNullable<ToolApprovalRequest["warning"]>) {
  if (warning.title) {
    return warning.title;
  }

  if (warning.kind === "dangerous-command") {
    return "Dangerous command";
  }

  if (warning.kind === "sensitive-path") {
    return "Sensitive file access";
  }

  return "External path access";
}

export function ToolApprovalPrompt() {
  const pendingToolApproval = useWorkspaceStore((state) => state.pendingToolApproval);
  const resolveToolApproval = useWorkspaceStore((state) => state.resolveToolApproval);

  if (!pendingToolApproval) {
    return null;
  }

  const title = requestTitle(pendingToolApproval.toolName);
  const value = requestValue(pendingToolApproval);
  const isWarning = Boolean(pendingToolApproval.warning);

  return (
    <div
      className={[
        "mb-3 overflow-hidden rounded-[24px] shadow-[0_14px_34px_rgba(0,0,0,0.18)] backdrop-blur-xl",
        isWarning
          ? "border border-[color-mix(in_srgb,var(--color-danger)_45%,var(--color-border-strong))] bg-[color-mix(in_srgb,var(--color-panel)_82%,var(--color-danger)_18%)]"
          : "border border-[var(--color-border-strong)] bg-[color-mix(in_srgb,var(--color-panel)_92%,transparent)]",
      ].join(" ")}
      data-tool-approval
    >
      <div className="flex items-start gap-3 px-4 py-3.5">
        <div
          className={[
            "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl",
            isWarning
              ? "border border-[color-mix(in_srgb,var(--color-danger)_55%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_18%,var(--color-panel-muted))] text-[var(--color-danger)]"
              : "border border-[var(--color-border)] bg-[var(--color-panel-muted)] text-[var(--color-text-secondary)]",
          ].join(" ")}
        >
          {requestIcon(pendingToolApproval.toolName)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
              {title}
            </span>
            <span
              className={[
                "text-[13px]",
                isWarning ? "text-[var(--color-danger)]" : "text-[var(--color-text-tertiary)]",
              ].join(" ")}
            >
              Awaiting approval
            </span>
            {isWarning ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--color-danger)_48%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-danger)]">
                <AlertTriangle className="h-3.5 w-3.5" />
                Warning
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-[13px] leading-5 text-[var(--color-text-secondary)]">
            {pendingToolApproval.summary}
          </p>
          {pendingToolApproval.warning ? (
            <div className="mt-2 rounded-2xl border border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-3 py-2 text-[12px] leading-5 text-[var(--color-text-secondary)]">
              <span className="inline-flex items-center gap-2 font-medium text-[var(--color-danger)]">
                <AlertTriangle className="h-3.5 w-3.5" />
                {warningTitle(pendingToolApproval.warning)}
              </span>
              <p className="mt-1">{pendingToolApproval.warning.message}</p>
            </div>
          ) : null}
          <pre
            className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 py-2 font-mono text-[12px] leading-5 text-[var(--color-text)]"
            data-terminal-output
          >
            {value}
          </pre>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-[12px] text-[var(--color-text-tertiary)]">
              Timeout: {pendingToolApproval.timeout}
            </span>
            <div className="flex items-center gap-2">
              <button
                className="rounded-xl px-3 py-2 text-[13px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={() => resolveToolApproval(false, pendingToolApproval.toolCallId)}
                type="button"
              >
                Reject
              </button>
              <button
                className={[
                  "rounded-xl px-3 py-2 text-[13px] transition",
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
      </div>
    </div>
  );
}
