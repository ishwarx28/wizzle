import {
  isDataUrlImageSrc,
  sanitizeToolResultContentForStorage,
  shouldOmitImageSrcFromStorage,
} from "./tool-result-storage.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const dataUrl = `data:image/png;base64,${"A".repeat(200)}`;
  assert(isDataUrlImageSrc(dataUrl), "data url detected");
  assert(shouldOmitImageSrcFromStorage(dataUrl), "omit data url imageSrc");
  assert(!shouldOmitImageSrcFromStorage("https://example.com/x.png"), "keep non-data urls");
  assert(!shouldOmitImageSrcFromStorage(""), "empty not omitted as image");

  const stored = sanitizeToolResultContentForStorage(
    JSON.stringify({
      ok: true,
      binary: true,
      path: "/tmp/shot.png",
      mimeType: "image/png",
      contentHash: "abc",
      bytes: 1024,
      imageSrc: dataUrl,
      content: null,
    }),
    { toolName: "read" },
  );
  const parsed = JSON.parse(stored) as Record<string, unknown>;
  assert(parsed.imageSrc === undefined, "imageSrc removed from storage");
  assert(parsed.imageSrcOmitted === true, "omitted flag");
  assert(parsed.path === "/tmp/shot.png", "path kept");
  assert(parsed.contentHash === "abc", "hash kept");

  const textRead = sanitizeToolResultContentForStorage(
    JSON.stringify({
      ok: true,
      path: "/tmp/a.txt",
      content: "hello world",
    }),
    { toolName: "read" },
  );
  assert(JSON.parse(textRead).content === "hello world", "small text kept");
  assert(JSON.parse(textRead).imageSrcOmitted === undefined, "no omit on text");

  const verifiedMutation = sanitizeToolResultContentForStorage(
    JSON.stringify({
      ok: true,
      path: "/project/main.py",
      verification: {
        status: "failed",
        newDiagnosticCount: 1,
        diagnostics: [{ source: "pyright", message: "Unknown name" }],
      },
    }),
    { toolName: "write" },
  );
  assert(
    JSON.parse(verifiedMutation).verification?.newDiagnosticCount === 1,
    "automatic verification survives durable tool-result storage",
  );

  console.log("tool-result-storage tests passed");
}

main();
