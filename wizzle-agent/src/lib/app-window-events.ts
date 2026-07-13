export const CLOSE_SUBAGENT_VIEW_EVENT = "wizzle:close-subagent-view";
export const REQUEST_APP_EXIT_EVENT = "wizzle:request-app-exit";

export function resolveNativeCloseAction(hasOpenSubagentView: boolean) {
  return hasOpenSubagentView ? "close_subagent_view" : "confirm_app_exit";
}
