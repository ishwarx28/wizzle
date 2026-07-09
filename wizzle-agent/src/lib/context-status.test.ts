import {
  beginContextCompaction,
  completeContextCompaction,
  contextStatusLabel,
  interleaveContextStatus,
} from "./context-status.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(contextStatusLabel("compacting") === "Compacting context…", "compacting label");
  assert(contextStatusLabel("compacted") === "Compacted context", "compacted label");

  const started = beginContextCompaction(null, 3, 100);
  assert(started.phase === "compacting", "start phase");
  assert(started.afterMessageCount === 3, "anchor count");

  const finished = completeContextCompaction(started, 200);
  assert(finished.phase === "compacted", "finish phase");
  assert(finished.afterMessageCount === 3, "anchor preserved");

  const messages = ["a", "b", "c", "d"];
  const interleaved = interleaveContextStatus(messages, finished);
  assert(interleaved.length === 5, "message + divider");
  assert(interleaved[3]?.type === "context-status", "divider after third message (index 3)");
  assert(
    interleaved[3]?.type === "context-status" && interleaved[3].phase === "compacted",
    "compacted phase in stream",
  );
  assert(interleaved[0]?.type === "message" && interleaved[0].message === "a", "first msg");
  assert(interleaved[4]?.type === "message" && interleaved[4].message === "d", "last msg");

  const atEnd = interleaveContextStatus(["x"], beginContextCompaction(null, 1, 1));
  assert(atEnd.length === 2 && atEnd[1]?.type === "context-status", "divider at end");

  console.log("context-status tests passed");
}

main();
