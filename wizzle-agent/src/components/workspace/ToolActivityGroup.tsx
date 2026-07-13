import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Circle, CircleCheckBig, CircleDot, CircleX } from "lucide-react";

import { useAutoDisclosure } from "../../hooks/use-auto-disclosure";
import { shouldOpenToolGroup } from "../../lib/activity-disclosure";
import {
  resolveClarifyToolPresentation,
  summarizeToolRuns,
  type ParsedToolPayload,
  type ProcessPayload,
  type ToolRunEntry,
} from "../../lib/tool-activity";
import { ToolDiffViewer } from "./ToolDiffViewer";

interface ToolActivityGroupProps {
  /** Last tool group in the streaming turn (I-8). */
  isActiveGroup?: boolean;
  isStreamingTurn?: boolean;
  onManualExpandChange?: (hasManualExpansion: boolean) => void;
  runs: ToolRunEntry[];
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

function processOutput(process: ProcessPayload | null | undefined) {
  return [process?.stdoutTail, process?.stderrTail].filter((value) => value?.trim()).join("\n\n").trim();
}

function bashAction(run: ToolRunEntry) {
  return run.callPayload?.action ?? "run";
}

function isBackgroundStart(run: ToolRunEntry) {
  return bashAction(run) === "run" &&
    (run.callPayload?.background === true || run.resultPayload?.background === true);
}

function ProcessFields({ process, showCommand = false }: { process?: ProcessPayload | null; showCommand?: boolean }) {
  return <SubagentFields fields={[
    ...(showCommand ? [["Command", process?.command ?? "—"] as [string, string]] : []),
    ["Process ID", process?.id ?? "—"],
    ["PID", typeof process?.pid === "number" ? String(process.pid) : "—"],
    ["Status", process?.status ?? "unknown"],
    ...(typeof process?.exitCode === "number" ? [["Exit code", String(process.exitCode)] as [string, string]] : []),
  ]} />;
}

function BashToolDetails({ outputText, run }: { outputText: string; run: ToolRunEntry }) {
  const action = bashAction(run);
  const process = run.resultPayload?.process ?? {
    command: run.callPayload?.command,
    id: run.callPayload?.processId,
    status: isLiveRun(run) ? "running" : undefined,
  };

  if (action === "list_processes") {
    const processes = run.resultPayload?.processes ?? [];
    if (processes.length === 0) {
      return <p className="px-3 py-2 text-[12px] text-[var(--color-text-tertiary)]">No background processes.</p>;
    }
    return (
      <div className="max-h-56 overflow-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-[var(--color-panel-muted)] text-[var(--color-text-tertiary)]">
            <tr><th className="px-3 py-1.5 font-medium">Command</th><th className="px-2 py-1.5 font-medium">Process ID</th><th className="px-2 py-1.5 font-medium">PID</th><th className="px-3 py-1.5 font-medium">Status</th></tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {processes.map((entry, index) => (
              <tr key={entry.id ?? index}>
                <td className="max-w-[340px] truncate px-3 py-1.5 text-[var(--color-text-secondary)]" title={entry.command}>{entry.command ?? entry.id ?? "—"}</td>
                <td className="max-w-[160px] truncate px-2 py-1.5 text-[var(--color-text-tertiary)]" title={entry.id}>{entry.id ?? "—"}</td>
                <td className="px-2 py-1.5 text-[var(--color-text-tertiary)]">{entry.pid ?? "—"}</td>
                <td className="px-3 py-1.5 text-[var(--color-text-secondary)]">{entry.status ?? "unknown"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (action === "stop_process") {
    return <ProcessFields process={process} />;
  }

  if (action === "read_process") {
    const output = processOutput(process);
    return (
      <div>
        <ProcessFields process={process} showCommand />
        {output ? <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap break-words border-t border-[var(--color-border)] px-3 py-2 font-mono text-tiny text-[var(--color-text-secondary)]">{output}</pre> : null}
      </div>
    );
  }

  if (isBackgroundStart(run)) {
    return <ProcessFields process={process} showCommand />;
  }

  return (
    <div>
      <div className="border-b border-[var(--color-border)] px-3 py-2 text-[12px] text-[var(--color-text-tertiary)]">Terminal</div>
      <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-tiny text-[var(--color-text-secondary)]" data-terminal-output>{outputText}</pre>
    </div>
  );
}

function isLiveRun(run: ToolRunEntry) {
  return run.status === "pending" || run.status === "running" || run.status === "streaming";
}

function roleLabel(name?: string) {
  return name ? `${name.slice(0, 1).toUpperCase()}${name.slice(1)}` : "Unknown";
}

function timestamp(value?: number | null) {
  return typeof value === "number" ? new Date(value).toLocaleString() : "—";
}

function elapsed(start?: number | null, end?: number | null, now = Date.now()) {
  if (typeof start !== "number") {
    return "—";
  }
  const seconds = Math.max(0, Math.round(((typeof end === "number" ? end : now) - start) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function SubagentFields({
  fields,
}: {
  fields: Array<[string, string]>;
}) {
  return (
    <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1 px-3 py-2 text-tiny">
      {fields.map(([label, value]) => (
        <div className="contents" key={label}>
          <dt className="text-[var(--color-text-tertiary)]">{label}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function taskTimingFields(payload: ParsedToolPayload, nowMs: number) {
  const task = payload.prompt ?? (typeof payload.task === "string" ? payload.task : "");
  const endAtMs = payload.completedAtMs ?? payload.interruptedAtMs;
  return [
    ["Name", roleLabel(payload.name)],
    ["Task", task || "—"],
    ["Status", payload.status ?? "unknown"],
    ["Started", timestamp(payload.createdAtMs)],
    ["Elapsed", elapsed(payload.createdAtMs, endAtMs, nowMs)],
    ...(payload.completedAtMs ? [["Completed", timestamp(payload.completedAtMs)]] : []),
    ...(payload.interruptedAtMs ? [["Interrupted", timestamp(payload.interruptedAtMs)]] : []),
  ] as Array<[string, string]>;
}

function SubagentToolDetails({ run }: { run: ToolRunEntry }) {
  const isActive = isLiveRun(run);
  const [nowMs, setNowMs] = useState(Date.now());
  const payload = { ...(run.callPayload ?? {}), ...(run.resultPayload ?? {}) };
  const action = payload.action;
  const listedTasks = payload.tasks ?? [];
  const waitedTask = typeof payload.task === "object" ? payload.task : null;

  useEffect(() => {
    if (!isActive) {
      return;
    }
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isActive]);

  if (action === "list") {
    return (
      <div className="divide-y divide-[var(--color-border)]">
        <SubagentFields fields={[["Action", "list"], ["Subagents", String(listedTasks.length)]]} />
        {listedTasks.length > 0 ? listedTasks.map((task) => (
          <SubagentFields key={task.taskId ?? task.name} fields={[
            ...taskTimingFields(task, nowMs),
            ["Task ID", task.taskId ?? "—"],
          ]} />
        )) : <p className="px-3 py-2 text-[12px] text-[var(--color-text-tertiary)]">No subagents created.</p>}
      </div>
    );
  }

  if (action === "wait") {
    const task = { ...payload, ...(waitedTask ?? {}) };
    return (
      <div>
        <SubagentFields fields={[
          ["Action", "wait"],
          ["Task ID", task.taskId ?? "—"],
          ["Timeout", payload.timeoutMs ?? "5m"],
          ["Name", roleLabel(task.name)],
          ["Status", task.status ?? "unknown"],
        ]} />
        <dl className="grid grid-cols-[132px_minmax(0,1fr)] gap-x-2 gap-y-1 px-3 pb-2 text-tiny">
          <dt className="text-[var(--color-text-tertiary)]">Main agent waiting</dt>
          <dd className="text-[var(--color-text-secondary)]">{elapsed(run.startedAtMs, isActive ? null : Date.now(), nowMs)}</dd>
          <dt className="text-[var(--color-text-tertiary)]">Total execution</dt>
          <dd className="text-[var(--color-text-secondary)]">{elapsed(task.createdAtMs, task.completedAtMs ?? task.interruptedAtMs, nowMs)}</dd>
        </dl>
        {payload.timedOut ? <p className="px-3 pb-2 text-[12px] text-[var(--color-text-tertiary)]">Wait timed out; the subagent may still be active.</p> : null}
      </div>
    );
  }

  if (action === "create") {
    return <SubagentFields fields={[
      ["Action", "create"],
      ["Name", roleLabel(payload.name)],
      ["Prompt", payload.prompt ?? "—"],
      ["Join", payload.join ?? "—"],
      ["Task ID", payload.taskId ?? "—"],
      ["Status", payload.status ?? "unknown"],
      ["Created", timestamp(payload.createdAtMs)],
      ["Elapsed", elapsed(payload.createdAtMs, payload.completedAtMs ?? payload.interruptedAtMs, nowMs)],
    ]} />;
  }

  if (action === "send_message") {
    return <SubagentFields fields={[
      ["Action", "send message"],
      ["Task ID", payload.taskId ?? "—"],
      ["Prompt", payload.prompt ?? "—"],
      ["Status", payload.status ?? "unknown"],
      ...(payload.pendingMessageCount ? [["Queued", String(payload.pendingMessageCount)] as [string, string]] : []),
    ]} />;
  }

  if (action === "interrupt") {
    return <SubagentFields fields={[
      ["Action", "interrupt"],
      ["Task ID", payload.taskId ?? "—"],
      ["Name", roleLabel(payload.name)],
      ["Task", typeof payload.task === "string" ? payload.task : "—"],
      ["Status", payload.status ?? "unknown"],
      ["Interrupted", timestamp(payload.interruptedAtMs)],
    ]} />;
  }

  return <SubagentFields fields={[["Action", action ?? "unknown"]]} />;
}

function TodoToolDetails({ run }: { run: ToolRunEntry }) {
  const payload = { ...(run.callPayload ?? {}), ...(run.resultPayload ?? {}) };
  const items = (payload.items ?? []).map((item) => typeof item === "string"
    ? { status: "pending", title: item }
    : item);
  if (items.length === 0) {
    return <p className="px-3 py-2 text-[12px] text-[var(--color-text-tertiary)]">No TODO items.</p>;
  }
  return (
    <div className="max-h-56 space-y-1 overflow-y-auto px-3 py-2">
      {items.map((item, index) => {
        const Icon = item.status === "completed" ? CircleCheckBig : item.status === "cancelled" ? CircleX : item.status === "in_progress" ? CircleDot : Circle;
        return (
          <div className="flex items-start gap-2 text-[12px] leading-4" key={item.id ?? `${item.title}-${index}`}>
            <Icon className={[
              "mt-0.5 h-3.5 w-3.5 shrink-0",
              item.status === "completed" ? "text-[var(--color-brand-green)]" : "text-[var(--color-text-tertiary)]",
            ].join(" ")} />
            <span className={item.status === "completed" || item.status === "cancelled" ? "text-[var(--color-text-tertiary)] line-through" : item.status === "in_progress" ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-secondary)]"}>
              {item.title ?? "Untitled item"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ClarifyToolDetails({ run }: { run: ToolRunEntry }) {
  const payload = { ...(run.callPayload ?? {}), ...(run.resultPayload ?? {}) };
  const presentation = resolveClarifyToolPresentation(payload);
  if (presentation.kind === "freeform") {
    return (
      <div className="space-y-1.5 px-3 py-2 text-[12px] leading-4">
        <p className="text-[var(--color-text-secondary)]">{presentation.question}</p>
        {presentation.answer ? <p className="font-medium text-[var(--color-text)]">{presentation.answer}</p> : null}
      </div>
    );
  }
  return (
    <div className="px-3 py-2">
      <p className="mb-1.5 text-[12px] leading-4 text-[var(--color-text-secondary)]">{presentation.question}</p>
      <div className="space-y-1">
        {presentation.choices.map((choice) => (
          <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]" key={choice.label}>
            <input checked={choice.isSelected} className="accent-[var(--color-brand-green)]" name={`clarify-history-${run.id}`} readOnly type="radio" />
            <span className={choice.isSelected ? "font-medium text-[var(--color-text)]" : undefined}>{choice.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ToolRunRow({
  onManualExpandChange,
  run,
}: {
  onManualExpandChange?: (hasManualExpansion: boolean) => void;
  run: ToolRunEntry;
}) {
  const isActive = isLiveRun(run);
  // I-8: individual tool calls stay collapsed unless the user expands them.
  const { isOpen, toggle } = useAutoDisclosure(false);
  const outputText = terminalOutput(run).trim();
  const hasDiff =
    typeof run.resultPayload?.beforeContent === "string" &&
    typeof run.resultPayload?.afterContent === "string";
  const errorText = run.resultPayload?.error ?? run.result?.error ?? "";
  const isExpandable = run.isExpandable || Boolean(outputText) || Boolean(errorText) || isActive;
  const isBackgroundBash = run.kind === "bash" && isBackgroundStart(run);

  return (
    <div>
      {isExpandable ? (
        <button
          className="flex w-full items-center gap-2 py-1 text-left text-ui-tight text-[var(--color-text-secondary)] transition hover:text-[var(--color-text)]"
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
          {isBackgroundBash ? (
            <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
              Background
            </span>
          ) : null}
        </button>
      ) : (
        <div className="flex items-center gap-2 py-1 text-ui-tight text-[var(--color-text-secondary)]">
          <span className="min-w-0 flex-1 truncate">{run.detailLabel}</span>
          {isBackgroundBash ? (
            <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
              Background
            </span>
          ) : null}
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
              {run.kind === "bash" ? (
                <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel-muted)_68%,transparent)]">
                  <BashToolDetails outputText={outputText} run={run} />
                </div>
              ) : null}
              {run.kind === "subagent" ? (
                <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel-muted)_68%,transparent)]">
                  <div className="border-b border-[var(--color-border)] px-3 py-2 text-[12px] text-[var(--color-text-tertiary)]">
                    Subagent
                  </div>
                  <div className="max-h-[280px] overflow-auto"><SubagentToolDetails run={run} /></div>
                </div>
              ) : null}
              {run.kind === "todo" ? (
                <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel-muted)_68%,transparent)]">
                  <TodoToolDetails run={run} />
                </div>
              ) : null}
              {run.kind === "clarify" ? (
                <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel-muted)_68%,transparent)]">
                  <ClarifyToolDetails run={run} />
                </div>
              ) : null}
              {!hasDiff && errorText.trim() ? (
                <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)] px-3 py-2 text-[12px] leading-4 text-[var(--color-text-secondary)]">
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
  isActiveGroup = false,
  isStreamingTurn = false,
  onManualExpandChange,
  runs,
}: ToolActivityGroupProps) {
  const regularRuns = runs;
  const hasMultipleRuns = regularRuns.length > 1;
  const summaryLabel = useMemo(() => summarizeToolRuns(regularRuns), [regularRuns]);
  const [manuallyExpandedRunIds, setManuallyExpandedRunIds] = useState(() => new Set<string>());
  const hasManualExpansion = manuallyExpandedRunIds.size > 0;
  const shouldAutoOpen = shouldOpenToolGroup({
    hasManualExpansion,
    isActiveGroup,
    isStreaming: isStreamingTurn,
  });
  const { isOpen, toggle } = useAutoDisclosure(shouldAutoOpen);

  if (runs.length === 0) {
    return null;
  }

  if (!hasMultipleRuns) {
    return <ToolRunRow onManualExpandChange={onManualExpandChange} run={regularRuns[0]!} />;
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
        className="flex w-full items-center gap-2 py-1 text-left text-ui-tight text-[var(--color-text-secondary)] transition hover:text-[var(--color-text)]"
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
            {regularRuns.map((run) => (
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
