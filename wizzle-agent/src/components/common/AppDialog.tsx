import { createPortal } from "react-dom";
import { useEffect, useId, useRef } from "react";
import type { PropsWithChildren, ReactNode } from "react";

interface AppDialogProps {
  actions: ReactNode;
  busy?: boolean;
  dismissible?: boolean;
  description?: string;
  /**
   * Top border above the action row. Only for long scrollable forms
   * (add/edit provider); keep off for simple confirms and short dialogs.
   */
  footerDivider?: boolean;
  /** Let structured content sit flush against the dialog shell. */
  flushContent?: boolean;
  onClose: () => void;
  /** Wider panels for multi-field forms and large catalog editors. */
  size?: "default" | "wide" | "provider";
  /** Keep an accessible name while omitting the visible title area. */
  hideHeader?: boolean;
  title: string;
}

export function AppDialog({
  actions,
  busy = false,
  children,
  description,
  dismissible = true,
  footerDivider = false,
  flushContent = false,
  hideHeader = false,
  onClose,
  size = "default",
  title,
}: PropsWithChildren<AppDialogProps>) {
  const maxWidthClass =
    size === "provider"
      ? "max-w-[1120px]"
      : size === "wide"
        ? "max-w-[720px]"
        : "max-w-[380px]";
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const dismissibleRef = useRef(dismissible);
  onCloseRef.current = onClose;
  busyRef.current = busy;
  dismissibleRef.current = dismissible;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusFirstControl = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const autofocusTarget = panel?.querySelector<HTMLElement>("[autofocus]");
      const firstControl = panel?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      (autofocusTarget ?? firstControl ?? panel)?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      const panel = panelRef.current;
      if (!panel) {
        return;
      }

      if (event.key === "Escape") {
        if (dismissibleRef.current && !busyRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const controls = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (controls.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!panel.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFirstControl);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/45 px-4 backdrop-blur-[2px]"
      data-modal
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          if (dismissible && !busy) {
            onClose();
          }
        }
      }}
    >
      <div
        aria-busy={busy || undefined}
        aria-describedby={!hideHeader && description ? descriptionId : undefined}
        aria-label={hideHeader ? title : undefined}
        aria-labelledby={hideHeader ? undefined : titleId}
        aria-modal="true"
        className={`relative flex w-full ${maxWidthClass} max-h-[min(90vh,880px)] flex-col overflow-hidden rounded-[26px] border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[0_22px_60px_rgba(0,0,0,0.34)]`}
        onMouseDown={(event) => event.stopPropagation()}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        {!hideHeader ? (
          <div className="shrink-0 space-y-1 px-5 pt-5">
            <h2 className="text-ui-tight font-medium text-[var(--color-text)]" id={titleId}>{title}</h2>
            {description ? (
              <p className="text-ui text-[var(--color-text-secondary)]" id={descriptionId}>{description}</p>
            ) : null}
          </div>
        ) : null}

        {children ? (
          <div
            className={[
              "min-h-0 flex-1 overflow-y-auto",
              flushContent ? "p-0" : "px-5 pt-4",
            ].join(" ")}
          >
            {children}
          </div>
        ) : null}

        <div
          className={[
            "shrink-0 bg-[var(--color-panel)] px-5",
            footerDivider
              ? "border-t border-[var(--color-border)] py-4"
              : "pb-5 pt-5",
          ].join(" ")}
        >
          <div className="flex justify-end gap-2.5">{actions}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
