(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {};

export {};

const { createTestRemoteConfig } = await import("../remote-config.test-fixture.ts");
const { getRemotePrompt, installRemoteConfigForTests } = await import("../remote-config.ts");
installRemoteConfigForTests(createTestRemoteConfig());

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(getRemotePrompt("system").includes("Broad codebase discovery requires Explorer"), "main policy is remote");
assert(getRemotePrompt("explorer").includes("strictly read-only"), "Explorer policy is remote");
assert(getRemotePrompt("reviewer").includes("strictly read-only"), "Reviewer policy is remote");
assert(getRemotePrompt("worker").includes("only files necessary"), "Worker policy is remote");

console.log("subagent-policy tests passed");
