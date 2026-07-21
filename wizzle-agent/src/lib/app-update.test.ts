import { compareSemanticVersions, resolveAvailableAppUpdate } from "./app-update.ts";
import type { RemoteUpdate } from "../types/remote-config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const update: RemoteUpdate = {
  enabled: true,
  note: "Release",
  platform: "macos",
  status: "normal",
  url: "https://example.test/macos.json",
  version: "2.0.0",
};

assert(compareSemanticVersions("1.9.9", "2.0.0") === -1, "new major version");
assert(compareSemanticVersions("2.0.0", "2.0.0") === 0, "equal version");
assert(compareSemanticVersions("2.1.0", "2.0.0") === 1, "older remote version");
assert(resolveAvailableAppUpdate(update, "1.0.0")?.version === "2.0.0", "update available");
assert(resolveAvailableAppUpdate(update, "2.0.0") === null, "current version is current");
assert(
  resolveAvailableAppUpdate({ ...update, enabled: false }, "1.0.0") === null,
  "disabled update is unavailable",
);
assert(
  compareSemanticVersions("2.0.0-beta.2", "2.0.0-beta.10") === -1,
  "numeric prerelease order",
);
assert(compareSemanticVersions("2.0.0-rc.1", "2.0.0") === -1, "release after prerelease");
assert(compareSemanticVersions("2.0.0+one", "2.0.0+two") === 0, "build ignored");
assert(compareSemanticVersions("1.0", "2.0.0") === null, "malformed version rejected");

console.log("app update tests passed");
