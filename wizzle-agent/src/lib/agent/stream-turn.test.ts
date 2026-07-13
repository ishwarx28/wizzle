(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {
  WIZZLE_FRONTEND_LOG_MODE: "off",
  WIZZLE_FRONTEND_LOG_RETENTION_DAYS: "7",
};

import type { OpenAIChatToolCall } from "../chat-stream.ts";

const {
  buildStreamingToolCallPreviews,
  mergeStreamedToolNameFragment,
  normalizeStreamedToolArguments,
  normalizeStreamedToolCalls,
  resolveAgentTurnToolChoice,
} = await import("./stream-turn.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function toolCall(partial: {
  arguments?: string;
  id?: string;
  name?: string;
}): OpenAIChatToolCall {
  return {
    function: {
      arguments: partial.arguments ?? "",
      name: partial.name ?? "",
    },
    id: partial.id ?? "",
    type: "function",
  };
}

function main() {
  assert(resolveAgentTurnToolChoice([]) === "none", "no definitions disables tools");
  assert(
    resolveAgentTurnToolChoice(
      [{ type: "function", function: { description: "x", name: "read", parameters: {} } }],
      "none",
    ) === "none",
    "definitions can remain declared while new calls are disabled",
  );

  // --- #22 name merge ---
  assert(mergeStreamedToolNameFragment("", "ba") === "ba", "empty + delta");
  assert(mergeStreamedToolNameFragment("ba", "sh") === "bash", "token deltas");
  assert(mergeStreamedToolNameFragment("ba", "bas") === "bas", "cumulative extend");
  assert(mergeStreamedToolNameFragment("bas", "bash") === "bash", "cumulative full");
  assert(mergeStreamedToolNameFragment("bash", "bash") === "bash", "full name repeat");
  assert(mergeStreamedToolNameFragment("bash", "bas") === "bash", "stale shorter prefix");
  // Blind += would produce "bashbash"
  let name = "";
  for (const delta of ["bash", "bash", "bash"]) {
    name = mergeStreamedToolNameFragment(name, delta);
  }
  assert(name === "bash", "repeated full name stays bash not bashbash");

  // --- #21 arguments ---
  assert(normalizeStreamedToolArguments("").arguments === "{}", "empty → {}");
  assert(normalizeStreamedToolArguments("   ").arguments === "{}", "whitespace → {}");
  assert(
    normalizeStreamedToolArguments('{"command":"ls"}').arguments === '{"command":"ls"}',
    "valid object kept",
  );
  assert(
    Boolean(normalizeStreamedToolArguments('{"command":').error),
    "truncated JSON is invalid",
  );
  assert(
    Boolean(normalizeStreamedToolArguments("not-json").error),
    "plain text is invalid",
  );
  assert(
    Boolean(normalizeStreamedToolArguments('"just-a-string"').error),
    "JSON string is not an object",
  );
  assert(
    !normalizeStreamedToolArguments("[]").error,
    "JSON array accepted as structured args",
  );

  // --- normalizeStreamedToolCalls ---
  const ready = normalizeStreamedToolCalls(
    [toolCall({ id: "c1", name: "bash", arguments: '{"command":"pwd"}' })],
    0,
  );
  assert(ready.items.length === 1 && ready.items[0]?.kind === "ready", "ready bash");
  assert(ready.hadToolCallIntents, "intent true");

  const emptyArgs = normalizeStreamedToolCalls(
    [toolCall({ id: "c2", name: "read", arguments: "" })],
    0,
  );
  assert(emptyArgs.items[0]?.kind === "ready", "empty args ready with {}");
  assert(
    emptyArgs.items[0]?.kind === "ready" &&
      emptyArgs.items[0].toolCall.function.arguments === "{}",
    "empty args become {}",
  );

  const subagent = normalizeStreamedToolCalls(
    [toolCall({ id: "sub-1", name: "subagent", arguments: '{"action":"list"}' })],
    0,
  );
  assert(subagent.items[0]?.kind === "ready", "subagent is a recognized agent tool");

  const todo = normalizeStreamedToolCalls(
    [toolCall({ id: "todo-1", name: "todo", arguments: '{"action":"status"}' })],
    0,
  );
  assert(todo.items[0]?.kind === "ready", "TODO is a recognized agent tool");

  const clarify = normalizeStreamedToolCalls(
    [toolCall({ id: "clarify-1", name: "clarify", arguments: '{"kind":"doubt","prompt":"Which target?"}' })],
    0,
  );
  assert(clarify.items[0]?.kind === "ready", "clarify is a recognized agent tool");

  const badJson = normalizeStreamedToolCalls(
    [toolCall({ id: "c3", name: "bash", arguments: '{"command":' })],
    0,
  );
  assert(badJson.items[0]?.kind === "invalid", "bad json invalid not ready");
  assert(
    badJson.items[0]?.kind === "invalid" &&
      badJson.items[0].toolCall.function.arguments.includes("{"),
    "raw args preserved on invalid",
  );

  const missingName = normalizeStreamedToolCalls(
    [toolCall({ id: "c4", name: "", arguments: "{}" })],
    0,
  );
  assert(missingName.hadToolCallIntents, "id-only is intent");
  assert(missingName.items[0]?.kind === "invalid", "missing name invalid");
  assert(missingName.items.length === 1, "not filtered away (#38)");

  const unknown = normalizeStreamedToolCalls(
    [toolCall({ id: "c5", name: "deploy", arguments: "{}" })],
    0,
  );
  assert(unknown.items[0]?.kind === "invalid", "unknown tool invalid");

  const noise = normalizeStreamedToolCalls([toolCall({})], 0);
  assert(!noise.hadToolCallIntents, "empty slot not intent");
  assert(noise.items.length === 0, "noise dropped");

  const previews = buildStreamingToolCallPreviews([
    toolCall({ id: "p1", name: "bash", arguments: '{"command":"' }),
    toolCall({ id: "p2", name: "", arguments: '{"path":"x"}' }),
    toolCall({ id: "", name: "read", arguments: '{"path":"x"}' }),
  ]);
  assert(previews.length === 1, "preview requires id and name");
  assert(previews[0]?.id === "p1", "preview keeps tool id");
  assert(previews[0]?.function.name === "bash", "preview keeps tool name");
  assert(previews[0]?.function.arguments === "", "preview buffers streamed arguments");

  const mixed = normalizeStreamedToolCalls(
    [
      toolCall({ id: "a", name: "bash", arguments: "NOT_JSON" }),
      toolCall({ id: "b", name: "read", arguments: '{"path":"x"}' }),
    ],
    1,
  );
  assert(mixed.items.length === 2, "mixed keeps both");
  assert(mixed.items[0]?.kind === "invalid", "first invalid");
  assert(mixed.items[1]?.kind === "ready", "second ready");

  console.log("stream-turn tests passed");
}

main();
