(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {
  WIZZLE_FRONTEND_LOG_MODE: "off",
};

export {};

const {
  applyComposerQueueSendResult,
  cancelQueuedContextContinues,
  createComposerQueueItem,
  enqueueContextContinue,
  markComposerQueueItemStatus,
  rekeyComposerSessionQueue,
  removeComposerQueueItem,
  resetComposerSessionQueuesForTests,
  selectNextQueuedComposerItem,
  selectVisibleComposerQueueItems,
  setComposerSessionQueue,
  getComposerSessionQueue,
} = await import("./composer-session-queue.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  resetComposerSessionQueuesForTests();

  const a = createComposerQueueItem({ attachments: [], prompt: "first" });
  const b = createComposerQueueItem({ attachments: [], prompt: "second" });
  assert(a.status === "queued" && b.id !== a.id, "create items");

  assert(selectNextQueuedComposerItem([a, b])?.id === a.id, "select first queued");
  const withSending = markComposerQueueItemStatus([a, b], a.id, "sending");
  assert(selectNextQueuedComposerItem(withSending)?.id === b.id, "skip sending");
  assert(
    selectVisibleComposerQueueItems(withSending).map((item) => item.id).join(",") === b.id,
    "sending item is hidden after its user message is represented in chat",
  );
  assert(
    selectVisibleComposerQueueItems([{ ...a, status: "failed" }, b]).length === 2,
    "queued and failed items remain visible",
  );

  assert(
    applyComposerQueueSendResult([a, b], a.id, { accepted: true, ok: true }).length === 1,
    "accepted removes",
  );
  assert(
    applyComposerQueueSendResult([a], a.id, {
      accepted: false,
      ok: false,
      retryable: true,
    })[0]?.status === "queued",
    "retryable requeues",
  );
  assert(
    applyComposerQueueSendResult([a], a.id, { accepted: false, ok: false, error: "x" })[0]
      ?.status === "failed",
    "hard fail",
  );

  setComposerSessionQueue("s1", [a]);
  assert(getComposerSessionQueue("s1").length === 1, "module get/set");
  assert(removeComposerQueueItem([a, b], a.id)[0]?.id === b.id, "remove");

  // useSyncExternalStore requires a stable empty snapshot (React error #185).
  const emptyA = getComposerSessionQueue("missing-session");
  const emptyB = getComposerSessionQueue("missing-session");
  assert(emptyA === emptyB, "empty queue snapshot is referentially stable");
  assert(emptyA.length === 0, "empty queue length");
  setComposerSessionQueue("s1", []);
  const clearedA = getComposerSessionQueue("s1");
  const clearedB = getComposerSessionQueue("s1");
  assert(clearedA === clearedB && clearedA.length === 0, "cleared queue is stable empty");

  resetComposerSessionQueuesForTests();
  const draftA = createComposerQueueItem({ attachments: [], prompt: "queued on draft" });
  const draftB = createComposerQueueItem({ attachments: [], prompt: "sending on draft" });
  setComposerSessionQueue("draft-project", [
    draftA,
    { ...draftB, status: "sending" },
  ]);
  const rekeyed = rekeyComposerSessionQueue("draft-project", "session-real");
  assert(rekeyed.length === 2, "rekey moves both items");
  assert(getComposerSessionQueue("draft-project").length === 0, "draft queue cleared");
  assert(getComposerSessionQueue("session-real").length === 2, "real session has queue");
  assert(
    getComposerSessionQueue("session-real").every((item) => item.status === "queued"),
    "sending becomes queued after promote rekey",
  );

  resetComposerSessionQueuesForTests();
  const userFirst = createComposerQueueItem({ attachments: [], prompt: "user later" });
  setComposerSessionQueue("s-continue", [userFirst]);
  const cont = enqueueContextContinue("s-continue", "Continue previous task");
  assert(cont.kind === "context_continue", "continue kind");
  const next = selectNextQueuedComposerItem(getComposerSessionQueue("s-continue"));
  assert(next?.id === cont.id, "continue selected ahead of user queue");
  assert(getComposerSessionQueue("s-continue")[0]?.id === cont.id, "continue at front");
  assert(cont.attachments.length === 0, "continue never carries attachments");
  assert(cont.prompt === "Continue previous task", "continue prompt is not modified");

  enqueueContextContinue("s-continue", "Continue previous task again");
  assert(
    getComposerSessionQueue("s-continue").filter((item) => item.kind === "context_continue")
      .length === 1,
    "only one queued continue",
  );

  cancelQueuedContextContinues("s-continue");
  assert(
    getComposerSessionQueue("s-continue").every((item) => item.kind !== "context_continue"),
    "cancel removes queued continues",
  );
  assert(
    getComposerSessionQueue("s-continue").some((item) => item.prompt === "user later"),
    "user queue kept after cancel continue",
  );

  console.log("composer-session-queue tests passed");
}

main();
