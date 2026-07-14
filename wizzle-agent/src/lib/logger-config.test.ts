import { parseFrontendLogMode } from "./logger-config.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(parseFrontendLogMode(undefined) === "debug", "missing mode defaults to debug");
  assert(parseFrontendLogMode(" INFO ") === "info", "configured mode is normalized");
  assert(parseFrontendLogMode("invalid") === "debug", "invalid mode defaults to debug");
  console.log("logger config tests passed");
}

main();
