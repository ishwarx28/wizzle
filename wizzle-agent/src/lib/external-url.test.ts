import { resolveExternalWebUrl } from "./external-url.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main() {
  assert(
    resolveExternalWebUrl("https://example.com/docs") === "https://example.com/docs",
    "HTTPS links resolve for the system browser",
  );
  assert(
    resolveExternalWebUrl("http://localhost:3000/path") === "http://localhost:3000/path",
    "HTTP development links resolve for the system browser",
  );
  assert(resolveExternalWebUrl("/internal/path") === null, "relative app links remain internal");
  assert(resolveExternalWebUrl("javascript:alert(1)") === null, "unsafe URL schemes are rejected");
  console.log("external URL tests passed");
}

main();
