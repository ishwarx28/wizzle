/**
 * Policy for helper provider calls (title generation, compaction summaries)
 * vs the owning agent session run (#31 / #32 / #61).
 */

/** Title and compaction must not drive Busy/Idle; the agent run owns runtime. */
export function shouldManageSessionRuntimeForHelperCompletion() {
  return false;
}

/**
 * After a provider stream/completion ends, only apply Idle when no agent run
 * is still active for the session.
 */
export function shouldReleaseSessionRuntimeToIdle(options: {
  sessionRunActive: boolean;
}) {
  return !options.sessionRunActive;
}
