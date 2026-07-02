import { ArrowUp, ChevronDown, Paperclip } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useScrollActivity } from "../../hooks/use-scroll-activity";
import { useWorkspaceStore } from "../../store/workspace-store";
import type { ModelId, PermissionMode } from "../../types/workspace";

interface ComposerProps {
  expanded?: boolean;
  placeholder: string;
}

export function Composer({ expanded = false, placeholder }: ComposerProps) {
  const modelId = useWorkspaceStore((state) => state.modelId);
  const permissionMode = useWorkspaceStore((state) => state.permissionMode);
  const sendPrompt = useWorkspaceStore((state) => state.sendPrompt);
  const setModelId = useWorkspaceStore((state) => state.setModelId);
  const setPermissionMode = useWorkspaceStore((state) => state.setPermissionMode);
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { handleScrollActivity, isScrolling } = useScrollActivity();

  const isDisabled = draft.trim().length === 0;
  const permissionModeLabel =
    permissionMode === "full-access" ? "Full access" : "Manual approve";
  const modelIdLabel =
    modelId === "wizzle-1-thinking" ? "wizzle-1-thinking" : "wizzle-1-thinking-max";

  function handleSend() {
    const nextPrompt = draft.trim();

    if (nextPrompt.length === 0) {
      return;
    }

    window.dispatchEvent(new CustomEvent("wizzle:composer-send"));
    sendPrompt(nextPrompt);
    setDraft("");
  }

  useEffect(() => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    const minHeight = 48;
    const maxHeight = 256;

    textarea.style.height = "0px";

    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft, expanded]);

  return (
    <div className="rounded-[24px] border border-[var(--color-border)] bg-[var(--color-composer)]">
      <textarea
        ref={textareaRef}
        className={[
          "auto-hide-scrollbar w-full resize-none bg-transparent px-5 pb-0.5 pt-4 text-[14px] leading-7 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-tertiary)]",
          isScrolling ? "is-scrolling" : "",
        ].join(" ")}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            handleSend();
          }
        }}
        onScroll={handleScrollActivity}
        placeholder={placeholder}
        rows={1}
        value={draft}
      />
      <div className="flex items-center px-4 pb-1.25 pt-0">
        <div className="flex items-center gap-3">
          <button
            className="flex h-10 w-10 items-center justify-center rounded-2xl text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            title="Attach file or image"
          >
            <Paperclip className="h-4 w-4" />
          </button>

          <div className="relative inline-flex items-center">
            <span
              className={[
                "pointer-events-none pr-5 text-[14px] font-normal leading-none tracking-[0.01em]",
                permissionMode === "full-access"
                  ? "text-[#ff9b6b]"
                  : "text-[var(--color-text-secondary)]",
              ].join(" ")}
            >
              {permissionModeLabel}
            </span>
            <select
              className={[
                "absolute inset-0 w-full cursor-pointer appearance-none opacity-0 outline-none",
              ].join(" ")}
              onChange={(event) => setPermissionMode(event.currentTarget.value as PermissionMode)}
              value={permissionMode}
            >
              <option value="full-access">Full access</option>
              <option value="manual-approve">Manual approve</option>
            </select>
            <ChevronDown
              className={[
                "pointer-events-none absolute right-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2",
                permissionMode === "full-access"
                  ? "text-[#ff9b6b]"
                  : "text-[var(--color-text-secondary)]",
              ].join(" ")}
            />
          </div>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-3">
          <div className="relative inline-flex items-center">
            <span className="pointer-events-none pr-5 text-[14px] font-normal leading-none tracking-[0.01em] text-[var(--color-text-secondary)]">
              {modelIdLabel}
            </span>
            <select
              className="absolute inset-0 w-full cursor-pointer appearance-none opacity-0 outline-none"
              onChange={(event) => setModelId(event.currentTarget.value as ModelId)}
              value={modelId}
            >
              <option value="wizzle-1-thinking">wizzle-1-thinking</option>
              <option value="wizzle-1-thinking-max">wizzle-1-thinking-max</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-secondary)]" />
          </div>

          <button
            className={[
              "flex h-10 w-10 items-center justify-center rounded-full transition",
              isDisabled
                ? "cursor-not-allowed bg-[var(--color-panel-muted)] text-[var(--color-text-tertiary)]"
                : "bg-[var(--color-send-button)] text-[var(--color-send-button-foreground)] hover:bg-[var(--color-send-button-hover)]",
            ].join(" ")}
            disabled={isDisabled}
            onClick={handleSend}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
