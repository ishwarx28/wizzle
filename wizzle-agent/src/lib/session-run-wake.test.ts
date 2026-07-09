import {
  buildSessionRunWakeDetail,
  isSessionAlreadyRunningError,
  shouldWakeFollowUpRun,
  SESSION_ALREADY_RUNNING_ERROR,
} from "./session-run-wake.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(shouldWakeFollowUpRun(true), "wake when finish returns true");
  assert(!shouldWakeFollowUpRun(false), "no wake when finish returns false");

  assert(
    isSessionAlreadyRunningError(new Error(SESSION_ALREADY_RUNNING_ERROR)),
    "detect active-run error",
  );
  assert(
    isSessionAlreadyRunningError("That session already has an active run."),
    "detect string form",
  );
  assert(!isSessionAlreadyRunningError(new Error("other")), "other errors not active-run");

  assert(
    buildSessionRunWakeDetail("s1").sessionId === "s1",
    "wake detail carries session id",
  );

  console.log("session-run-wake tests passed");
}

main();
