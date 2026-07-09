import {
  describeSettledTurnPersistResult,
  isTurnAlreadyFinalizedError,
  runSettledTurnPersistence,
} from "./settle-turn-persist.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function testFinalizeRunsEvenWhenMessagesFail() {
  const calls: string[] = [];

  const result = await runSettledTurnPersistence({
    messageIds: ["m1", "m2"],
    persistMessage: async (id) => {
      calls.push(`msg:${id}`);
      if (id === "m1") {
        throw new Error("disk full");
      }
    },
    persistSummary: async () => {
      calls.push("summary");
      throw new Error("summary failed");
    },
    finalize: async () => {
      calls.push("finalize");
    },
  });

  assert(calls.includes("finalize"), "finalize must run after message failures");
  assert(calls.indexOf("finalize") > calls.indexOf("msg:m1"), "finalize after messages");
  assert(result.messageErrors.length === 1, "collect message error");
  assert(result.summaryError?.includes("summary failed") ?? false, "collect summary error");
  assert(result.finalizeError === null, "finalize success");
}

async function testFinalizeErrorSurfaced() {
  const result = await runSettledTurnPersistence({
    messageIds: [],
    persistMessage: async () => undefined,
    finalize: async () => {
      throw new Error("Could not finalize turn turn-1.");
    },
  });

  assert(result.finalizeError?.includes("Could not finalize") ?? false, "finalize error kept");
  const description = describeSettledTurnPersistResult(result);
  assert(description?.includes("could not close the turn") ?? false, "user-facing finalize text");
}

async function testAlreadyFinalizedIsSoftForMessages() {
  const result = await runSettledTurnPersistence({
    messageIds: ["m1"],
    persistMessage: async () => {
      throw new Error("That turn is already finalized and cannot be updated.");
    },
    finalize: async () => undefined,
  });

  assert(result.messageErrors.length === 0, "finalized race is not a message error");
  assert(result.finalizeError === null, "finalize ok");
  assert(
    isTurnAlreadyFinalizedError(
      new Error("That turn is already finalized and cannot be updated."),
    ),
    "detector matches rust wording",
  );
}

async function main() {
  await testFinalizeRunsEvenWhenMessagesFail();
  await testFinalizeErrorSurfaced();
  await testAlreadyFinalizedIsSoftForMessages();
  console.log("settle-turn-persist tests passed");
}

main().catch((error) => {
  console.error(error);
  throw error;
});
