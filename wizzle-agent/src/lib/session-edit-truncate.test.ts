import {
  collectRetainedTurnIds,
  filterCompactedTurnIds,
} from "./session-edit-truncate.ts";
import type { Message } from "../types/workspace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function msg(turnId?: string): Message {
  return {
    content: "x",
    createdAtLabel: "now",
    id: `m-${turnId ?? "none"}`,
    role: "user",
    turnId,
  };
}

function main() {
  const ids = collectRetainedTurnIds([msg("a"), msg("a"), msg("b"), msg()]);
  assert(ids.length === 2 && ids.includes("a") && ids.includes("b"), "unique turn ids");

  assert(
    filterCompactedTurnIds(["a", "gone", "b"], ["a", "b"]).join(",") === "a,b",
    "filter compacted ids",
  );

  console.log("session-edit-truncate tests passed");
}

main();
