import { buildActivitySegments, collectToolRuns, resolveClarifyToolPresentation } from "./tool-activity.ts";
import type { MessagePart } from "../types/workspace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function toolCall(id: string, parentPartId: string): MessagePart {
  return {
    id: `${parentPartId}-tool-call-${id}`,
    input: "{}",
    name: "read",
    parentPartId,
    status: "done",
    toolCallId: id,
    type: "tool_call",
  };
}

function toolResult(id: string, parentPartId: string): MessagePart {
  return {
    id: `message-tool-${id}-result`,
    output: "{}",
    parentPartId,
    status: "done",
    toolCallId: id,
    type: "tool_result",
  };
}

function main() {
  const splitSegments = buildActivitySegments([
    toolCall("call-1", "assistant-1"),
    toolResult("call-1", "assistant-1-tool-call-call-1"),
    toolCall("call-2", "assistant-2"),
    toolResult("call-2", "assistant-2-tool-call-call-2"),
  ]);

  assert(splitSegments.length === 2, "separate assistant tool batches split");
  assert(
    splitSegments.every((segment) => segment.type === "tool_group"),
    "both split segments are tool groups",
  );
  assert(
    splitSegments[0]?.type === "tool_group" &&
      splitSegments[0].runs.map((run) => run.id).join(",") === "call-1",
    "first split group has first call",
  );
  assert(
    splitSegments[1]?.type === "tool_group" &&
      splitSegments[1].runs.map((run) => run.id).join(",") === "call-2",
    "second split group has second call",
  );

  const monologueSegments = buildActivitySegments([
    toolCall("call-3", "assistant-3"),
    toolResult("call-3", "assistant-3-tool-call-call-3"),
    {
      content: "I found the config and will inspect the test next.",
      id: "assistant-4-activity",
      parentPartId: "assistant-4",
      status: "done",
      type: "activity_content",
    },
    toolCall("call-4", "assistant-4"),
  ]);

  assert(monologueSegments.length === 3, "monologue stays between tool groups");
  assert(monologueSegments[1]?.type === "part", "middle segment is activity content");
  assert(
    monologueSegments[1]?.type === "part" &&
      monologueSegments[1].part.content === "I found the config and will inspect the test next.",
    "activity content is preserved verbatim",
  );

  const subagentRuns = collectToolRuns([
    {
      id: "assistant-subagent-call",
      input: '{"action":"create","name":"explorer","prompt":"explore"}',
      name: "subagent",
      status: "done",
      toolCallId: "subagent-call",
      type: "tool_call",
    },
    {
      id: "assistant-subagent-result",
      output: '{"ok":true,"action":"create","name":"explorer","task":"explore","taskId":"subagent-123","status":"working"}',
      status: "done",
      toolCallId: "subagent-call",
      type: "tool_result",
    },
  ]);
  assert(subagentRuns[0]?.kind === "subagent", "subagent gets a dedicated UI kind");
  assert(subagentRuns[0]?.isExpandable, "subagent tool activity is expandable");
  assert(
    subagentRuns[0]?.detailLabel === "Created a subagent",
    "subagent create uses the required collapsed label",
  );

  const actionLabels = [
    ["interrupt", "Interrupted a subagent"],
    ["list", "Listed subagents"],
    ["wait", "Waiting for subagent"],
  ] as const;
  for (const [action, expectedLabel] of actionLabels) {
    const [run] = collectToolRuns([
      {
        id: `call-${action}`,
        input: JSON.stringify({ action, taskId: "subagent-123" }),
        name: "subagent",
        status: "done",
        toolCallId: `subagent-${action}`,
        type: "tool_call",
      },
      {
        id: `result-${action}`,
        output: JSON.stringify({ action, ok: true }),
        status: "done",
        toolCallId: `subagent-${action}`,
        type: "tool_result",
      },
    ]);
    assert(run?.detailLabel === expectedLabel, `${action} uses its required collapsed label`);
  }

  const backgroundActions = [
    [{ action: "run", background: true, command: "npm run dev" }, { background: true, process: { id: "process-1", pid: 123, status: "running" } }, "Started a background process"],
    [{ action: "list_processes" }, { processes: [{ id: "process-1", pid: 123, status: "running" }] }, "Checked background processes"],
    [{ action: "read_process", processId: "process-1" }, { process: { id: "process-1", pid: 123, status: "running" } }, "Checked a background process"],
    [{ action: "stop_process", processId: "process-1" }, { process: { id: "process-1", pid: 123, status: "interrupted" } }, "Stopped a background process"],
  ] as const;
  for (const [input, output, expectedLabel] of backgroundActions) {
    const [run] = collectToolRuns([
      {
        id: `bash-${input.action}-call`,
        input: JSON.stringify(input),
        name: "bash",
        status: "done",
        toolCallId: `bash-${input.action}`,
        type: "tool_call",
      },
      {
        id: `bash-${input.action}-result`,
        output: JSON.stringify({ ok: true, ...output }),
        status: "done",
        toolCallId: `bash-${input.action}`,
        type: "tool_result",
      },
    ]);
    assert(run?.detailLabel === expectedLabel, `${input.action} uses its background-process label`);
  }

  const [todoRun] = collectToolRuns([
    {
      id: "todo-call",
      input: JSON.stringify({
        action: "create",
        items: ["Implement notes"],
        type: "creating_project",
      }),
      name: "todo",
      status: "done",
      toolCallId: "todo-1",
      type: "tool_call",
    },
    {
      id: "todo-result",
      output: JSON.stringify({
        addedItems: ["Inspect the workspace"],
        currentItem: { id: "todo-a", status: "in_progress", title: "Inspect the workspace" },
        items: [
          { id: "todo-a", status: "in_progress", title: "Inspect the workspace" },
          { id: "todo-b", status: "pending", title: "Implement notes" },
        ],
        ok: true,
        type: "creating_project",
      }),
      status: "done",
      toolCallId: "todo-1",
      type: "tool_result",
    },
  ]);
  assert(todoRun?.kind === "todo", "TODO gets a dedicated compact UI kind");
  assert(todoRun?.isExpandable, "TODO details are available on demand");
  assert(todoRun?.detailLabel === "Created session TODO", "TODO create has a concise label");

  const [clearTodoRun] = collectToolRuns([
    {
      id: "todo-clear-call",
      input: JSON.stringify({ action: "clear" }),
      name: "todo",
      status: "done",
      toolCallId: "todo-clear",
      type: "tool_call",
    },
    {
      id: "todo-clear-result",
      output: JSON.stringify({ items: [], ok: true }),
      status: "done",
      toolCallId: "todo-clear",
      type: "tool_result",
    },
  ]);
  assert(!clearTodoRun?.isExpandable, "successful TODO clear stays collapsed");

  const [clarifyRun] = collectToolRuns([
    {
      id: "clarify-call",
      input: JSON.stringify({
        choices: ["React", "Vue"],
        kind: "approach",
        prompt: "Which framework should I use?",
        recommended: 0,
      }),
      name: "clarify",
      status: "done",
      toolCallId: "clarify-1",
      type: "tool_call",
    },
    {
      id: "clarify-result",
      output: JSON.stringify({ answer: "React", ok: true }),
      status: "done",
      toolCallId: "clarify-1",
      type: "tool_result",
    },
  ]);
  assert(clarifyRun?.kind === "clarify", "clarify gets a dedicated compact UI kind");
  assert(clarifyRun?.isExpandable, "clarification question and answer are available on demand");
  assert(clarifyRun?.detailLabel === "Chose an approach", "approach clarification has a concise label");

  const freeform = resolveClarifyToolPresentation({ answer: "SQLite", prompt: "Which database?" });
  assert(freeform.kind === "freeform" && freeform.answer === "SQLite", "freeform shows only its question and answer");
  const mixed = resolveClarifyToolPresentation({
    answer: "Svelte",
    choices: ["React", "Vue"],
    prompt: "Which framework?",
  });
  assert(
    mixed.kind === "choices" && mixed.choices.length === 3 && mixed.choices[2]?.isSelected,
    "mixed clarification appends and selects a custom answer",
  );

  console.log("tool-activity tests passed");
}

main();
