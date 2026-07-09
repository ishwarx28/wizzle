(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {
  WIZZLE_FRONTEND_LOG_MODE: "off",
};

export {};

const {
  applyComposerQueueSendResult,
  createComposerQueueItem,
  markComposerQueueItemStatus,
  rekeyComposerSessionQueue,
  removeComposerQueueItem,
  resetComposerSessionQueuesForTests,
  selectNextQueuedComposerItem,
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

  console.log("composer-session-queue tests passed");
}

main();
