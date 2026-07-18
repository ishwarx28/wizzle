(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {};

const {
  clientEnv,
  resolveActiveTurnPressurePercent,
  resolveCompactionTriggerPercent,
  resolveContextSafetyPercent,
  resolvePostCompactionTargetPercent,
} = await import("./env.ts");

export {};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main() {
  assert(resolveContextSafetyPercent() === 5, "context safety defaults to 5%");
  assert(resolveCompactionTriggerPercent() === 80, "compaction high-water defaults to 80%");
  assert(resolvePostCompactionTargetPercent() === 60, "post-compaction target defaults to 60%");
  assert(resolveActiveTurnPressurePercent() === 90, "active-turn pressure defaults to 90%");

  const mutableEnv = clientEnv as unknown as Record<string, string | undefined>;
  mutableEnv.WIZZLE_COMPACTION_TRIGGER_PERCENT = "75";
  mutableEnv.WIZZLE_POST_COMPACTION_TARGET_PERCENT = "55";
  assert(resolveCompactionTriggerPercent() === 75, "compaction trigger is configurable");
  assert(resolvePostCompactionTargetPercent() === 55, "post-compaction target is configurable");

  console.log("environment config tests passed");
}

main();
