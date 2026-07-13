import { resolveExternalWebUrl } from "./external-url";

export const clientEnv = __WIZZLE_ENV__;

const DEFAULT_MAX_PROMPT_SIZE = 20_480;
const DEFAULT_COMPACTED_CONTEXT_TOKENS = 5_120;
const DEFAULT_OUTPUT_RESERVED_PERCENT = 10;
const DEFAULT_HEALTHY_CONTEXT_PERCENT = 30;

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
  return resolvePercentEnv(
    clientEnv.WIZZLE_HEALTHY_CONTEXT_PERCENT,
    DEFAULT_HEALTHY_CONTEXT_PERCENT,
  );
}

function resolveContactEmail(value: string | undefined) {
  const email = value?.trim() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

export function resolveAboutConfig(env: WizzleClientEnv = clientEnv) {
  return {
    email: resolveContactEmail(env.WIZZLE_CONTACT_EMAIL),
    githubUrl: resolveExternalWebUrl(env.WIZZLE_CONTACT_GITHUB_URL?.trim() ?? ""),
    linkedinUrl: resolveExternalWebUrl(env.WIZZLE_CONTACT_LINKEDIN_URL?.trim() ?? ""),
    name: env.WIZZLE_CONTACT_NAME?.trim() || "Wizzle",
    version: env.WIZZLE_APP_VERSION?.trim() || "Unknown",
  };
}
