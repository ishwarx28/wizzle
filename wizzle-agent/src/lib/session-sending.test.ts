import {
  addSendingSessionId,
  removeSendingSessionId,
  resolveIsSendingMessage,
  shouldRestoreComposerDraft,
  shouldShowSessionInterrupt,
} from "./session-sending.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(!resolveIsSendingMessage(null, ["s1"]), "null selection not sending");
  assert(!resolveIsSendingMessage("s2", ["s1"]), "other session not sending");
  assert(resolveIsSendingMessage("s1", ["s1"]), "selected sending session");

  assert(
    shouldShowSessionInterrupt({
      hasDraftContent: false,
      selectedSessionId: "s1",
      sendingSessionIds: ["s1"],
    }),
    "interrupt when selected sending and empty draft",
  );
  assert(
    !shouldShowSessionInterrupt({
      hasDraftContent: true,
      selectedSessionId: "s1",
      sendingSessionIds: ["s1"],
    }),
    "no interrupt while draft remains",
  );
  assert(
    !shouldShowSessionInterrupt({
      hasDraftContent: false,
      selectedSessionId: "s2",
      sendingSessionIds: ["s1"],
    }),
    "no interrupt on idle selected session",
  );
  assert(
    !resolveIsSendingMessage("draft-1", ["session-busy"]),
    "new draft is idle while another session runs",
  );
  assert(
    !shouldShowSessionInterrupt({
      hasDraftContent: false,
      selectedSessionId: "draft-1",
      sendingSessionIds: ["session-busy"],
    }),
    "draft must not show stop for background session",
  );

  assert(shouldRestoreComposerDraft({ accepted: false }), "restore when not accepted");
  assert(!shouldRestoreComposerDraft({ accepted: true }), "do not restore after accept");

  const added = addSendingSessionId("s1", []);
  assert(added.includes("s1") && added.length === 1, "add session");
  assert(addSendingSessionId("s1", added).length === 1, "add is idempotent");
  assert(removeSendingSessionId("s1", added).length === 0, "remove session");

  console.log("session-sending tests passed");
}

main();
