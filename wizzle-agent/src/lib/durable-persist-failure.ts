/**
 * Mid-stream durable persist failures (#6).
 * Do not abort the agent turn; surface a soft warning so the user knows a
 * crash may lose unflushed content.
 */

export const DEFAULT_DURABLE_PERSIST_FAILURE_THROTTLE_MS = 8_000;

export function getDurablePersistErrorDetail(error: unknown): string {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return "Unknown save error.";
}

export function formatDurablePersistFailureMessage(error: unknown): string {
  const detail = getDurablePersistErrorDetail(error);
  return [
    "Could not save the conversation while streaming.",
    detail,
    "If the app closes now, some of this reply may be missing.",
  ].join(" ");
}

/**
 * Throttle soft UI reports so a flapping disk/DB does not spam chatError.
 * Returns true when the failure should be shown to the user.
 */
export function shouldReportDurablePersistFailure(options: {
  lastReportedAtMs: number | null;
  nowMs: number;
  throttleMs?: number;
}): boolean {
  const throttleMs = options.throttleMs ?? DEFAULT_DURABLE_PERSIST_FAILURE_THROTTLE_MS;
  if (options.lastReportedAtMs === null) {
    return true;
  }

  return options.nowMs - options.lastReportedAtMs >= throttleMs;
}

export function createDurablePersistFailureReporter(options: {
  onReport: (message: string) => void;
  throttleMs?: number;
  now?: () => number;
}) {
  let lastReportedAtMs: number | null = null;
  const now = options.now ?? (() => Date.now());

  return {
    report(error: unknown): boolean {
      const nowMs = now();
      if (
        !shouldReportDurablePersistFailure({
          lastReportedAtMs,
          nowMs,
          throttleMs: options.throttleMs,
        })
      ) {
        return false;
      }

      lastReportedAtMs = nowMs;
      options.onReport(formatDurablePersistFailureMessage(error));
      return true;
    },
    reset() {
      lastReportedAtMs = null;
    },
  };
}
