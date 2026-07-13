import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";

import { resolveAboutConfig } from "../../lib/env";
import { frontendLogger } from "../../lib/logger";
import { AppDialog } from "./AppDialog";

const MAX_FEEDBACK_LENGTH = 4_000;

export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const contact = resolveAboutConfig();
  const [category, setCategory] = useState("Feedback");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function openEmailDraft() {
    const message = feedback.trim();
    if (!contact.email || !message || submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);
    const subject = `Wizzle ${category}`;
    const body = `${message}\n\nWizzle version: ${contact.version}`;
    const mailto = `mailto:${contact.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    try {
      await openUrl(mailto);
      onClose();
    } catch (caughtError) {
      frontendLogger.error("frontend.feedback", "feedback_mail_failed", { error: caughtError });
      setError(`Could not open your email app. Contact ${contact.email}.`);
      setSubmitting(false);
    }
  }

  return (
    <AppDialog
      actions={
        <>
          <button
            className="h-10 rounded-full px-4 text-ui-tight text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="h-10 rounded-full bg-[var(--color-accent)] px-4 text-ui-tight font-medium text-[var(--color-accent-foreground)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!contact.email || !feedback.trim() || submitting}
            onClick={() => void openEmailDraft()}
            type="button"
          >
            Open email draft
          </button>
        </>
      }
      busy={submitting}
      description="Your email app will open with a draft for review. Wizzle does not send it automatically."
      onClose={onClose}
      title="Send feedback"
    >
      <div className="space-y-3">
        <label className="block text-[12px] text-[var(--color-text-secondary)]">
          Type
          <select
            className="mt-1 h-10 w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-ui text-[var(--color-text)] outline-none"
            onChange={(event) => setCategory(event.currentTarget.value)}
            value={category}
          >
            <option>Feedback</option>
            <option>Bug report</option>
            <option>Feature request</option>
          </select>
        </label>
        <label className="block text-[12px] text-[var(--color-text-secondary)]">
          Message
          <textarea
            autoFocus
            className="mt-1 min-h-32 w-full resize-y rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 py-2.5 text-ui text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-tertiary)]"
            maxLength={MAX_FEEDBACK_LENGTH}
            onChange={(event) => setFeedback(event.currentTarget.value)}
            placeholder="Tell us what happened or what would make Wizzle better."
            value={feedback}
          />
        </label>
        {!contact.email ? (
          <p className="text-[12px] text-[var(--color-danger)]">
            Feedback email is not configured for this build.
          </p>
        ) : null}
        {error ? <p className="text-[12px] text-[var(--color-danger)]">{error}</p> : null}
      </div>
    </AppDialog>
  );
}
