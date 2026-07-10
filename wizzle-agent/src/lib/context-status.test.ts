import {
  beginContextCompaction,
  completeContextCompaction,
  contextStatusLabel,
  createContextCompactionEvent,
  interleaveContextStatus,
} from "./context-status.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(contextStatusLabel("compacting") === "Compacting context", "compacting label");
  assert(contextStatusLabel("compacted") === "Compacted context", "compacted label");

  const started = beginContextCompaction(null, 3, 100, "event-1");
  assert(started.phase === "compacting", "start phase");
  assert(started.afterMessageCount === 3, "anchor count");
  assert(started.eventId === "event-1", "event id saved");

  const finished = completeContextCompaction(started, 200);
  assert(finished.phase === "compacted", "finish phase");
  assert(finished.afterMessageCount === 3, "anchor preserved");
  assert(finished.eventId === "event-1", "event id preserved");

  const messages = ["a", "b", "c", "d"];
  const event = createContextCompactionEvent("compacted", 3, 400);
  const interleaved = interleaveContextStatus(messages, [event]);
  assert(interleaved.length === 5, "message + divider");
  assert(interleaved[3]?.type === "context-status", "divider after third message (index 3)");
  assert(
    interleaved[3]?.type === "context-status" && interleaved[3].phase === "compacted",
    "compacted phase in stream",
  );
  assert(interleaved[0]?.type === "message" && interleaved[0].message === "a", "first msg");
  assert(interleaved[4]?.type === "message" && interleaved[4].message === "d", "last msg");

  const atEnd = interleaveContextStatus(["x"], [createContextCompactionEvent("compacting", 1, 1)]);
  assert(atEnd.length === 2 && atEnd[1]?.type === "context-status", "divider at end");

  console.log("context-status tests passed");
}

main();
