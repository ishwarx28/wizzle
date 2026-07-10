import { resolveMaxPromptSize } from "./env";

/** Single source for composer + send + queue prompt length limits (#42). */
export function resolvePromptMaxChars() {
  return resolveMaxPromptSize();
}

export function clampPromptText(text: string, maxChars = resolvePromptMaxChars()) {
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(0, maxChars);
}

export function isPromptOverLimit(text: string, maxChars = resolvePromptMaxChars()) {
  return text.length > maxChars;
}

export function formatPromptTooLargeError(maxChars = resolvePromptMaxChars()) {
  return `Prompts can be at most ${maxChars.toLocaleString()} characters.`;
}

/**
 * Whether text was truncated when applying a draft update.
 * Used to toast when paste/enhance/restore exceeds the limit.
 */
export function applyPromptLimit(
  text: string,
  maxChars = resolvePromptMaxChars(),
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return { text: text.slice(0, maxChars), truncated: true };
}
