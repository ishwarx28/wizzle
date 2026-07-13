import { resolveNativeCloseAction } from "./app-window-events.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  resolveNativeCloseAction(true) === "close_subagent_view",
  "native close closes an open subagent view",
);
assert(
  resolveNativeCloseAction(false) === "confirm_app_exit",
  "native close requests confirmation for the main window",
);

console.log("app-window-events tests passed");
