import { createCounterFromTokenizerJson } from "./tokenizer-runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const count = createCounterFromTokenizerJson({
    model: {
      type: "BPE",
      vocab: {
        a: 0,
        b: 1,
        ab: 2,
      },
      merges: ["a b"],
    },
  });

  const tokens = count("ab");
  assert(tokens >= 1, "counts at least one token");
  assert(tokens <= 3, "does not explode token count");

  const heuristic = createCounterFromTokenizerJson({
    version: "1.0",
    model: { type: "Unigram" },
  });
  const text = "hello world";
  assert(heuristic(text) === Math.ceil(text.length / 3.5), "heuristic fallback when no BPE");

  console.log("tokenizer-runtime tests passed");
}

main();
