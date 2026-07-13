import {
  buildPreviewMarkdown,
  isAbsoluteNativePath,
  MAX_HIGHLIGHTED_PREVIEW_CHARACTERS,
  resolveFileOpenLabel,
  shouldHighlightPreview,
} from "./file-preview.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

assert(isAbsoluteNativePath("/Users/example/file.ts"), "POSIX absolute paths are accepted");
assert(isAbsoluteNativePath("C:\\Users\\example\\file.ts"), "Windows absolute paths are accepted");
assert(!isAbsoluteNativePath("../file.ts"), "relative paths are rejected");
assert(!isAbsoluteNativePath("https://example.com/file.ts"), "URLs are not native file paths");

const fenced = buildPreviewMarkdown("const ticks = ```;", "ts<script>");
assert(fenced.startsWith("````tsscript\n"), "code fences and language labels are escaped safely");
assert(fenced.endsWith("\n````"), "the preview uses a fence longer than embedded backticks");

assert(shouldHighlightPreview("small\nfile"), "small previews can be highlighted");
assert(
  !shouldHighlightPreview("a".repeat(MAX_HIGHLIGHTED_PREVIEW_CHARACTERS + 1)),
  "large previews skip syntax highlighting",
);
assert(
  resolveFileOpenLabel({ kind: "text", name: "index.html" }) === "Open in browser",
  "HTML files use the browser label",
);

console.log("file preview tests passed");
