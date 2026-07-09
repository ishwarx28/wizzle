import { contextStatusLabel, type ContextCompactionPhase } from "../../lib/context-status";

export function ContextStatusDivider({ phase }: { phase: ContextCompactionPhase }) {
  const label = contextStatusLabel(phase);

  return (
    <div
      aria-live={phase === "compacting" ? "polite" : undefined}
      className="flex items-center gap-3 py-1"
      role="status"
    >
      <div className="h-px flex-1 bg-[var(--color-border)]" />
      <span className="shrink-0 text-[12px] text-[var(--color-text-tertiary)]">{label}</span>
      <div className="h-px flex-1 bg-[var(--color-border)]" />
    </div>
  );
}
