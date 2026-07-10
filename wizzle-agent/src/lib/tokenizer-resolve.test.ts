import { resolveEffectiveTokenizer } from "./tokenizer-resolve.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const modelWins = resolveEffectiveTokenizer(
    {
      tokenizerJson: "https://example.com/model.json",
      tokenizerKind: null,
      tokenizerLocalPath: "/tmp/model.json",
    },
    {
      tokenizerJson: "https://example.com/provider.json",
      tokenizerLocalPath: "/tmp/provider.json",
    },
  );
  assert(modelWins.source === "https://example.com/model.json", "model source wins");
  assert(modelWins.localPath === "/tmp/model.json", "model local path");
  assert(modelWins.kind === "hf-json", "kind becomes hf-json");

  const providerFallback = resolveEffectiveTokenizer(
    { tokenizerJson: null, tokenizerKind: null, tokenizerLocalPath: null },
    {
      tokenizerJson: "/data/provider.json",
      tokenizerLocalPath: "/home/.wizzle/tokenizers/p/provider.json",
    },
  );
  assert(providerFallback.source === "/data/provider.json", "provider source");
  assert(
    providerFallback.localPath === "/home/.wizzle/tokenizers/p/provider.json",
    "provider local path",
  );

  const heuristic = resolveEffectiveTokenizer(
    { tokenizerJson: null, tokenizerKind: null, tokenizerLocalPath: null },
    { tokenizerJson: null, tokenizerLocalPath: null },
  );
  assert(heuristic.source === null, "no source");
  assert(heuristic.localPath === null, "no local path");
  assert(heuristic.kind === null, "heuristic kind");

  console.log("tokenizer-resolve tests passed");
}

main();
