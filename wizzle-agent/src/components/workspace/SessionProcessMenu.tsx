import { LoaderCircle, Square, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useSessionProcesses } from "../../hooks/use-session-processes";
import { formatProcessOriginLabel } from "../../lib/session-processes";

/**
 * Compact header control: terminal icon + count badge → popup list with stop.
 * Matches titlebar density (small icons, tight padding).
 */
export function SessionProcessMenu({ sessionId }: { sessionId: string | null }) {
  const { activeProcesses, error, stopProcess, stoppingIds } = useSessionProcesses(sessionId);
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const count = activeProcesses.length;

  useEffect(() => {
    if (count === 0) {
      setIsOpen(false);
    }
  }, [count]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsOpen(false);
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  if (!sessionId || count === 0) {
    return null;
  }

  return (
    <div className="relative z-10" data-no-window-drag ref={rootRef}>
      <button
        aria-expanded={isOpen}
        aria-label={`${count} running process${count === 1 ? "" : "es"}`}
        className="relative rounded-xl p-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
        onClick={() => setIsOpen((open) => !open)}
        type="button"
      >
        <Terminal className="h-4 w-4" />
        <span className="absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-accent)] px-0.5 text-[10px] font-medium leading-none text-[var(--color-accent-foreground)]">
          {count > 9 ? "9+" : count}
        </span>
      </button>

      {isOpen ? (
        <div
          className="absolute right-0 top-full z-40 mt-1 w-[260px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel)_97%,transparent)] shadow-[0_12px_32px_rgba(0,0,0,0.22)] backdrop-blur-xl"
          data-no-window-drag
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-2.5 py-1.5">
            <span className="text-[12px] font-medium text-[var(--color-text-tertiary)]">
              Processes
            </span>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">{count}</span>
          </div>
          <ul className="max-h-[220px] overflow-y-auto py-0.5">
            {activeProcesses.map((process) => {
              const isStopping = stoppingIds.includes(process.id);
              const origin = formatProcessOriginLabel(process);

              return (
                <li
                  className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-[var(--color-panel-hover)]"
                  key={process.id}
                >
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate font-mono text-[12px] leading-snug text-[var(--color-text-secondary)]"
                      title={process.commandSummary}
                    >
                      {process.commandSummary}
                    </p>
                    {origin ? (
                      <p
                        className="truncate text-[11px] leading-snug text-[var(--color-text-tertiary)]"
                        title={[process.turnId, process.toolCallId].filter(Boolean).join(" · ")}
                      >
                        {origin}
                      </p>
                    ) : null}
                  </div>
                  <button
                    aria-label="Stop process"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-tertiary)] transition hover:bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] hover:text-[var(--color-danger)] disabled:opacity-50"
                    disabled={isStopping}
                    onClick={() => void stopProcess(process.id)}
                    title="Stop"
                    type="button"
                  >
                    {isStopping ? (
                      <LoaderCircle className="h-3 w-3 animate-spin" />
                    ) : (
                      <Square className="h-2.5 w-2.5 fill-current" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {error ? (
            <p className="border-t border-[var(--color-border)] px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
