/**
 * Live tool stdout/stderr stream buffers (#37).
 *
 * Chunks are capped for UI/SQL during the run. The final tool payload replaces
 * this only when the tool finishes. Caps must be marked so interrupt/crash
 * recovery never looks like a full successful tool output.
 */

export const MAX_TOOL_OUTPUT_BUFFER_LENGTH = 120_000;
export const MAX_TOOL_STREAM_BUFFER_LENGTH = MAX_TOOL_OUTPUT_BUFFER_LENGTH / 2;

export type BufferedToolOutput = {
  combinedOutput: string;
  stderr: string;
  stdout: string;
  /** True when any stream hit the live buffer cap. */
  truncated: boolean;
};

export function createEmptyToolStreamBuffer(): BufferedToolOutput {
  return {
    combinedOutput: "",
    stderr: "",
    stdout: "",
    truncated: false,
  };
}

function appendLimitedText(
  existing: string,
  chunk: string,
  maxLength: number,
): { text: string; truncated: boolean } {
  if (!chunk) {
    return { text: existing, truncated: false };
  }

  if (existing.length >= maxLength) {
    return { text: existing, truncated: true };
  }

  const next = `${existing}${chunk}`;
  if (next.length <= maxLength) {
    return { text: next, truncated: false };
  }

  return { text: next.slice(0, maxLength), truncated: true };
}

export function appendBufferedToolChunk(
  buffer: BufferedToolOutput,
  stream: "stderr" | "stdout",
  chunk: string,
): BufferedToolOutput {
  const combined = appendLimitedText(
    buffer.combinedOutput,
    chunk,
    MAX_TOOL_OUTPUT_BUFFER_LENGTH,
  );
  const streamField = stream === "stderr" ? "stderr" : "stdout";
  const streamNext = appendLimitedText(
    buffer[streamField],
    chunk,
    MAX_TOOL_STREAM_BUFFER_LENGTH,
  );

  return {
    combinedOutput: combined.text,
    stderr: stream === "stderr" ? streamNext.text : buffer.stderr,
    stdout: stream === "stdout" ? streamNext.text : buffer.stdout,
    truncated: buffer.truncated || combined.truncated || streamNext.truncated,
  };
}

/** Mid-run partial tool_result JSON written while the tool is still running. */
export function createToolStreamOutput(buffer: BufferedToolOutput): string {
  const payload: Record<string, unknown> = {
    combinedOutput: buffer.combinedOutput,
    ok: true,
    stderr: buffer.stderr,
    stdout: buffer.stdout,
    streamPartial: true,
  };

  if (buffer.truncated) {
    payload.truncated = true;
    payload.truncatedNote =
      "Tool output was truncated while streaming (buffer limit). Full output is only available if the tool finishes.";
  }

  return JSON.stringify(payload);
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Durable tool result when a run is interrupted (or crashes mid-stream).
 * Keeps any partial stream text and always marks incomplete state.
 */
export function createInterruptedToolStreamOutput(
  partial: BufferedToolOutput | string | null | undefined,
  reason = "User interrupted",
): string {
  let combinedOutput = "";
  let stdout = "";
  let stderr = "";
  let truncated = false;

  if (partial && typeof partial === "object") {
    combinedOutput = partial.combinedOutput;
    stdout = partial.stdout;
    stderr = partial.stderr;
    truncated = partial.truncated;
  } else if (typeof partial === "string" && partial.trim()) {
    const record = parseJsonObject(partial);
    if (record) {
      combinedOutput =
        typeof record.combinedOutput === "string" ? record.combinedOutput : "";
      stdout = typeof record.stdout === "string" ? record.stdout : "";
      stderr = typeof record.stderr === "string" ? record.stderr : "";
      truncated = record.truncated === true;
      if (!combinedOutput && !stdout && !stderr) {
        // Non-stream JSON (e.g. prior error object) — keep raw for context.
        combinedOutput = partial;
      }
    } else {
      combinedOutput = partial;
    }
  }

  const payload: Record<string, unknown> = {
    combinedOutput,
    error: reason,
    interrupted: true,
    ok: false,
    stderr,
    stdout,
  };

  if (truncated) {
    payload.truncated = true;
    payload.truncatedNote =
      "Partial tool output was truncated at the stream buffer limit before interrupt.";
  }

  if (combinedOutput || stdout || stderr) {
    payload.partialStreamPreserved = true;
  }

  return JSON.stringify(payload);
}
