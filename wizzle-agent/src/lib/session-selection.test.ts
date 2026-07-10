import {
  pickLatestSessionId,
  resolveHydratedSessionSelection,
} from "./session-selection.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(pickLatestSessionId([]) === null, "empty");
  assert(
    pickLatestSessionId([
      { id: "a", updatedAtMs: 1 },
      { id: "b", updatedAtMs: 9 },
      { id: "c", updatedAtMs: 3 },
    ]) === "b",
    "latest by updatedAtMs",
  );

  assert(
    resolveHydratedSessionSelection({
      projectSessions: [{ id: "s1", updatedAtMs: 1 }],
      selectedSessionId: "s1",
    }) === "s1",
    "keep valid selection",
  );

  assert(
    resolveHydratedSessionSelection({
      draftSessionId: "draft-1",
      projectSessions: [{ id: "s1", updatedAtMs: 5 }],
      selectedSessionId: null,
    }) === "draft-1",
    "draft wins over half-null when present",
  );

  assert(
    resolveHydratedSessionSelection({
      projectSessions: [
        { id: "old", updatedAtMs: 1 },
        { id: "new", updatedAtMs: 10 },
      ],
      selectedSessionId: null,
    }) === "new",
    "half-null falls back to latest session",
  );

  assert(
    resolveHydratedSessionSelection({
      projectSessions: [{ id: "s1", updatedAtMs: 1 }],
      selectedSessionId: "missing",
    }) === "s1",
    "stale selection falls back to latest",
  );

  assert(
    resolveHydratedSessionSelection({
      projectSessions: [],
      selectedSessionId: null,
    }) === null,
    "no sessions stays null",
  );

  console.log("session-selection tests passed");
}

main();
