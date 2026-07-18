import type {
  ModelReasoningConfig,
  ModelReasoningVariant,
  ReasoningReplayEntry,
  ReasoningSelection,
} from "../types/workspace";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const reasoningRecipeHashCache = new WeakMap<ModelReasoningConfig, string>();

export function modelReasoningVariants(
  reasoning?: ModelReasoningConfig | null,
): ModelReasoningVariant[] {
  return reasoning?.variants?.filter((variant) => variant.id.trim() && variant.label.trim()) ?? [];
}

export function isReasoningOffVariant(variant: ModelReasoningVariant) {
  const id = variant.id.trim().toLowerCase();
  const label = variant.label.trim().toLowerCase();
  return id === "off" || id === "none" || label === "off" || label === "none";
}

export function modelReasoningDropdownVariants(
  reasoning?: ModelReasoningConfig | null,
): ModelReasoningVariant[] {
  const defaultVariantId = reasoning?.defaultVariantId?.trim() ?? "";
  return modelReasoningVariants(reasoning)
    .map((variant, index) => ({
      index,
      rank: isReasoningOffVariant(variant)
        ? 0
        : variant.id === defaultVariantId || variant.id === "default"
          ? 1
          : 2,
      variant,
    }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ variant }) => variant);
}

export function reasoningVariantDisplayLabel(variant: ModelReasoningVariant) {
  if (isReasoningOffVariant(variant)) {
    return "Off";
  }
  return variant.id.trim().toLowerCase() === "default" ? "Default" : variant.label;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function reasoningRecipeHash(reasoning?: ModelReasoningConfig | null) {
  if (!reasoning) {
    return "";
  }
  const cached = reasoningRecipeHashCache.get(reasoning);
  if (cached) {
    return cached;
  }
  const serialized = canonicalJson(reasoning);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  const result = hash.toString(36);
  reasoningRecipeHashCache.set(reasoning, result);
  return result;
}

export function decodeReasoningSelection(value?: string | null): ReasoningSelection {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return { inputs: {}, variantId: "" };
  }
  if (!trimmed.startsWith("{")) {
    return { inputs: {}, variantId: trimmed };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed) || typeof parsed.variantId !== "string") {
      return { inputs: {}, variantId: "" };
    }
    const inputs = isRecord(parsed.inputs)
      ? Object.fromEntries(
          Object.entries(parsed.inputs).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === "number" && Number.isSafeInteger(entry[1]),
          ),
        )
      : {};
    return { inputs, variantId: parsed.variantId.trim() };
  } catch {
    return { inputs: {}, variantId: trimmed };
  }
}

export function encodeReasoningSelection(selection: ReasoningSelection) {
  const variantId = selection.variantId.trim();
  if (!variantId) {
    return "";
  }
  if (Object.keys(selection.inputs).length === 0) {
    return variantId;
  }
  return JSON.stringify({ inputs: selection.inputs, variantId });
}

export function normalizeReasoningSelection(
  storedValue: string | null | undefined,
  reasoning?: ModelReasoningConfig | null,
) {
  const variants = modelReasoningVariants(reasoning);
  if (variants.length === 0) {
    return { inputs: {}, variantId: "" } satisfies ReasoningSelection;
  }
  const decoded = decodeReasoningSelection(storedValue);
  const variant =
    variants.find((entry) => entry.id === decoded.variantId) ??
    variants.find((entry) => entry.id === reasoning?.defaultVariantId) ??
    variants[0]!;
  const inputs = Object.fromEntries(
    variant.inputs.flatMap((input) => {
      const storedValue = decoded.inputs[input.id];
      const storedValueIsValid =
        typeof storedValue === "number" &&
        (input.min == null || storedValue >= input.min) &&
        (input.max == null || storedValue <= input.max);
      const value = storedValueIsValid ? storedValue : input.default;
      return [[input.id, value] as const];
    }),
  );
  return { inputs, variantId: variant.id } satisfies ReasoningSelection;
}

