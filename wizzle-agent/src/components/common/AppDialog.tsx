import { createPortal } from "react-dom";
import type { PropsWithChildren, ReactNode } from "react";

interface AppDialogProps {
  actions: ReactNode;
  description?: string;
  onClose: () => void;
  title: string;
}

export function AppDialog({
  actions,
  children,
  description,
  onClose,
  title,
}: PropsWithChildren<AppDialogProps>) {
  return createPortal(
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/45 px-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="relative w-full max-w-[380px] rounded-[26px] border border-[var(--color-border)] bg-[var(--color-panel)] p-5 shadow-[0_22px_60px_rgba(0,0,0,0.34)]"
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
