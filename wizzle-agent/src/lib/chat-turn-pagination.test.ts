import {
  TURN_PAGE_SIZE,
  hasEarlierUserTurns,
  initialVisibleTurnCount,
  nextVisibleTurnCount,
  reconcileVisibleTurnCountAfterHydrate,
  visibleRawStartIndexForTurns,
} from "./chat-turn-pagination.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(initialVisibleTurnCount() === TURN_PAGE_SIZE, "initial is full page");
  assert(!hasEarlierUserTurns(2, 10), "2 turns with window 10 → no earlier");
  assert(!hasEarlierUserTurns(10, 10), "exactly one page → no earlier");
  assert(hasEarlierUserTurns(11, 10), "11 turns → earlier exists");
  assert(!hasEarlierUserTurns(0, 10), "empty session → no earlier");

  // Stuck count after empty-session switch (the I-1 bug).
  assert(
    reconcileVisibleTurnCountAfterHydrate(2, 1) === TURN_PAGE_SIZE,
    "hydrate fixes stuck visible=1 when 2 turns",
  );
  assert(
    reconcileVisibleTurnCountAfterHydrate(15, 10) === 10,
    "first page unchanged when already full",
  );
  assert(
    reconcileVisibleTurnCountAfterHydrate(25, 20) === 20,
    "user expanded window preserved",
  );
  assert(
    reconcileVisibleTurnCountAfterHydrate(0, 10) === 10,
    "empty history keeps page size",
  );

  assert(nextVisibleTurnCount(25, 10) === 20, "load +page");
  assert(nextVisibleTurnCount(25, 20) === 25, "load capped at total");
  assert(nextVisibleTurnCount(2, 10) === 2, "cap short history");

  const starts = [0, 4, 10, 16]; // 4 user turns
  assert(visibleRawStartIndexForTurns(starts, 10) === 0, "all visible");
  assert(visibleRawStartIndexForTurns(starts, 2) === 10, "last 2 turns start at index 10");
  assert(visibleRawStartIndexForTurns([], 10) === 0, "no turns");

  console.log("chat-turn-pagination tests passed");
}

main();
