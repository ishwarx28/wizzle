import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { useAutoDisclosure } from "../../hooks/use-auto-disclosure";
import { summarizeToolRuns, type ToolRunEntry } from "../../lib/tool-activity";
import { ToolDiffViewer } from "./ToolDiffViewer";

interface ToolActivityGroupProps {
  onManualExpandChange?: (hasManualExpansion: boolean) => void;
  runs: ToolRunEntry[];
  turnStatus?: string;
}

function terminalOutput(run: ToolRunEntry) {
  const payload = run.resultPayload;
  const command = (payload?.command ?? run.callPayload?.command)?.trim();
  const output =
    payload?.combinedOutput ??
    [payload?.stdout, payload?.stderr].filter(Boolean).join("\n\n") ??
    "";
  const timedOutMessage =
    payload?.timedOut && payload.timeout ? `[Timed out after ${payload.timeout}]` : null;
  const sections = [
    command ? `$ ${command}` : null,
    output.trim() ? output.trim() : null,
    timedOutMessage,
  ].filter(Boolean);

  return sections.join("\n\n");
}

function isLiveRun(run: ToolRunEntry) {
  return run.status === "pending" || run.status === "running" || run.status === "streaming";
}

function ToolRunRow({
  onManualExpandChange,
  run,
}: {
  onManualExpandChange?: (hasManualExpansion: boolean) => void;
  run: ToolRunEntry;
}) {
  const isActive = isLiveRun(run);
  const { isOpen, toggle } = useAutoDisclosure(false);
  const outputText = terminalOutput(run).trim();
  const hasDiff =
    typeof run.resultPayload?.beforeContent === "string" &&
    typeof run.resultPayload?.afterContent === "string";
  const errorText = run.resultPayload?.error ?? run.result?.error ?? "";
  const isExpandable = run.isExpandable || Boolean(outputText) || Boolean(errorText) || isActive;

  return (
    <div>
      {isExpandable ? (
        <button
          className="flex w-full items-center gap-2 py-1 text-left text-[13px] text-[var(--color-text-secondary)] transition hover:text-[var(--color-text)]"
          onClick={() => {
            toggle();
            onManualExpandChange?.(!isOpen);
          }}
          type="button"
        >
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-tertiary)]" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-tertiary)]" />
          )}
          <span className="min-w-0 flex-1 truncate">{run.detailLabel}</span>
        </button>
      ) : (
        <div className="flex items-center gap-2 py-1 text-[13px] text-[var(--color-text-secondary)]">
          <span className="min-w-0 flex-1 truncate">{run.detailLabel}</span>
        </div>
      )}

      {isExpandable ? (
        <div
          className="grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out"
          style={{
            gridTemplateRows: isOpen ? "1fr" : "0fr",
            opacity: isOpen ? 1 : 0,
          }}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="space-y-1.5 pb-1 pl-4">
              {hasDiff ? (
                <ToolDiffViewer
                  afterContent={run.resultPayload?.afterContent ?? ""}
                  beforeContent={run.resultPayload?.beforeContent ?? ""}
                  diffTruncated={run.resultPayload?.diffTruncated}
                  title={run.resourceLabel}
                />
              ) : null}
              {run.kind === "bash" && (outputText || isActive) ? (
                <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel-muted)_68%,transparent)]">
                  <div className="border-b border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">
                    Terminal
                  </div>
                  <pre
                    className="max-h-[160px] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-5 text-[var(--color-text-secondary)]"
                    data-terminal-output
                  >
                    {outputText}
                  </pre>
                </div>
              ) : null}
              {!hasDiff && errorText.trim() ? (
                <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)] px-3 py-2 text-[11px] leading-4 text-[var(--color-text-secondary)]">
                  {errorText.trim()}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ToolActivityGroup({
  onManualExpandChange,
  runs,
  turnStatus,
}: ToolActivityGroupProps) {
  const hasMultipleRuns = runs.length > 1;
  const summaryLabel = useMemo(() => summarizeToolRuns(runs), [runs]);
  const [manuallyExpandedRunIds, setManuallyExpandedRunIds] = useState(() => new Set<string>());
  const hasManualExpansion = manuallyExpandedRunIds.size > 0;
  const shouldAutoOpen = runs.some((run) => isLiveRun(run)) || (turnStatus !== "streaming" && hasManualExpansion);
  const { isOpen, toggle } = useAutoDisclosure(shouldAutoOpen);

  if (runs.length === 0) {
    return null;
  }

  if (!hasMultipleRuns) {
    return <ToolRunRow onManualExpandChange={onManualExpandChange} run={runs[0]!} />;
  }

  function handleRunManualExpandChange(runId: string, isExpanded: boolean) {
    setManuallyExpandedRunIds((current) => {
      const next = new Set(current);

      if (isExpanded) {
        next.add(runId);
      } else {
        next.delete(runId);
      }

      onManualExpandChange?.(next.size > 0);
      return next;
    });
  }

  return (
    <div>
      <button
        className="flex w-full items-center gap-2 py-1 text-left text-[13px] text-[var(--color-text-secondary)] transition hover:text-[var(--color-text)]"
        onClick={toggle}
        type="button"
      >
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-tertiary)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-tertiary)]" />
        )}
        <span className="min-w-0 flex-1 truncate">{summaryLabel}</span>
      </button>
      <div
        className="grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out"
        style={{
          gridTemplateRows: isOpen ? "1fr" : "0fr",
          opacity: isOpen ? 1 : 0,
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-0 pl-4">
            {runs.map((run) => (
              <ToolRunRow
                key={run.id}
                onManualExpandChange={(isExpanded) => handleRunManualExpandChange(run.id, isExpanded)}
                run={run}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
