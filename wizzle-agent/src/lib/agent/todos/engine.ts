import { enrichTodoItems } from "./templates";
import type { TodoItem, TodoItemStatus, TodoState, TodoToolInput, TodoToolResult } from "./types";

function text(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} requires meaningful text.`);
  return value.trim();
}

function clone(state: TodoState): TodoState {
  return JSON.parse(JSON.stringify(state)) as TodoState;
}

function currentItem(state: TodoState | null) {
  return state?.items.find((item) => item.status === "in_progress");
}

function isTerminal(status: TodoItemStatus) {
  return status === "completed" || status === "cancelled";
}

function ensureActiveItem(state: TodoState) {
  if (currentItem(state)) return;
  const next = state.items.find((item) => item.status === "pending");
  if (next) next.status = "in_progress";
}

export class TodoEngine {
  private state: TodoState | null;

  constructor(state?: TodoState | null) {
    this.state = state ? clone(state) : null;
    if (this.state) ensureActiveItem(this.state);
  }

  run(input: TodoToolInput): TodoToolResult {
    switch (input.action) {
      case "create": return this.create(input.type, input.items);
      case "add": return this.add(input.item);
      case "update": return this.update(input.itemId, input.status);
      case "status": return this.result();
      case "clear": return this.clear();
      default: throw new Error("TODO action must be create, add, update, status, or clear.");
    }
  }

  hasIncompleteItems() {
    return Boolean(this.state?.items.some((item) => !isTerminal(item.status)));
  }

  getContinuationInstruction() {
    const item = currentItem(this.state);
    return item
      ? `Session TODO is unfinished. Continue working on item ${item.id}: ${item.title}. Do not give a final answer until every item is completed or legitimately cancelled.`
      : null;
  }

  getSnapshot() {
    return this.state ? clone(this.state) : null;
  }

  private create(rawType: unknown, rawItems: unknown) {
    if (this.hasIncompleteItems()) throw new Error("Complete or cancel the existing session TODO before creating another one.");
    const type = text(rawType, "TODO type").toLowerCase();
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 30) {
      throw new Error("TODO create requires one to thirty initial items.");
    }
    const requestedItems = rawItems.map((item, index) => text(item, `TODO item ${index + 1}`));
    const enriched = enrichTodoItems(type, requestedItems);
    const addedSet = new Set(enriched.added);
    const now = Date.now();
    this.state = {
      createdAtMs: now,
      items: enriched.items.map((title, index): TodoItem => ({
        addedByTemplate: addedSet.has(title),
        id: `todo-${crypto.randomUUID()}`,
        status: index === 0 ? "in_progress" : "pending",
        title,
      })),
      type: enriched.type,
      updatedAtMs: now,
      version: 1,
    };
    return this.result(enriched.added);
  }

  private add(rawItem: unknown) {
    const state = this.requireState();
    const title = text(rawItem, "TODO item");
    const verificationIndex = state.items.findIndex((item) => /\b(verify|verification|checks?|review)\b/i.test(item.title));
    const item: TodoItem = {
      addedByTemplate: false,
      id: `todo-${crypto.randomUUID()}`,
      status: "pending",
      title,
    };
    state.items.splice(verificationIndex >= 0 ? verificationIndex : state.items.length, 0, item);
    ensureActiveItem(state);
    state.updatedAtMs = Date.now();
    return this.result();
  }

  private update(rawItemId: unknown, rawStatus: unknown) {
    const state = this.requireState();
    const itemId = text(rawItemId, "TODO itemId");
    if (!["pending", "in_progress", "completed", "cancelled"].includes(String(rawStatus))) {
      throw new Error("TODO status must be pending, in_progress, completed, or cancelled.");
    }
    const status = rawStatus as TodoItemStatus;
    const index = state.items.findIndex((item) => item.id === itemId);
    if (index < 0) throw new Error("TODO itemId does not exist in this session list.");
    const item = state.items[index]!;
    const earlierIncomplete = state.items.slice(0, index).some((entry) => !isTerminal(entry.status));
    if ((status === "completed" || status === "in_progress") && earlierIncomplete) {
      throw new Error("Complete or cancel earlier TODO items first.");
    }
    if (status === "in_progress") {
      state.items.forEach((entry) => {
        if (entry.status === "in_progress") entry.status = "pending";
      });
    }
    item.status = status;
    if (isTerminal(status)) {
      const next = state.items.slice(index + 1).find((entry) => entry.status === "pending");
      if (next) next.status = "in_progress";
    }
    ensureActiveItem(state);
    state.updatedAtMs = Date.now();
    return this.result();
  }

  private clear() {
    const state = this.requireState();
    if (state.items.some((item) => !isTerminal(item.status))) {
      throw new Error("Complete or cancel every TODO item before clearing the session list.");
    }
    this.state = null;
    return { items: [], note: "Session TODO cleared.", ok: true };
  }

  private requireState() {
    if (!this.state) throw new Error("This session has no TODO list. Create one first.");
    return this.state;
  }

  private result(addedItems?: string[]): TodoToolResult {
    const state = this.state;
    if (!state) return { items: [], ok: true };
    return {
      addedItems: addedItems?.length ? addedItems : undefined,
      currentItem: currentItem(state),
      items: state.items.map((item) => ({ ...item })),
      note: addedItems?.length ? `Added ${addedItems.length} recommended ${addedItems.length === 1 ? "item" : "items"} for ${state.type}.` : undefined,
      ok: true,
      type: state.type,
    };
  }
}
