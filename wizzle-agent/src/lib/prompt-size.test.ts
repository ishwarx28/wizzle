// vite injects this at build time; node tests need a stub before env.ts loads.
(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {
  WIZZLE_FRONTEND_LOG_MODE: "off",
};

export {};

const {
  applyPromptLimit,
  clampPromptText,
  formatPromptTooLargeError,
  isPromptOverLimit,
} = await import("./prompt-size.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(!isPromptOverLimit("short", 100), "short ok");
  assert(isPromptOverLimit("abcdef", 5), "over limit");
  assert(clampPromptText("abcdef", 4) === "abcd", "clamp");
  assert(formatPromptTooLargeError(20480).includes("20,480"), "error copy");

  const fit = applyPromptLimit("hello", 10);
  assert(!fit.truncated && fit.text === "hello", "no truncate");

  const cut = applyPromptLimit("hello world", 5);
  assert(cut.truncated && cut.text === "hello", "truncated flag");

  console.log("prompt-size tests passed");
}

main();
