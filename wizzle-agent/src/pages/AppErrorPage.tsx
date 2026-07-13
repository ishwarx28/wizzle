import { useRouteError } from "react-router-dom";
import { useEffect } from "react";

import { frontendLogger } from "../lib/logger";

export function AppErrorPage() {
  const error = useRouteError();
  const message = error instanceof Error && error.message.trim()
    ? error.message
    : "The desktop interface could not start.";

  useEffect(() => {
    frontendLogger.error("frontend.app", "render_failed", { error });
  }, [error]);

  return (
    <main className="flex h-screen items-center justify-center bg-[var(--color-app-bg)] p-6 text-[var(--color-text)]">
      <section className="w-full max-w-[420px] rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6 text-center">
        <h1 className="text-ui-tight font-medium">Wizzle could not open</h1>
        <p className="mt-2 break-words text-ui text-[var(--color-text-secondary)]">{message}</p>
        <button
          className="mt-5 rounded-full bg-[var(--color-accent)] px-4 py-2 text-ui-tight font-medium text-[var(--color-accent-foreground)]"
          onClick={() => window.location.reload()}
          type="button"
        >
          Reload Wizzle
        </button>
      </section>
    </main>
  );
}
