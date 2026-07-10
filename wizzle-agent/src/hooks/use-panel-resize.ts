import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const DEFAULT_SIDEBAR_WIDTH = 310;
const DEFAULT_FILE_PANEL_WIDTH = 420;
const MIN_SIDEBAR_WIDTH = 250;
const MAX_SIDEBAR_WIDTH = 460;
const MIN_FILE_PANEL_WIDTH = 320;
const MAX_FILE_PANEL_WIDTH = 640;
const MIN_CENTER_WIDTH = 560;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clearDocumentSelection() {
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    selection.removeAllRanges();
  }
}

function beginResizeInteraction(event: ReactPointerEvent<HTMLElement> | PointerEvent) {
  // Prevent text selection starting on the same gesture as the drag.
  event.preventDefault();
  clearDocumentSelection();
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  document.documentElement.style.userSelect = "none";
  // WebKit / Safari
  (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect =
    "none";
}

function endResizeInteraction() {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  document.documentElement.style.userSelect = "";
  (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = "";
  clearDocumentSelection();
}

export function usePanelResize(options: {
  isFilePanelOpen: boolean;
  isSidebarOpen: boolean;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [filePanelWidth, setFilePanelWidth] = useState(DEFAULT_FILE_PANEL_WIDTH);
  const [activeResize, setActiveResize] = useState<"sidebar" | "file" | null>(null);

  useEffect(() => {
    if (activeResize === null) {
      return;
    }

    function handlePointerMove(event: PointerEvent) {
      // Keep selection suppressed for the whole drag (esp. before paint/layout).
      event.preventDefault();
      clearDocumentSelection();

      const shell = shellRef.current;

      if (!shell) {
        return;
      }

      const bounds = shell.getBoundingClientRect();
      const shellWidth = bounds.width;

      if (activeResize === "sidebar") {
        const remainingFileWidth = options.isFilePanelOpen ? filePanelWidth : 0;
        const maxWidth = Math.min(
          MAX_SIDEBAR_WIDTH,
          shellWidth - remainingFileWidth - MIN_CENTER_WIDTH,
        );

        setSidebarWidth(
          clamp(event.clientX - bounds.left, MIN_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, maxWidth)),
        );
        return;
      }

      const remainingSidebarWidth = options.isSidebarOpen ? sidebarWidth : 0;
      const maxWidth = Math.min(
        MAX_FILE_PANEL_WIDTH,
        shellWidth - remainingSidebarWidth - MIN_CENTER_WIDTH,
      );

      setFilePanelWidth(
        clamp(bounds.right - event.clientX, MIN_FILE_PANEL_WIDTH, Math.max(MIN_FILE_PANEL_WIDTH, maxWidth)),
      );
    }

    function handlePointerUp() {
      setActiveResize(null);
      endResizeInteraction();
    }

    function handleSelectStart(event: Event) {
      event.preventDefault();
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.documentElement.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    document.addEventListener("selectstart", handleSelectStart);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.removeEventListener("selectstart", handleSelectStart);
      endResizeInteraction();
    };
  }, [activeResize, filePanelWidth, options.isFilePanelOpen, options.isSidebarOpen, sidebarWidth]);

  function startSidebarResize(event: ReactPointerEvent<HTMLElement>) {
    beginResizeInteraction(event);
    if (event.currentTarget.setPointerCapture) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Ignore capture failures (e.g. unsupported target).
      }
    }
    setActiveResize("sidebar");
  }

  function startFileResize(event: ReactPointerEvent<HTMLElement>) {
    beginResizeInteraction(event);
    if (event.currentTarget.setPointerCapture) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Ignore capture failures (e.g. unsupported target).
      }
    }
    setActiveResize("file");
  }

  return {
    filePanelWidth,
    panelContentTransitionClass:
      activeResize === null ? "transition-all duration-300 ease-out" : "transition-none",
    panelTransitionClass:
      activeResize === null ? "transition-[width] duration-300 ease-out" : "transition-none",
    shellRef,
    sidebarWidth,
    startFileResize,
    startSidebarResize,
  };
}
