import { createPortal } from "react-dom";
import type { PropsWithChildren, ReactNode } from "react";

interface AppDialogProps {
  actions: ReactNode;
  description?: string;
  onClose: () => void;
  /** Wider panel for multi-field forms (provider editor). */
  size?: "default" | "wide";
  title: string;
}

export function AppDialog({
  actions,
  children,
  description,
  onClose,
  size = "default",
  title,
}: PropsWithChildren<AppDialogProps>) {
  const maxWidthClass = size === "wide" ? "max-w-[720px]" : "max-w-[380px]";

  return createPortal(
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/45 px-4 backdrop-blur-[2px]"
      data-modal
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      role="dialog"
    >
      <div
        className={`relative w-full ${maxWidthClass} max-h-[min(90vh,880px)] overflow-y-auto rounded-[26px] border border-[var(--color-border)] bg-[var(--color-panel)] p-5 shadow-[0_22px_60px_rgba(0,0,0,0.34)]`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="space-y-1">
          <h2 className="text-[16px] font-medium text-[var(--color-text)]">{title}</h2>
          {description ? (
            <p className="text-[13px] leading-5 text-[var(--color-text-secondary)]">{description}</p>
          ) : null}
        </div>

        {children ? <div className="mt-4">{children}</div> : null}

        <div className="mt-5 flex justify-end gap-2.5">{actions}</div>
      </div>
    </div>,
    document.body,
  );
}
