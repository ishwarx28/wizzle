import {
  BOTTOM_FOLLOW_TOLERANCE_PX,
  BOTTOM_INDICATOR_THRESHOLD_PX,
  distanceFromBottom,
  shouldFollowAfterScroll,
} from "./chat-scroll.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main() {
  assert(
    distanceFromBottom({ clientHeight: 600, scrollHeight: 1_600, scrollTop: 1_000 }) === 0,
    "distance is zero at the bottom",
  );
  assert(
    distanceFromBottom({ clientHeight: 600, scrollHeight: 1_600, scrollTop: 950 }) === 50,
    "distance reports the remaining scroll range",
  );
  assert(
    BOTTOM_FOLLOW_TOLERANCE_PX < BOTTOM_INDICATOR_THRESHOLD_PX,
    "follow lock is stricter than the indicator",
  );
  assert(
    !shouldFollowAfterScroll({
      distanceFromBottom: 20,
      following: true,
      previousScrollTop: 1_000,
      scrollTop: 980,
    }),
    "an upward gesture immediately releases bottom follow inside the indicator threshold",
  );
  assert(
    shouldFollowAfterScroll({
      distanceFromBottom: 40,
      following: true,
      previousScrollTop: 1_000,
      scrollTop: 1_000,
    }),
    "content growth does not release bottom follow",
  );
  assert(
    !shouldFollowAfterScroll({
      distanceFromBottom: 1,
      following: false,
      previousScrollTop: 1_000,
      scrollTop: 999,
    }),
    "layout shrink does not silently resume a released follow lock",
  );
  assert(
    shouldFollowAfterScroll({
      distanceFromBottom: 0,
      following: false,
      previousScrollTop: 999,
      scrollTop: 1_000,
    }),
    "scrolling back to the exact bottom resumes follow",
  );

  console.log("chat-scroll tests passed");
}

main();
