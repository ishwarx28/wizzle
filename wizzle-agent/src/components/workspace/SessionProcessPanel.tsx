import { LoaderCircle, Square, Terminal } from "lucide-react";

import { useSessionProcesses } from "../../hooks/use-session-processes";
import { formatProcessOriginLabel } from "../../lib/session-processes";

export function SessionProcessPanel({ sessionId }: { sessionId: string | null }) {
  const { activeProcesses, error, stopProcess, stoppingIds } = useSessionProcesses(sessionId);

  if (!sessionId || activeProcesses.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel)_92%,transparent)] px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
        <Terminal className="h-3.5 w-3.5" />
        Background processes
      </div>
      <ul className="space-y-1">
        {activeProcesses.map((process) => {
          const isStopping = stoppingIds.includes(process.id);
          const origin = formatProcessOriginLabel(process);

          return (
            <li
              className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-2.5 py-1.5"
              key={process.id}
            >
              <div className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[12px] text-[var(--color-text-secondary)]">
                  {process.commandSummary}
                </span>
                {origin ? (
                  <span
                    className="mt-0.5 block truncate font-mono text-[10px] text-[var(--color-text-tertiary)]"
                    title={[process.turnId, process.toolCallId].filter(Boolean).join(" · ")}
                  >
                    {origin}
                  </span>
                ) : null}
              </div>
              <span className="shrink-0 text-[10px] uppercase text-[var(--color-text-tertiary)]">
                {process.status}
              </span>
              <button
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-50"
                disabled={isStopping}
                onClick={() => void stopProcess(process.id)}
                title="Stop process"
                type="button"
              >
                {isStopping ? (
                  <LoaderCircle className="h-3 w-3 animate-spin" />
                ) : (
                  <Square className="h-3 w-3 fill-current" />
                )}
                Stop
              </button>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="mt-1.5 text-[11px] text-[var(--color-danger)]">{error}</p>
      ) : null}
    </div>
  );
}
