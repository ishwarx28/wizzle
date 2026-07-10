import {
  buildForcedFinalFallbackText,
  resolveForcedFinalDisplayContent,
  resolveForcedFinalErrorMessage,
} from "./forced-final.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(
    resolveForcedFinalErrorMessage(new Error("provider down")) === "provider down",
    "error message from Error",
  );
  assert(
    resolveForcedFinalErrorMessage("boom") === "boom",
    "error message from string",
  );
  assert(
    resolveForcedFinalErrorMessage(null).includes("Unknown"),
    "unknown error fallback",
  );

  const emptyAfterTools = resolveForcedFinalDisplayContent({
    kind: "after_tools",
    streamedContent: "   ",
  });
  assert(emptyAfterTools.kind === "empty", "empty after tools");
  assert(emptyAfterTools.usedFallback === true, "empty uses fallback");
  assert(emptyAfterTools.content.includes("empty final reply"), "empty copy");

  const failedAfterTools = resolveForcedFinalDisplayContent({
    error: new Error("stream reset"),
    kind: "after_tools",
    streamedContent: "",
  });
  assert(failedAfterTools.kind === "failed", "failed after tools");
  assert(failedAfterTools.content.includes("stream reset"), "includes error");
  assert(failedAfterTools.content.includes("Tool work"), "keeps tool-work framing");

  const partialFailed = resolveForcedFinalDisplayContent({
    error: new Error("cut off"),
    kind: "after_tools",
    streamedContent: "Here is a partial answer",
  });
  assert(partialFailed.kind === "failed", "partial still failed outcome");
  assert(
    partialFailed.content === "Here is a partial answer",
    "prefer partial model text over replacing it",
  );

  const ok = resolveForcedFinalDisplayContent({
    kind: "after_tools",
    streamedContent: "All done.",
  });
  assert(ok.kind === "ok", "ok when model returns text");
  assert(ok.content === "All done.", "ok content preserved");

  const maxEmpty = resolveForcedFinalDisplayContent({
    kind: "max_steps",
    streamedContent: "",
  });
  assert(maxEmpty.kind === "empty", "max steps empty");
  assert(maxEmpty.content.includes("maximum number of tool steps"), "max steps copy");

  const maxFailed = buildForcedFinalFallbackText({
    errorMessage: "timeout",
    kind: "max_steps",
    reason: "failed",
  });
  assert(maxFailed.includes("timeout"), "max steps failed includes error");
  assert(maxFailed.includes("Tool work from this turn is kept"), "max steps keeps tools");

  const pressureEmpty = resolveForcedFinalDisplayContent({
    kind: "context_pressure",
    streamedContent: "",
  });
  assert(pressureEmpty.kind === "empty", "context pressure empty");
  assert(pressureEmpty.content.includes("Context filled up"), "pressure empty copy");

  const pressureFailed = buildForcedFinalFallbackText({
    errorMessage: "timeout",
    kind: "context_pressure",
    reason: "failed",
  });
  assert(pressureFailed.includes("timeout"), "pressure failed includes error");
  assert(pressureFailed.includes("Context filled up"), "pressure failed framing");

  console.log("forced-final tests passed");
}

main();
