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

/** Turn raw model text into a short session title candidate. */
export function sanitizeGeneratedSessionTitle(raw: string) {
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
    .map((line) =>
      line
        .replace(/^#+\s*/, "")
        .replace(/^\*\s+/, "")
        .replace(/^[-•]\s+/, "")
        .replace(/^title\s*:\s*/i, "")
        .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);

  const shortLine =
    lines.find((line) => {
      const words = line.split(/\s+/).filter(Boolean);
      return words.length >= 2 && words.length <= 10 && line.length <= 80;
    }) ??
    lines[0] ??
    "";

  return shortLine.trim();
}
