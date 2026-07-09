import {
  appendBufferedToolChunk,
  createEmptyToolStreamBuffer,
  createInterruptedToolStreamOutput,
  createToolStreamOutput,
  MAX_TOOL_STREAM_BUFFER_LENGTH,
} from "./tool-stream-buffer.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  let buffer = createEmptyToolStreamBuffer();
  buffer = appendBufferedToolChunk(buffer, "stdout", "hello ");
  buffer = appendBufferedToolChunk(buffer, "stderr", "warn");
  assert(buffer.stdout === "hello ", "stdout append");
  assert(buffer.stderr === "warn", "stderr append");
  assert(buffer.combinedOutput === "hello warn", "combined append");
  assert(!buffer.truncated, "small stream not truncated");

  const streamPartial = JSON.parse(createToolStreamOutput(buffer)) as Record<string, unknown>;
  assert(streamPartial.streamPartial === true, "stream partial marker");
  assert(streamPartial.ok === true, "running partial ok");
  assert(streamPartial.truncated !== true, "no truncate flag when under cap");

  let big = createEmptyToolStreamBuffer();
  big = appendBufferedToolChunk(big, "stdout", "x".repeat(MAX_TOOL_STREAM_BUFFER_LENGTH + 50));
  assert(big.truncated, "over cap marks truncated");
  assert(big.stdout.length === MAX_TOOL_STREAM_BUFFER_LENGTH, "stdout capped");
  const capped = JSON.parse(createToolStreamOutput(big)) as Record<string, unknown>;
  assert(capped.truncated === true, "stream output truncated flag");
  assert(typeof capped.truncatedNote === "string", "truncate note present");

  const interruptedFromBuffer = JSON.parse(
    createInterruptedToolStreamOutput(big, "User interrupted"),
  ) as Record<string, unknown>;
  assert(interruptedFromBuffer.interrupted === true, "interrupted flag");
  assert(interruptedFromBuffer.ok === false, "interrupted not ok");
  assert(interruptedFromBuffer.truncated === true, "keeps truncated");
  assert(
    typeof interruptedFromBuffer.combinedOutput === "string" &&
      (interruptedFromBuffer.combinedOutput as string).length > 0,
    "preserves partial output",
  );
  assert(interruptedFromBuffer.partialStreamPreserved === true, "partial preserved marker");

  const interruptedFromJson = JSON.parse(
    createInterruptedToolStreamOutput(createToolStreamOutput(buffer), "Stopped."),
  ) as Record<string, unknown>;
  assert(interruptedFromJson.stdout === "hello ", "parse prior stream stdout");
  assert(interruptedFromJson.error === "Stopped.", "reason kept");

  const emptyInterrupt = JSON.parse(
    createInterruptedToolStreamOutput(null, "User interrupted"),
  ) as Record<string, unknown>;
  assert(emptyInterrupt.interrupted === true, "empty still interrupted");
  assert(emptyInterrupt.partialStreamPreserved !== true, "no partial when empty");

  console.log("tool-stream-buffer tests passed");
}

main();
