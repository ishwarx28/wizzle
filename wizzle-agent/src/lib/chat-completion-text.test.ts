import {
  extractCompletionContentText,
  extractMessageText,
  extractTitleFromCompletion,
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
    extractCompletionContentText({
      choices: [
        {
          message: {
            content: "",
            reasoning_content: "long reasoning that must not be content",
          },
        },
      ],
    }) === "",
    "content extractor ignores reasoning",
  );

  assert(
    extractTitleFromCompletion({
      choices: [
        {
          message: {
            content: "Auth refresh tokens",
            reasoning_content: "I will think about naming...\nmany lines\nof plan",
          },
        },
      ],
    }) === "Auth refresh tokens",
    "title prefers content over reasoning",
  );

  const longReasoning = [
    "The user asked about debugging production 500 errors.",
    "I should consider logs, deploys, and databases.",
    "Debugging production 500s",
  ].join("\n");

  assert(
    extractTitleFromCompletion({
      choices: [
        {
          message: {
            content: "",
            reasoning_content: longReasoning,
          },
        },
      ],
    }) === "",
    "never take title from reasoning when content is empty",
  );

  assert(
    extractTitleFromCompletion({
      choices: [
        {
          message: {
            content: "",
            reasoning:
              "I am carefully analyzing the user request and considering many aspects of the problem without a short title line at the end",
          },
        },
      ],
    }) === "",
    "never take title from reasoning field",
  );

  assert(
    extractTitleFromCompletion({
      choices: [
        {
          message: {
            content: "Here is a great title for this chat: Fix login",
          },
        },
      ],
    }) === "",
    "reject filler preamble as title",
  );

  assert(
    extractTitleFromCompletion({
      choices: [
        {
          message: {
            content: "Sure, I can help with that",
          },
        },
      ],
    }) === "",
    "reject conversational filler title",
  );

  assert(
    extractTitleFromCompletion({
      choices: [
        {
          message: {
            content: "Fix OAuth callback errors",
          },
        },
      ],
    }) === "Fix OAuth callback errors",
    "accept direct title-only content",
  );

  assert(
    sanitizeGeneratedSessionTitle("a".repeat(120)).length <= 50,
    "hard cap length",
  );
  assert(
    sanitizeGeneratedSessionTitle('<think>plan</think>\n"Fix login flow"') === "Fix login flow",
    "strip think + quotes",
  );

  console.log("chat-completion-text tests passed");
}

main();
