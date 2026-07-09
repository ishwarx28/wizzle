/** Default number of user turns shown before “Show earlier turns”. */
export const TURN_PAGE_SIZE = 10;

/**
 * Initial window size when opening/switching a session.
 * Always a full page — short histories are handled by the window start index.
 */
export function initialVisibleTurnCount(pageSize = TURN_PAGE_SIZE) {
  return Math.max(1, pageSize);
}

/** True when some user turns are outside the current window. */
export function hasEarlierUserTurns(totalTurnCount: number, visibleTurnCount: number) {
  return Math.max(0, totalTurnCount) > Math.max(0, visibleTurnCount);
}

/**
 * After history hydrates, ensure we never stay stuck below a full first page
 * (e.g. session switch while messages were still empty set count to 1).
 */
export function reconcileVisibleTurnCountAfterHydrate(
  totalTurnCount: number,
  visibleTurnCount: number,
  pageSize = TURN_PAGE_SIZE,
) {
  const total = Math.max(0, totalTurnCount);
  const visible = Math.max(0, visibleTurnCount);
  const defaultWindow = Math.max(1, pageSize);

  if (total === 0) {
    return visible > 0 ? visible : defaultWindow;
  }

  // Showing fewer than min(total, page) means the first page is incomplete — bump.
  const minRequired = Math.min(total, defaultWindow);
  if (visible < minRequired) {
    return defaultWindow;
  }

  return visible;
}

/** Expand the window by one page, capped at total turns. */
export function nextVisibleTurnCount(
  totalTurnCount: number,
  currentVisibleCount: number,
  pageSize = TURN_PAGE_SIZE,
) {
  const total = Math.max(0, totalTurnCount);
  if (total === 0) {
    return Math.max(1, pageSize);
  }

  return Math.min(total, Math.max(0, currentVisibleCount) + Math.max(1, pageSize));
}

/**
 * Index into the flat message list where the visible window starts
 * (first message of the oldest visible user turn).
 */
export function visibleRawStartIndexForTurns(
  userTurnStartIndexes: readonly number[],
  visibleTurnCount: number,
) {
  if (userTurnStartIndexes.length === 0) {
    return 0;
  }

  const turnWindowStart = Math.max(0, userTurnStartIndexes.length - Math.max(0, visibleTurnCount));
  return userTurnStartIndexes[turnWindowStart] ?? 0;
}
