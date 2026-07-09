import type { PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const currentWindow = getCurrentWindow();

function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(
    target.closest(
      [
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "[role='button']",
        "[contenteditable='true']",
        "[data-no-window-drag]",
      ].join(","),
    ),
  );
}

export function useWindowDrag() {
  function onPointerDownCapture(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || isInteractiveTarget(event.target)) {
      return;
    }

    void currentWindow.startDragging().catch(() => undefined);
  }

  return { onPointerDownCapture };
}
