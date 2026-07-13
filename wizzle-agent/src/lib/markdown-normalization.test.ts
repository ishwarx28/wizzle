import { normalizeNestedCodeFences } from "./markdown-normalization.ts";

function assertEqual(actual: string, expected: string, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
}

function testNestedMarkdownFence() {
  const input = [
    "```markdown",
    "```ts",
    "const ready = true;",
    "```",
    "```",
  ].join("\n");

  assertEqual(
    normalizeNestedCodeFences(input),
    [
      "````markdown",
      "```ts",
      "const ready = true;",
      "```",
      "````",
    ].join("\n"),
    "lengthens a markdown fence around an inner code block",
  );
}

function testLabelledAndUnlabelledNestedFences() {
  const input = [
    "```markdown",
    "# Softmax Function",
    "",
    "## Formula",
    "```",
    "softmax(x_i) = exp(x_i) / sum(exp(x_j))",
    "```",
    "",
    "## Python Implementation",
    "```python",
    "import numpy as np",
    "```",
    "",
    "## How It Works",
    "1. Exponentiate the values.",
    "```",
  ].join("\n");

  assertEqual(
    normalizeNestedCodeFences(input),
    [
      "````markdown",
      "# Softmax Function",
      "",
      "## Formula",
      "```",
      "softmax(x_i) = exp(x_i) / sum(exp(x_j))",
      "```",
      "",
      "## Python Implementation",
      "```python",
      "import numpy as np",
      "```",
      "",
      "## How It Works",
      "1. Exponentiate the values.",
      "````",
    ].join("\n"),
    "keeps labelled and unlabelled inner blocks inside one markdown fence",
  );
}

function testAdjacentCodeBlocks() {
  const input = ["```ts", "const first = 1;", "```", "```ts", "const second = 2;", "```"].join("\n");

  assertEqual(normalizeNestedCodeFences(input), input, "leaves adjacent code blocks unchanged");
}

function testTildeFences() {
  const input = ["~~~text", "~~~css", ".card {}", "~~~", "~~~"].join("\r\n");

  assertEqual(
    normalizeNestedCodeFences(input),
    ["~~~~text", "~~~css", ".card {}", "~~~", "~~~~"].join("\r\n"),
    "supports nested tilde fences and preserves CRLF",
  );
}

function testSourceLanguageFence() {
  const input = ["```ts", "const sample = ` ```js `;", "```"].join("\n");

  assertEqual(
    normalizeNestedCodeFences(input),
    input,
    "does not reinterpret source-language code fences",
  );
}

function testAdjacentMarkdownAndSourceBlocks() {
  const input = [
    "```markdown",
    "# Markdown sample",
    "```",
    "```ts",
    "const ready = true;",
    "```",
  ].join("\n");

  assertEqual(
    normalizeNestedCodeFences(input),
    input,
    "does not combine adjacent markdown and source blocks",
  );
}

testNestedMarkdownFence();
testLabelledAndUnlabelledNestedFences();
testAdjacentCodeBlocks();
testTildeFences();
testSourceLanguageFence();
testAdjacentMarkdownAndSourceBlocks();
console.log("markdown normalization tests passed");
