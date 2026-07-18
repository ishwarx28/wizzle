import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, ExternalLink } from "lucide-react";
import { useState } from "react";

import { useAppAboutConfig } from "../../hooks/use-app-about-config";
import { frontendLogger } from "../../lib/logger";
import type { AvailableAppUpdate } from "../../lib/app-update";
import { AppDialog } from "./AppDialog";
import { LogoMark } from "./LogoMark";

export function AboutDialog({
  availableUpdate,
  onClose,
  onOpenUpdate,
}: {
  availableUpdate: AvailableAppUpdate | null;
  onClose: () => void;
  onOpenUpdate: () => void;
}) {
  const contact = useAppAboutConfig();
  const [error, setError] = useState<string | null>(null);

  function openLink(url: string) {
    setError(null);
    void openUrl(url).catch((caughtError) => {
      frontendLogger.error("frontend.about", "contact_link_failed", { error: caughtError });
      setError("Wizzle could not open that link.");
    });
  }

  return (
    <AppDialog
      actions={
        <button
          className="h-10 rounded-full bg-[var(--color-accent)] px-4 text-ui-tight font-medium text-[var(--color-accent-foreground)]"
          onClick={onClose}
          type="button"
        >
          Done
        </button>
      }
      description={contact.version ? `Version ${contact.version}` : undefined}
      onClose={onClose}
      title="About Wizzle"
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-2xl bg-[var(--color-panel-muted)] p-3">
          <LogoMark className="h-10 w-10 shrink-0" />
          <div className="min-w-0">
            <p className="text-ui-tight font-medium text-[var(--color-text)]">{contact.name}</p>
            {contact.email ? (
              <button
                className="mt-0.5 truncate text-left text-[12px] text-[var(--color-text-secondary)] underline decoration-[var(--color-border-strong)] underline-offset-2"
                onClick={() => openLink(`mailto:${contact.email}`)}
                type="button"
              >
                {contact.email}
              </button>
            ) : null}
          </div>
        </div>
        {contact.links.length > 0 ? (
          <div className="grid gap-2">
            {contact.links.map((link) => (
              <button
                className="flex items-center justify-between rounded-2xl px-3 py-2.5 text-left text-ui text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                key={link.id}
                onClick={() => openLink(link.url)}
                type="button"
              >
                {link.label}
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        ) : null}
        <div
          className={[
            "rounded-2xl border p-3",
            availableUpdate?.status === "critical"
              ? "border-[var(--color-danger)]"
              : "border-[var(--color-border)]",
          ].join(" ")}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-[var(--color-text)]">
                {availableUpdate
                  ? `Update ${availableUpdate.version} is available`
                  : "Wizzle is up to date"}
              </p>
              <p className="mt-1 text-[12px] leading-4 text-[var(--color-text-secondary)]">
                {availableUpdate?.note ?? "You are running the latest available version."}
              </p>
            </div>
            {availableUpdate ? (
              <button
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={onOpenUpdate}
                type="button"
              >
                <Download className="h-3.5 w-3.5" />
                Update
              </button>
            ) : null}
          </div>
        </div>
        {error ? <p className="text-[12px] text-[var(--color-danger)]">{error}</p> : null}
      </div>
    </AppDialog>
  );
}
