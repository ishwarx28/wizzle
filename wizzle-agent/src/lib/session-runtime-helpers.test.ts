import {
  shouldManageSessionRuntimeForHelperCompletion,
  shouldReleaseSessionRuntimeToIdle,
} from "./session-runtime-helpers.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(
    shouldManageSessionRuntimeForHelperCompletion() === false,
    "helpers never manage runtime",
  );

  assert(
    shouldReleaseSessionRuntimeToIdle({ sessionRunActive: true }) === false,
    "active agent run blocks Idle release",
  );
  assert(
    shouldReleaseSessionRuntimeToIdle({ sessionRunActive: false }) === true,
    "no agent run allows Idle",
  );

  console.log("session-runtime-helpers tests passed");
}

main();
