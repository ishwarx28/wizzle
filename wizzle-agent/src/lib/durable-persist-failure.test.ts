import {
  createDurablePersistFailureReporter,
  formatDurablePersistFailureMessage,
  shouldReportDurablePersistFailure,
} from "./durable-persist-failure.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(
    formatDurablePersistFailureMessage(new Error("disk full")).includes("disk full"),
    "includes detail",
  );
  assert(
    formatDurablePersistFailureMessage(new Error("disk full")).includes("streaming"),
    "mentions streaming",
  );

  assert(
    shouldReportDurablePersistFailure({ lastReportedAtMs: null, nowMs: 1000 }),
    "first report",
  );
  assert(
    !shouldReportDurablePersistFailure({
      lastReportedAtMs: 1000,
      nowMs: 2000,
      throttleMs: 8000,
    }),
    "throttled",
  );
  assert(
    shouldReportDurablePersistFailure({
      lastReportedAtMs: 1000,
      nowMs: 10_000,
      throttleMs: 8000,
    }),
    "after throttle window",
  );

  let count = 0;
  let clock = 0;
  const reporter = createDurablePersistFailureReporter({
    now: () => clock,
    onReport: () => {
      count += 1;
    },
    throttleMs: 1000,
  });

  assert(reporter.report(new Error("a")), "report 1");
  clock = 500;
  assert(!reporter.report(new Error("b")), "throttled 2");
  clock = 1500;
  assert(reporter.report(new Error("c")), "report 3");
  assert(count === 2, "two user reports");

  console.log("durable-persist-failure tests passed");
}

main();
