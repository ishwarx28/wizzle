import { shouldDeferFinalForSubagentResponse } from "./subagent-finalization.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(
    !shouldDeferFinalForSubagentResponse({
      candidateWasBuffered: false,
      injectedResponseCount: 1,
    }),
    "an already-visible answer is never followed by a duplicate final answer",
  );
  assert(
    shouldDeferFinalForSubagentResponse({
      candidateWasBuffered: true,
      injectedResponseCount: 1,
    }),
    "a hidden candidate continues so the injected response can be integrated once",
  );
  assert(
    !shouldDeferFinalForSubagentResponse({
      candidateWasBuffered: true,
      injectedResponseCount: 0,
    }),
    "no response event preserves normal empty-final handling",
  );
  assert(
    shouldDeferFinalForSubagentResponse({
      candidateWasBuffered: true,
      injectedResponseCount: 0,
      requiredJoinPending: true,
    }),
    "a required active task prevents finalization without being interrupted",
  );

  console.log("subagent-finalization tests passed");
}

main();
