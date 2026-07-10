import type { ProviderInfo, ProviderModelInfo } from "../types/workspace";

export type ResolvedTokenizer = {
  /** model → provider → null (heuristic) */
  kind: string | null;
  /** Cached local path when a tokenizer.json is ready */
  localPath: string | null;
  /** Configured path/URL source */
  source: string | null;
};

/**
 * Effective tokenizer for a model:
 * model tokenizer.json → provider tokenizer.json → heuristic.
 */
export function resolveEffectiveTokenizer(
  model: Pick<
    ProviderModelInfo,
    "tokenizerJson" | "tokenizerKind" | "tokenizerLocalPath"
  > | null | undefined,
  provider?: Pick<ProviderInfo, "tokenizerJson" | "tokenizerLocalPath"> | null,
): ResolvedTokenizer {
  const modelSource = model?.tokenizerJson?.trim() || null;
  const providerSource = provider?.tokenizerJson?.trim() || null;
  const source = modelSource ?? providerSource;

  const modelLocal = model?.tokenizerLocalPath?.trim() || null;
  const providerLocal = provider?.tokenizerLocalPath?.trim() || null;
  // Prefer the level that supplied the source; fall back to whichever local file exists.
  const localPath = modelSource
    ? modelLocal ?? null
    : providerSource
      ? providerLocal ?? null
      : modelLocal ?? providerLocal ?? null;

  const kind =
    model?.tokenizerKind?.trim() ||
    (localPath || source ? "hf-json" : null);

  return {
    kind,
    localPath,
    source,
  };
}
