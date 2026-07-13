export type TodoItemStatus = "cancelled" | "completed" | "in_progress" | "pending";

export type TodoItem = {
  addedByTemplate: boolean;
  id: string;
  status: TodoItemStatus;
  title: string;
};

export type TodoState = {
  createdAtMs: number;
  items: TodoItem[];
  type: string;
  updatedAtMs: number;
  version: 1;
};

export type TodoToolInput = {
  action?: "add" | "clear" | "create" | "status" | "update";
  item?: string;
  itemId?: string;
  items?: string[];
  status?: TodoItemStatus;
  type?: string;
};

export type TodoToolResult = {
  addedItems?: string[];
  currentItem?: TodoItem;
  items: TodoItem[];
  note?: string;
  ok: boolean;
  type?: string;
};
