import { TodoEngine } from "./engine.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main() {
  const engine = new TodoEngine();
  const created = engine.run({
    action: "create",
    items: ["Build the notes UI"],
    type: "creating_project",
  });
  assert(created.addedItems?.length, "known task types add recommended library items");
  assert(created.items[0]?.status === "in_progress", "the first item starts automatically");
  assert(engine.hasIncompleteItems(), "an unfinished list blocks completion");
  assert(engine.getContinuationInstruction()?.includes(created.items[0]!.id), "continuation names the active item");

  let orderingFailed = false;
  try {
    engine.run({ action: "update", itemId: created.items[1]!.id, status: "completed" });
  } catch {
    orderingFailed = true;
  }
  assert(orderingFailed, "later items cannot skip unfinished earlier work");

  let result = created;
  for (const item of created.items) {
    result = engine.run({ action: "update", itemId: item.id, status: "completed" });
  }
  assert(!engine.hasIncompleteItems(), "all terminal items release final-answer enforcement");
  assert(!result.currentItem, "completed lists have no active item");
  assert(engine.run({ action: "clear" }).items.length === 0, "completed lists can be cleared");

  console.log("TODO engine tests passed");
}

main();
