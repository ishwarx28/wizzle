export const clientEnv = __WIZZLE_ENV__;

const DEFAULT_MAX_PROMPT_SIZE = 20_480;
const DEFAULT_COMPACTED_CONTEXT_TOKENS = 5_120;
const DEFAULT_OUTPUT_RESERVED_PERCENT = 10;
const DEFAULT_CONTEXT_SAFETY_PERCENT = 5;
const DEFAULT_COMPACTION_TRIGGER_PERCENT = 80;
const DEFAULT_POST_COMPACTION_TARGET_PERCENT = 60;
const DEFAULT_ACTIVE_TURN_PRESSURE_PERCENT = 90;

export function resolveMaxPromptSize() {
  const rawValue = clientEnv.WIZZLE_MAX_PROMPT_SIZE;

  if (!rawValue) {
    return DEFAULT_MAX_PROMPT_SIZE;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsedValue) || parsedValue < 1) {
    return DEFAULT_MAX_PROMPT_SIZE;
  }

  return parsedValue;
}

function resolvePositiveIntegerEnv(rawValue: string | undefined, fallback: number) {
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsedValue) || parsedValue < 1) {
    return fallback;
  }

  return parsedValue;
}

function resolvePercentEnv(rawValue: string | undefined, fallback: number) {
  const parsedValue = resolvePositiveIntegerEnv(rawValue, fallback);

  return Math.min(95, Math.max(1, parsedValue));
}

export function resolveCompactedContextTokens() {
  return resolvePositiveIntegerEnv(
    clientEnv.WIZZLE_COMPACTED_CONTEXT_TOKENS,
    DEFAULT_COMPACTED_CONTEXT_TOKENS,
  );
}

export function resolveOutputReservedPercent() {
  return resolvePercentEnv(
    clientEnv.WIZZLE_OUTPUT_RESERVED_PERCENT,
    DEFAULT_OUTPUT_RESERVED_PERCENT,
  );
}

export function resolveHealthyContextPercent() {
  return resolvePostCompactionTargetPercent();
}

export function resolveContextSafetyPercent() {
  return resolvePercentEnv(
    clientEnv.WIZZLE_CONTEXT_SAFETY_PERCENT,
    DEFAULT_CONTEXT_SAFETY_PERCENT,
  );
}

export function resolveCompactionTriggerPercent() {
  return resolvePercentEnv(
    clientEnv.WIZZLE_COMPACTION_TRIGGER_PERCENT,
    DEFAULT_COMPACTION_TRIGGER_PERCENT,
  );
}

export function resolvePostCompactionTargetPercent() {
  return resolvePercentEnv(
    clientEnv.WIZZLE_POST_COMPACTION_TARGET_PERCENT ??
      clientEnv.WIZZLE_HEALTHY_CONTEXT_PERCENT,
    DEFAULT_POST_COMPACTION_TARGET_PERCENT,
  );
}

export function resolveActiveTurnPressurePercent() {
  return resolvePercentEnv(
    clientEnv.WIZZLE_ACTIVE_TURN_PRESSURE_PERCENT,
    DEFAULT_ACTIVE_TURN_PRESSURE_PERCENT,
  );
}
