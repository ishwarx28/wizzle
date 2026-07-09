import type { ActivitySegment } from "./tool-activity";

/**
 * I-2: Show temporary "Working..." while the assistant is streaming and has not
 * yet produced tool activity or final content (reasoning is hidden).
 */
export function shouldShowWorkingPlaceholder(options: {
  hasFinalContent: boolean;
  hasToolOrVisibleActivity: boolean;
  isAssistant: boolean;
  status?: string | null;
}) {
  if (!options.isAssistant) {
    return false;
  }

  if (options.status !== "streaming") {
    return false;
  }

  if (options.hasFinalContent) {
    return false;
  }

  if (options.hasToolOrVisibleActivity) {
    return false;
  }

  return true;
}

/** Whether a segment contributes visible body under the Working section. */
export function activitySegmentHasVisibleBody(segment: ActivitySegment) {
  if (segment.type === "tool_group") {
    return segment.runs.length > 0;
  }

  const content = segment.part.content?.trim() ?? "";
  if (segment.part.type === "activity_content" || segment.part.type === "reasoning") {
    return content.length > 0;
  }

  return false;
}

export function hasVisibleActivityBody(segments: readonly ActivitySegment[]) {
  return segments.some((segment) => activitySegmentHasVisibleBody(segment));
}

/**
 * I-8: Working / activity section open state.
 * - Streaming with body: open
 * - Finished: closed unless a tool was manually expanded
 */
export function shouldOpenWorkingSection(options: {
  hasManualToolExpansion: boolean;
  hasVisibleActivityBody: boolean;
  isStreaming: boolean;
}) {
  if (!options.hasVisibleActivityBody && !options.hasManualToolExpansion) {
    return false;
  }

  if (options.isStreaming) {
    return true;
  }

  return options.hasManualToolExpansion;
}

/**
 * I-8: Tool-call grouping open state.
 * - Streaming: open only for the active (latest) group, or if manually expanded
 * - Finished: open only if manually expanded
 * Individual tool rows stay collapsed by default (handled in ToolRunRow).
 */
export function shouldOpenToolGroup(options: {
  hasManualExpansion: boolean;
  isActiveGroup: boolean;
  isStreaming: boolean;
}) {
  if (options.hasManualExpansion) {
    return true;
  }

  if (options.isStreaming) {
    return options.isActiveGroup;
  }

  return false;
}

/** Index of the last tool_group segment (active while streaming). */
export function resolveActiveToolGroupSegmentId(segments: readonly ActivitySegment[]) {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (segment.type === "tool_group") {
      return segment.id;
    }
  }

  return null;
}
