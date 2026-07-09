import {
  extractMessageText,
  sanitizeGeneratedSessionTitle,
} from "./chat-completion-text.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(
    extractMessageText({
      choices: [{ message: { content: "  Fix login bug  " } }],
    }) === "Fix login bug",
    "string content",
  );

  assert(
    extractMessageText({
      choices: [
        {
          message: {
            content: "",
            reasoning_content: "I should name this chat.\n\nAuth session timeout",
          },
        },
      ],
    }) === "I should name this chat.\n\nAuth session timeout",
    "reasoning_content fallback when content empty",
  );

  assert(
    extractMessageText({
      choices: [
        {
          message: {
            content: null,
            reasoning: "Auth session timeout",
          },
        },
      ],
    }) === "Auth session timeout",
    "reasoning fallback",
  );

  assert(
    extractMessageText({
      choices: [
        {
          message: {
            content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }],
          },
        },
      ],
    }) === "Hello world",
    "content parts array",
  );

  assert(
    sanitizeGeneratedSessionTitle('<think>long plan</think>\n"Fix login flow"') === "Fix login flow",
    "strip think + quotes",
  );
  assert(
    sanitizeGeneratedSessionTitle("Title: Debug API errors\nMore text about stuff") ===
      "Debug API errors",
    "title prefix + short line",
  );
  assert(sanitizeGeneratedSessionTitle("   ") === "", "empty");

  console.log("chat-completion-text tests passed");
}

main();
