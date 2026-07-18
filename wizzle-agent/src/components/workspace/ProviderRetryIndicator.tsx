import { RefreshCw } from "lucide-react";

import type { ProviderRetryStatus } from "../../types/workspace";

export function ProviderRetryIndicator({ retry }: { retry: ProviderRetryStatus }) {
  const delaySeconds = Math.max(0.1, retry.delayMs / 1_000);
  const delayLabel = delaySeconds.toFixed(Number.isInteger(delaySeconds) ? 0 : 1);

  return (
    <div
      aria-live="polite"
      className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 py-2 text-[13px] text-[var(--color-text-secondary)]"
      role="status"
    >
      <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-accent)]" />
      <span className="min-w-0 flex-1">{retry.message}</span>
      <span className="shrink-0 text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
        Retry {retry.attempt}/{retry.maxAttempts} · {delayLabel}s
      </span>
    </div>
  );
}
