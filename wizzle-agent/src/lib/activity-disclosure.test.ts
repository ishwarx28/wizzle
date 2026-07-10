import {
  activitySegmentHasVisibleBody,
  hasVisibleActivityBody,
  resolveActiveToolGroupSegmentId,
  shouldOpenToolGroup,
  shouldOpenWorkingSection,
  shouldShowWorkingPlaceholder,
} from "./activity-disclosure.ts";
import type { ActivitySegment } from "./tool-activity.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(
    shouldShowWorkingPlaceholder({
      isAssistant: true,
      status: "streaming",
      hasFinalContent: false,
      hasToolOrVisibleActivity: false,
    }),
    "streaming empty → Working...",
  );
  assert(
    !shouldShowWorkingPlaceholder({
      isAssistant: true,
      status: "streaming",
      hasFinalContent: false,
      hasToolOrVisibleActivity: true,
    }),
    "tools present → no Working...",
  );
  assert(
    !shouldShowWorkingPlaceholder({
      isAssistant: true,
      status: "streaming",
      hasFinalContent: true,
      hasToolOrVisibleActivity: false,
    }),
    "final content → no Working...",
  );
  assert(
    !shouldShowWorkingPlaceholder({
      isAssistant: true,
      status: "done",
      hasFinalContent: false,
      hasToolOrVisibleActivity: false,
    }),
    "done → no Working...",
  );

  assert(
    shouldOpenWorkingSection({
      isStreaming: true,
      hasVisibleActivityBody: true,
      hasManualToolExpansion: false,
    }),
    "streaming + body → open working",
  );
  assert(
    !shouldOpenWorkingSection({
      isStreaming: false,
      hasVisibleActivityBody: true,
      hasManualToolExpansion: false,
    }),
    "finished → collapse working",
  );
  assert(
    shouldOpenWorkingSection({
      isStreaming: false,
      hasVisibleActivityBody: true,
      hasManualToolExpansion: true,
    }),
    "finished + manual tool → keep working open",
  );

  assert(
    shouldOpenToolGroup({
      isStreaming: true,
      isActiveGroup: true,
      hasManualExpansion: false,
    }),
    "active group open while streaming",
  );
  assert(
    !shouldOpenToolGroup({
      isStreaming: true,
      isActiveGroup: false,
      hasManualExpansion: false,
    }),
    "previous group collapses when not active",
  );
  assert(
    shouldOpenToolGroup({
      isStreaming: true,
      isActiveGroup: false,
      hasManualExpansion: true,
    }),
    "manual keeps previous group open",
  );
  assert(
    !shouldOpenToolGroup({
      isStreaming: false,
      isActiveGroup: true,
      hasManualExpansion: false,
    }),
    "finished collapses groups without manual",
  );

  const segments: ActivitySegment[] = [
    {
      id: "g1",
      type: "tool_group",
      runs: [
        {
          call: { id: "c1", name: "bash" },
          callPayload: null,
          detailLabel: "Ran",
          id: "c1",
          isExpandable: true,
          kind: "bash",
          resultPayload: null,
          status: "done",
        },
      ],
    },
    {
      id: "g2",
      type: "tool_group",
      runs: [
        {
          call: { id: "c2", name: "read" },
          callPayload: null,
          detailLabel: "Read",
          id: "c2",
          isExpandable: false,
          kind: "read",
          resultPayload: null,
          status: "running",
        },
      ],
    },
  ];
  assert(resolveActiveToolGroupSegmentId(segments) === "g2", "last group is active");
  assert(hasVisibleActivityBody(segments), "groups count as body");
  assert(
    activitySegmentHasVisibleBody({
      id: "p1",
      type: "part",
      part: { id: "p1", type: "activity_content", content: "hi" },
    }),
    "activity content visible",
  );
  assert(
    !activitySegmentHasVisibleBody({
      id: "p2",
      type: "part",
      part: { id: "p2", type: "activity_content", content: "  " },
    }),
    "empty activity not visible",
  );

  console.log("activity-disclosure tests passed");
}

main();
