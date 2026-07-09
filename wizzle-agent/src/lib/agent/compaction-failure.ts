/**
 * Compaction failure policy after the user message is already accepted (#35).
 * Never send history with unsummarized drops (still #33). Soft-settle only when
 * tools already mutated the workspace so we do not mark successful tool work
 * as a hard turn error.
 */

export type CompactionFailureAction = "hard_fail" | "soft_settle_done";

export class CompactionFailureError extends Error {
  readonly code = "compaction_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "CompactionFailureError";
  }
}

export function isCompactionFailureError(error: unknown): error is CompactionFailureError {
  return error instanceof CompactionFailureError;
}

export function resolveCompactionFailureAction(options: {
  usedToolsInTurn: boolean;
}): CompactionFailureAction {
  return options.usedToolsInTurn ? "soft_settle_done" : "hard_fail";
}

export function buildCompactionFailureUserMessage(errorMessage: string) {
  const detail = errorMessage.trim() || "Context could not be compacted.";
  return [
    "Tool work for this turn finished,",
    "but context compaction failed and the run could not continue safely.",
    detail,
  ].join(" ");
}

export function toCompactionFailureError(error: unknown): CompactionFailureError {
  if (error instanceof CompactionFailureError) {
    return error;
  }

  if (error instanceof Error && error.message.trim()) {
    return new CompactionFailureError(error.message.trim());
  }

  if (typeof error === "string" && error.trim()) {
    return new CompactionFailureError(error.trim());
  }

  return new CompactionFailureError(
    "Could not free enough context by compacting older turns. Try a larger-context model or start a new chat.",
  );
}
