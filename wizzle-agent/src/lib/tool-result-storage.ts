/**
 * Durable storage sanitization for tool results (#52).
 *
 * Live in-memory tool messages keep full payloads for the current turn (so
 * image-capable models can still inject image context via imageSrc).
 * Only SQL/persist paths should call these helpers.
 */

/** Cap stored text file bodies from `read` (characters). */
export const MAX_STORED_READ_CONTENT_CHARS = 48_000;

/**
 * When is `imageSrc` omitted from durable storage?
 *
 * Omitted when ALL of the following hold:
 * 1. We are serializing a tool result (or tool message content/part output) for
 *    durable persist (`append_or_update_message` / full session persist).
 * 2. The payload is JSON (object) — or a string that parses as a JSON object.
 * 3. The object has an `imageSrc` field whose value is a string.
 * 4. That string is a data URL: it starts with `data:` (typically
 *    `data:image/...;base64,...` from the read tool).
 *
 * Not omitted when:
 * - The value is still only in memory for the active turn (not going through
 *   `buildPersistedMessages` / storage sanitize).
 * - `imageSrc` is missing, empty, or not a data URL (e.g. a plain path/URL
 *   without `data:` — we still strip only data-URL imageSrc for safety if
 *   present as data:).
 * - Provider replay uses a separate path (`sanitizeToolResultContentForReplay`)
 *   which redacts data URLs for the model request; that does not change SQL.
 *
 * After omit we set:
 * - `imageSrcOmitted: true`
 * - `imageSrcOmittedApproxBytes` / note string when size can be estimated
 * - keep path, mimeType, contentHash, bytes, binary, etc.
 */

export function isDataUrlImageSrc(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("data:") && value.includes(",");
}

function formatApproxByteCount(value: number) {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} bytes`;
}

function estimateDataUrlBytes(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(",");
  const metadata = commaIndex >= 0 ? dataUrl.slice(0, commaIndex) : "data:";
  const payloadLength = commaIndex >= 0 ? dataUrl.length - commaIndex - 1 : dataUrl.length;
  return metadata.toLowerCase().includes(";base64")
    ? Math.floor((payloadLength * 3) / 4)
    : payloadLength;
}

function truncateStoredText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  const marker = `\n\n[...${formatApproxByteCount(value.length - maxChars)} omitted from storage...]\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.7);
  const tail = Math.max(0, available - head);
  return {
    text: `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ""}`,
    truncated: true,
  };
}

/**
 * Returns true when storage sanitize will drop this imageSrc (condition #3+#4).
 */
export function shouldOmitImageSrcFromStorage(imageSrc: unknown): boolean {
  return isDataUrlImageSrc(imageSrc);
}

function omitImageSrcFromRecord(record: Record<string, unknown>): {
  changed: boolean;
  value: Record<string, unknown>;
} {
  const imageSrc = record.imageSrc;
  if (typeof imageSrc !== "string" || !isDataUrlImageSrc(imageSrc)) {
    return { changed: false, value: record };
  }

  const approxBytes = estimateDataUrlBytes(imageSrc);
  const next: Record<string, unknown> = { ...record };
  delete next.imageSrc;
  next.imageSrcOmitted = true;
  next.imageSrcOmittedApproxBytes = approxBytes;
  next.imageSrcOmittedNote = `Inline image data omitted from durable storage (~${formatApproxByteCount(approxBytes)}). Re-read the file if the model needs the image again.`;

  return { changed: true, value: next };
}

function compactReadResultForStorage(record: Record<string, unknown>): Record<string, unknown> {
  let next = { ...record };
  const imageOmit = omitImageSrcFromRecord(next);
  next = imageOmit.value;

  const content = typeof next.content === "string" ? next.content : "";
  if (content) {
    const truncated = truncateStoredText(content, MAX_STORED_READ_CONTENT_CHARS);
    if (truncated.truncated) {
      next.content = truncated.text;
      next.contentTruncatedForStorage = true;
      next.contentOriginalLength = content.length;
    }
  }

  return next;
}

function compactBashResultForStorage(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  for (const field of ["combinedOutput", "stdout", "stderr"] as const) {
    const value = typeof next[field] === "string" ? (next[field] as string) : "";
    if (!value) {
      continue;
    }
    const truncated = truncateStoredText(value, MAX_STORED_READ_CONTENT_CHARS);
    if (truncated.truncated) {
      next[field] = truncated.text;
      next[`${field}TruncatedForStorage`] = true;
      next[`${field}OriginalLength`] = value.length;
    }
  }
  return next;
}

/**
 * Sanitize tool result JSON/text for SQL persistence (#52).
 * Always safe to call: non-JSON strings pass through unless they are bare data URLs.
 */
export function sanitizeToolResultContentForStorage(
  content: string,
  options: { toolName?: string | null } = {},
): string {
  if (!content) {
    return content;
  }

  // Bare data URL (unlikely for tools, but defensive).
  if (isDataUrlImageSrc(content)) {
    const approxBytes = estimateDataUrlBytes(content);
    return JSON.stringify({
      imageSrcOmitted: true,
      imageSrcOmittedApproxBytes: approxBytes,
      imageSrcOmittedNote: `Inline image data omitted from durable storage (~${formatApproxByteCount(approxBytes)}).`,
      ok: true,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content.length > MAX_STORED_READ_CONTENT_CHARS
      ? truncateStoredText(content, MAX_STORED_READ_CONTENT_CHARS).text
      : content;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return content;
  }

  const record = { ...(parsed as Record<string, unknown>) };
  const toolName = options.toolName ?? undefined;

  let nextRecord: Record<string, unknown>;
  if (toolName === "read" || record.imageSrc !== undefined || record.binary === true) {
    nextRecord = compactReadResultForStorage(record);
  } else if (toolName === "bash") {
    nextRecord = compactBashResultForStorage(record);
  } else {
    // Any tool: still drop data-URL imageSrc if present.
    nextRecord = omitImageSrcFromRecord(record).value;
  }

  return JSON.stringify(nextRecord);
}

export function sanitizeMessageContentForStorage(
  content: string,
  options: { role?: string; toolName?: string | null } = {},
) {
  if (options.role === "tool" || options.toolName) {
    return sanitizeToolResultContentForStorage(content, { toolName: options.toolName });
  }
  return content;
}

export function sanitizeMessagePartForStorage(part: {
  content?: string | null;
  name?: string | null;
  output?: string | null;
  type: string;
}) {
  if (part.type !== "tool_result") {
    return part;
  }

  const toolName = part.name;
  return {
    ...part,
    content:
      part.content != null
        ? sanitizeToolResultContentForStorage(part.content, { toolName })
        : part.content,
    output:
      part.output != null
        ? sanitizeToolResultContentForStorage(part.output, { toolName })
        : part.output,
  };
}
