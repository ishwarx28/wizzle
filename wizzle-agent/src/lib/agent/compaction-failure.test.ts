import {
  buildCompactionFailureUserMessage,
  CompactionFailureError,
  isCompactionFailureError,
  resolveCompactionFailureAction,
  toCompactionFailureError,
} from "./compaction-failure.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(
    resolveCompactionFailureAction({ usedToolsInTurn: false }) === "hard_fail",
    "pre-tools hard fail",
  );
  assert(
    resolveCompactionFailureAction({ usedToolsInTurn: true }) === "soft_settle_done",
    "post-tools soft settle",
  );

  const msg = buildCompactionFailureUserMessage("Could not free enough context.");
  assert(msg.includes("Tool work for this turn finished"), "tool framing");
  assert(msg.includes("Could not free enough context"), "includes detail");

  const err = new CompactionFailureError("Conversation too long.");
  assert(isCompactionFailureError(err), "instanceof check");
  assert(toCompactionFailureError(err).message === "Conversation too long.", "pass through");
  assert(
    toCompactionFailureError(new Error("provider down")).message === "provider down",
    "wrap Error",
  );

  console.log("compaction-failure tests passed");
}

main();
