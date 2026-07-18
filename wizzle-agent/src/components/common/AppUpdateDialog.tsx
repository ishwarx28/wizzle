import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import {
  installAppUpdate,
  type AppUpdateProgress,
  type AvailableAppUpdate,
} from "../../lib/app-update";
import { frontendLogger } from "../../lib/logger";
import { AppDialog } from "./AppDialog";

function progressLabel(progress: AppUpdateProgress | null) {
  if (!progress) {
    return "Preparing update…";
  }
  if (progress.phase === "installing") {
    return "Installing update…";
  }
  if (progress.phase === "restarting") {
    return "Restarting Wizzle…";
  }
  if (progress.totalBytes && progress.totalBytes > 0) {
    const percent = Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
    return `Downloading update… ${percent}%`;
  }
  return "Downloading update…";
}

export function AppUpdateDialog({
  onClose,
  update,
}: {
  onClose: () => void;
  update: AvailableAppUpdate;
}) {
  const critical = update.status === "critical";
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);

  async function startUpdate() {
    if (installing) {
      return;
    }
    setError(null);
    setProgress(null);
    setInstalling(true);
    try {
      await installAppUpdate(setProgress);
    } catch (caught) {
      frontendLogger.error("frontend.app-update", "install_failed", { error: caught });
      setError(
        typeof caught === "string"
          ? caught
          : caught instanceof Error && caught.message.trim()
            ? caught.message
            : "Wizzle could not install the update.",
      );
      setInstalling(false);
    }
  }

  return (
    <AppDialog
      actions={
        <>
          {!critical ? (
            <button
              className="h-10 rounded-full px-4 text-ui-tight text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
              disabled={installing}
              onClick={onClose}
              type="button"
            >
              Later
            </button>
          ) : null}
          <button
            className="flex h-10 items-center gap-2 rounded-full bg-[var(--color-accent)] px-4 text-ui-tight font-medium text-[var(--color-accent-foreground)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-wait disabled:opacity-70"
            disabled={installing}
            onClick={() => void startUpdate()}
            type="button"
          >
            {installing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            {installing ? progressLabel(progress) : "Update now"}
          </button>
        </>
      }
      busy={installing}
      description={
        critical
          ? "This critical update is required before you can continue using Wizzle."
          : `Version ${update.version} is ready to install.`
      }
      dismissible={!critical}
      onClose={onClose}
      title={critical ? "Critical update required" : "Update Wizzle"}
    >
      <div className="space-y-3">
        <p className="text-ui leading-5 text-[var(--color-text-secondary)]">{update.note}</p>
        {error ? (
          <p className="rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-ui text-[var(--color-danger)]" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </AppDialog>
  );
}
