import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { resolveAboutConfig } from "../../lib/env";
import { frontendLogger } from "../../lib/logger";
import { AppDialog } from "./AppDialog";
import { LogoMark } from "./LogoMark";

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const contact = resolveAboutConfig();
  const [error, setError] = useState<string | null>(null);

  function openLink(url: string) {
    setError(null);
    void openUrl(url).catch((caughtError) => {
      frontendLogger.error("frontend.about", "contact_link_failed", { error: caughtError });
      setError("Wizzle could not open that link.");
    });
  }

  const links = [
    ["GitHub", contact.githubUrl],
    ["LinkedIn", contact.linkedinUrl],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

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
      description={`Version ${contact.version}`}
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
        {links.length > 0 ? (
          <div className="grid gap-2">
            {links.map(([label, url]) => (
              <button
                className="flex items-center justify-between rounded-2xl px-3 py-2.5 text-left text-ui text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                key={label}
                onClick={() => openLink(url)}
                type="button"
              >
                {label}
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        ) : null}
        {error ? <p className="text-[12px] text-[var(--color-danger)]">{error}</p> : null}
      </div>
    </AppDialog>
  );
}
