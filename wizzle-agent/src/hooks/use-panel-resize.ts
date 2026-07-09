import { useEffect, useRef, useState } from "react";

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
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [activeResize, filePanelWidth, options.isFilePanelOpen, options.isSidebarOpen, sidebarWidth]);

  return {
    filePanelWidth,
    panelContentTransitionClass:
      activeResize === null ? "transition-all duration-300 ease-out" : "transition-none",
    panelTransitionClass:
      activeResize === null ? "transition-[width] duration-300 ease-out" : "transition-none",
    shellRef,
    sidebarWidth,
    startFileResize: () => setActiveResize("file"),
    startSidebarResize: () => setActiveResize("sidebar"),
  };
}
