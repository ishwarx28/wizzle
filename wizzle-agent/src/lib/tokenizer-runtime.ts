import { invoke } from "@tauri-apps/api/core";

type TokenCounter = (text: string) => number;

type ActiveTokenizer = {
  count: TokenCounter;
  path: string;
};

let active: ActiveTokenizer | null = null;
const loadingByPath = new Map<string, Promise<void>>();

/**
 * Best-effort BPE token counter from a HuggingFace tokenizer.json.
 * Uses vocab + merges when present; falls back to char heuristic with known-tokenizer flag.
 */
export function createCounterFromTokenizerJson(raw: unknown): TokenCounter {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const model =
    root && root.model && typeof root.model === "object"
      ? (root.model as Record<string, unknown>)
      : root;

  const vocabRaw = model?.vocab;
  const mergesRaw = model?.merges;

  if (!vocabRaw || typeof vocabRaw !== "object" || !Array.isArray(mergesRaw)) {
    return (text) => heuristicCount(text, true);
  }

  const vocab = vocabRaw as Record<string, number>;
  const mergeRanks = new Map<string, number>();

  for (let index = 0; index < mergesRaw.length; index += 1) {
    const entry = mergesRaw[index];
    if (typeof entry === "string") {
      mergeRanks.set(entry.replace(" ", ""), index);
      mergeRanks.set(entry, index);
    } else if (Array.isArray(entry) && entry.length >= 2) {
      const pair = `${String(entry[0])}${String(entry[1])}`;
      mergeRanks.set(pair, index);
      mergeRanks.set(`${String(entry[0])} ${String(entry[1])}`, index);
    }
  }

  return (text: string) => {
    if (!text) {
      return 0;
    }

    // Byte-level-ish: encode UTF-8 bytes as latin1 chars (common BBPE pattern).
    const bytes = new TextEncoder().encode(text);
    let symbols = Array.from(bytes, (byte) => String.fromCharCode(byte));

    if (symbols.length === 0) {
      return 0;
    }

    while (symbols.length > 1) {
      let bestRank = Number.POSITIVE_INFINITY;
      let bestIndex = -1;

      for (let index = 0; index < symbols.length - 1; index += 1) {
        const pair = symbols[index]! + symbols[index + 1]!;
        const spaced = `${symbols[index]} ${symbols[index + 1]}`;
        const rank = mergeRanks.get(pair) ?? mergeRanks.get(spaced);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIndex = index;
        }
      }

      if (bestIndex < 0) {
        break;
      }

      const merged = symbols[bestIndex]! + symbols[bestIndex + 1]!;
      symbols = [
        ...symbols.slice(0, bestIndex),
        merged,
        ...symbols.slice(bestIndex + 2),
      ];
    }

    let tokens = 0;
    for (const symbol of symbols) {
      if (Object.prototype.hasOwnProperty.call(vocab, symbol)) {
        tokens += 1;
      } else {
        // Unknown pieces: charge per byte/char so we stay conservative-ish.
        tokens += Math.max(1, symbol.length);
      }
    }

    return tokens;
  };
}

function heuristicCount(text: string, knownTokenizer: boolean) {
  if (!text) {
    return 0;
  }

  const base = Math.ceil(text.length / 3.5);
  return knownTokenizer ? base : Math.ceil(base * 1.15);
}

export function getActiveTokenizerPath() {
  return active?.path ?? null;
}

export function countWithActiveTokenizer(
  text: string,
  options: {
    tokenizerKind?: string | null;
    tokenizerLocalPath?: string | null;
  } = {},
) {
  // One active model selection: use its loaded HF tokenizer for all estimates.
  if (active) {
    return active.count(text);
  }

  const path = options.tokenizerLocalPath?.trim() || null;
  return heuristicCount(text, Boolean(options.tokenizerKind?.trim() || path));
}

export async function activateTokenizer(localPath: string | null | undefined) {
  const path = localPath?.trim() || null;

  if (!path) {
    active = null;
    return;
  }

  if (active?.path === path) {
    return;
  }

  const existing = loadingByPath.get(path);
  if (existing) {
    await existing;
    return;
  }

  const loadPromise = (async () => {
    const jsonText = await invoke<string>("read_tokenizer_asset", {
      input: { path },
    });
    const parsed = JSON.parse(jsonText) as unknown;
    const count = createCounterFromTokenizerJson(parsed);
    active = { path, count };
  })()
    .catch(() => {
      // Keep previous active tokenizer if reload fails; otherwise clear.
      if (active?.path === path) {
        active = null;
      }
    })
    .finally(() => {
      loadingByPath.delete(path);
    });

  loadingByPath.set(path, loadPromise);
  await loadPromise;
}
