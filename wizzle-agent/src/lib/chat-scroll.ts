export const BOTTOM_FOLLOW_TOLERANCE_PX = 2;
export const BOTTOM_INDICATOR_THRESHOLD_PX = 80;

export type ScrollMetrics = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

export function distanceFromBottom(metrics: ScrollMetrics) {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

export function shouldFollowAfterScroll(options: {
  distanceFromBottom: number;
  following: boolean;
  previousScrollTop: number;
  scrollTop: number;
}) {
  if (options.following) {
    return !(
      options.scrollTop < options.previousScrollTop &&
      options.distanceFromBottom > BOTTOM_FOLLOW_TOLERANCE_PX
    );
  }

  return (
    options.distanceFromBottom <= BOTTOM_FOLLOW_TOLERANCE_PX &&
    options.scrollTop >= options.previousScrollTop
  );
}
