import {
  clearSessionStreamErrorMap,
  formatStreamStepUserMessage,
  setSessionStreamErrorMap,
  turnHasPartialAssistantContent,
} from "./stream-step-error.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(
    formatStreamStepUserMessage("Network error").includes("Network error"),
    "base message",
  );
  assert(
    formatStreamStepUserMessage("Network error", { hadPartialContent: true }).includes(
      "Partial content",
    ),
    "partial framing",
  );
  assert(
    formatStreamStepUserMessage("  ").includes("could not complete"),
    "empty fallback",
  );

  assert(
    turnHasPartialAssistantContent(
      [{ role: "assistant", turnId: "t1", content: "hi" }],
      "t1",
    ),
    "content partial",
  );
  assert(
    !turnHasPartialAssistantContent(
      [{ role: "assistant", turnId: "t1", content: "" }],
      "t1",
    ),
    "empty not partial",
  );
  assert(
    turnHasPartialAssistantContent(
      [
        {
          role: "assistant",
          turnId: "t1",
          parts: [{ type: "activity_content", content: "working" }],
        },
      ],
      "t1",
    ),
    "activity partial",
  );

  const withError = setSessionStreamErrorMap({}, "s1", {
    message: "boom",
    turnId: "t1",
  });
  assert(withError.s1?.message === "boom", "set error");
  assert(clearSessionStreamErrorMap(withError, "s1").s1 === undefined, "clear error");

  console.log("stream-step-error tests passed");
}

main();
