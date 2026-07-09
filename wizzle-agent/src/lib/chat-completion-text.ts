export type OpenAITextPart = { type: "text"; text: string };

export type ChatCompletionJson = {
  choices?: Array<{
    message?: {
      content?: string | OpenAITextPart[] | null;
      /** Reasoning-model fields (title gen often lands here with empty content). */
      reasoning?: string | OpenAITextPart[] | null;
      reasoning_content?: string | OpenAITextPart[] | null;
      text?: string | null;
    };
    text?: string | null;
  }>;
};

function extractTextLikeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }

  return "";
}

/**
 * Extract assistant text from a non-streaming chat completion.
 * Prefers `content`, then reasoning fields used by many OpenAI-compatible models.
 * For titles, prefer {@link extractTitleFromCompletion} so reasoning does not become the title.
 */
export function extractMessageText(payload: ChatCompletionJson) {
  const choice = payload.choices?.[0];
  const message = choice?.message;

  const candidates = [
    extractTextLikeValue(message?.content),
    extractTextLikeValue(message?.reasoning_content),
    extractTextLikeValue(message?.reasoning),
    extractTextLikeValue(message?.text),
    extractTextLikeValue(choice?.text),
  ];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return "";
}

/** Visible completion text only — never reasoning (titles / short answers). */
export function extractCompletionContentText(payload: ChatCompletionJson) {
  const choice = payload.choices?.[0];
  const message = choice?.message;
  const candidates = [
    extractTextLikeValue(message?.content),
    extractTextLikeValue(message?.text),
    extractTextLikeValue(choice?.text),
  ];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return "";
}

const DEFAULT_TITLE_MAX_CHARS = 50;
const DEFAULT_TITLE_MAX_WORDS = 8;

function normalizeTitleLine(line: string) {
  return line
    .replace(/^#+\s*/, "")
    .replace(/^\*\s+/, "")
    .replace(/^[-•]\s+/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlausibleTitleLine(
  line: string,
  maxChars = DEFAULT_TITLE_MAX_CHARS,
  maxWords = DEFAULT_TITLE_MAX_WORDS,
) {
  if (!line || line.length > maxChars) {
    return false;
  }
  // Reject long prose / reasoning fragments.
  if (/[.!?]{2,}/.test(line) || line.includes("...")) {
    return false;
  }
  if (/^(i |i'm |i am |let me |the user |looking at |based on )/i.test(line)) {
    return false;
  }
  const words = line.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= maxWords;
}

/**
 * Turn raw model text into a short session title.
 * Hard-caps length so reasoning dumps never become sidebar titles.
 */
export function sanitizeGeneratedSessionTitle(
  raw: string,
  options: { maxChars?: number; maxWords?: number } = {},
) {
  const maxChars = options.maxChars ?? DEFAULT_TITLE_MAX_CHARS;
  const maxWords = options.maxWords ?? DEFAULT_TITLE_MAX_WORDS;

  let text = raw.trim();
  if (!text) {
    return "";
  }

  text = text
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ")
    .replace(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g, "$1")
    .trim();

  const lines = text
    .split(/\r?\n/)
    .map((line) => normalizeTitleLine(line))
    .filter(Boolean);

  // Prefer a short line; for multi-line dumps scan from the end (title often last).
  const fromStart = lines.find((line) => isPlausibleTitleLine(line, maxChars, maxWords));
  const fromEnd = [...lines]
    .reverse()
    .find((line) => isPlausibleTitleLine(line, maxChars, maxWords));
  let candidate = fromStart ?? fromEnd ?? "";

  // Single long blob with no newlines: take first maxWords.
  if (!candidate && lines[0]) {
    const words = lines[0]!.split(/\s+/).filter(Boolean).slice(0, maxWords);
    candidate = words.join(" ");
  }

  if (!candidate) {
    return "";
  }

  if (candidate.length <= maxChars) {
    return candidate;
  }

  // Word-boundary trim to maxChars.
  const clipped = candidate.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(" ");
  const trimmed = (lastSpace > 12 ? clipped.slice(0, lastSpace) : clipped).trim();
  return trimmed;
}

/**
 * Title-specific extraction:
 * 1) Prefer visible `content` (actual answer).
 * 2) Only if content is empty, try a *short* last line from reasoning —
 *    never return the full reasoning stream as a title.
 */
export function extractTitleFromCompletion(payload: ChatCompletionJson) {
  const content = extractCompletionContentText(payload);
  if (content) {
    return sanitizeGeneratedSessionTitle(content);
  }

  const choice = payload.choices?.[0];
  const message = choice?.message;
  const reasoning = [
    extractTextLikeValue(message?.reasoning_content),
    extractTextLikeValue(message?.reasoning),
  ]
    .map((value) => value.trim())
    .find(Boolean);

  if (!reasoning) {
    return "";
  }

  // Only accept a title-like line from the end of reasoning; ignore long prose.
  const fromReasoning = sanitizeGeneratedSessionTitle(reasoning);
  if (fromReasoning && isPlausibleTitleLine(fromReasoning)) {
    return fromReasoning;
  }

  return "";
}