/** First declared variant is the model-owned default for detached helper calls. */
export function automaticReasoningSelection(reasoning?: ModelReasoningConfig | null) {
  const selection = normalizeReasoningSelection(null, reasoning);
  const variant = modelReasoningVariants(reasoning).find(
    (entry) => entry.id === selection.variantId,
  );
  if (!variant) {
    return undefined;
  }
  return variant.inputs.every((input) => selection.inputs[input.id] != null)
    ? selection
    : undefined;
}

function mergeReplayValue(existing: unknown, incoming: unknown): unknown {
  if (typeof existing === "string" && typeof incoming === "string") {
    return `${existing}${incoming}`;
  }
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return [...existing, ...incoming];
  }
  if (isRecord(existing) && isRecord(incoming)) {
    const result: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      result[key] = key in result ? mergeReplayValue(result[key], value) : value;
    }
    return result;
  }
  return incoming;
}

function replaySequence(value: unknown) {
  return Array.isArray(value) ? value : [value];
}

function appendReplayValue(existing: unknown, incoming: unknown) {
  return typeof existing === "string" && typeof incoming === "string"
    ? `${existing}${incoming}`
    : [...replaySequence(existing), ...replaySequence(incoming)];
}

function prependReplayValue(existing: unknown, incoming: unknown) {
  return typeof existing === "string" && typeof incoming === "string"
    ? `${incoming}${existing}`
    : [...replaySequence(incoming), ...replaySequence(existing)];
}

export function mergeReasoningReplayEntry(
  entries: ReasoningReplayEntry[],
  incoming: ReasoningReplayEntry,
) {
  if (incoming.value == null) {
    return entries;
  }
  const index = entries.findIndex(
    (entry) =>
      entry.assistantMessagePath === incoming.assistantMessagePath &&
      entry.operation === incoming.operation,
  );
  if (index < 0) {
    return [...entries, incoming];
  }
  return entries.map((entry, entryIndex) =>
    entryIndex === index
      ? {
          ...entry,
          ...incoming,
          value:
            incoming.operation === "set"
              ? incoming.value
              : incoming.operation === "append"
                ? appendReplayValue(entry.value, incoming.value)
                : incoming.operation === "prepend"
                  ? prependReplayValue(entry.value, incoming.value)
                  : mergeReplayValue(entry.value, incoming.value),
        }
      : entry,
  );
}

export function attachReasoningReplaySource(options: {
  entries: ReasoningReplayEntry[];
  modelId: string;
  reasoning?: ModelReasoningConfig | null;
}) {
  const sourceRecipeHash = reasoningRecipeHash(options.reasoning);
  return options.entries.map((entry) => ({
    ...entry,
    sourceModelId: options.modelId,
    sourceRecipeHash,
  }));
}

export function reasoningReplayForModel(options: {
  entries?: ReasoningReplayEntry[];
  modelId?: string;
  reasoning?: ModelReasoningConfig | null;
}) {
  if (!options.modelId || !options.reasoning?.replay) {
    return [];
  }
  const recipeHash = reasoningRecipeHash(options.reasoning);
  return (options.entries ?? []).filter(
    (entry) =>
      entry.sourceModelId === options.modelId && entry.sourceRecipeHash === recipeHash,
  );
}

export function shouldReplayReasoning(options: {
  currentTurnId?: string;
  hasToolCalls: boolean;
  messageTurnId?: string;
  reasoning?: ModelReasoningConfig | null;
}) {
  const scope = options.reasoning?.replay?.scope;
  switch (scope) {
    case "active_tool_loop":
      return options.hasToolCalls && options.messageTurnId === options.currentTurnId;
    case "tool_call_turns":
      return options.hasToolCalls;
    case "all_turns":
      return true;
    case "server_managed":
    default:
      return false;
  }
}
