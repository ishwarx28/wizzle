import { findIncompleteToolCallIds } from "./tool-batch.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(
    findIncompleteToolCallIds([
      { id: "done", name: "read", status: "done" },
      { id: "failed", name: "shell", status: "error" },
      { id: "stopped", name: "write", status: "interrupted" },
    ]).length === 0,
    "terminal batch is complete",
  );
  assert(
    findIncompleteToolCallIds([
      { id: "done", name: "read", status: "done" },
      { id: "pending", name: "read", status: "pending" },
      { id: "running", name: "shell", status: "running" },
    ]).join(",") === "pending,running",
    "pending and running calls block context selection",
  );

  console.log("tool-batch tests passed");
}

main();
