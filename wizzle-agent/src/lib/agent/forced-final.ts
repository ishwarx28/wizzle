/**
 * Forced final replies after tool work (#24 / #25 / #60).
 * Tool mutations already happened; a failed/empty final model call must not
 * mark the whole turn as a hard error.
 */

export type ForcedFinalKind = "after_tools" | "max_steps";

export type ForcedFinalOutcome =
  | { kind: "ok"; content: string }
  | { kind: "empty"; content: string; usedFallback: true }
  | { kind: "failed"; content: string; usedFallback: true; errorMessage: string };

export function resolveForcedFinalErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Unknown error while generating the final reply.";
}

export function buildForcedFinalFallbackText(options: {
  errorMessage?: string;
  kind: ForcedFinalKind;
  reason: "empty" | "failed";
}): string {
  if (options.kind === "max_steps") {
    if (options.reason === "failed") {
      return [
        "Reached the maximum number of tool steps for this turn.",
        "Tool work from this turn is kept.",
        `Generating the final summary failed: ${options.errorMessage ?? "unknown error"}.`,
      ].join(" ");
    }

    return [
      "Reached the maximum number of tool steps for this turn.",
      "Tool work from this turn is kept, but the model returned an empty final summary.",
    ].join(" ");
  }

  if (options.reason === "failed") {
    return [
      "Tool work for this turn finished.",
      `Generating the final reply failed: ${options.errorMessage ?? "unknown error"}.`,
    ].join(" ");
  }

  return [
    "Tool work for this turn finished,",
    "but the model returned an empty final reply.",
  ].join(" ");
}

/**
 * Prefer model content when non-empty; otherwise a stable fallback so the turn
 * can settle as done after tools ran.
 */
export function resolveForcedFinalDisplayContent(options: {
  error?: unknown;
  kind: ForcedFinalKind;
  streamedContent: string;
}): ForcedFinalOutcome {
  const trimmed = options.streamedContent.trim();

  if (options.error !== undefined) {
    const errorMessage = resolveForcedFinalErrorMessage(options.error);
    return {
      content: trimmed || buildForcedFinalFallbackText({
        errorMessage,
        kind: options.kind,
        reason: "failed",
      }),
      errorMessage,
      kind: "failed",
      usedFallback: true,
    };
  }

  if (!trimmed) {
    return {
      content: buildForcedFinalFallbackText({
        kind: options.kind,
        reason: "empty",
      }),
      kind: "empty",
      usedFallback: true,
    };
  }

  return {
    content: trimmed,
    kind: "ok",
  };
}
