import { AlertCircle, ArrowLeft, LoaderCircle, MailCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/auth-context";
import { AuthCard } from "../components/auth/AuthCard";
import { Button } from "../components/common/Button";
import { TextField } from "../components/common/TextField";

const MIN_EMAIL_LENGTH = 5;
const MAX_EMAIL_LENGTH = 254;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase();

  if (!normalizedEmail) {
    return "Enter your email address.";
  }

  if (normalizedEmail.length < MIN_EMAIL_LENGTH) {
    return `Email must be at least ${MIN_EMAIL_LENGTH} characters.`;
  }

  if (normalizedEmail.length > MAX_EMAIL_LENGTH) {
    return `Email must be at most ${MAX_EMAIL_LENGTH} characters.`;
  }

  if (!emailPattern.test(normalizedEmail)) {
    return "Enter a valid email address.";
  }

  return null;
}

export function ResetPasswordPage() {
  const { isConfigured, sendPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [isSent, setIsSent] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const emailError = validateEmail(email);

  async function submitReset() {
    setErrorMessage(null);
    setIsSent(false);

    if (emailError) {
      setErrorMessage(emailError);
      return;
    }

    setIsSubmitting(true);

    try {
      await sendPasswordReset(email);
      setIsSent(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to send reset email.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <AuthCard
        description="Enter your email and Wizzle will send a reset link."
        title="Reset your password"
      >
        <form
          autoComplete="on"
          className="mx-auto max-w-[474px] space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitReset();
          }}
        >
          <TextField
            autoCapitalize="none"
            autoComplete="email username"
            autoCorrect="off"
            id="reset-email"
            label="Email"
            name="email"
            onChange={(event) => {
              setEmail(event.currentTarget.value);
              setErrorMessage(null);
              setIsSent(false);
            }}
            placeholder="Email address"
            spellCheck={false}
            type="email"
            value={email}
          />

          {!isConfigured ? (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] p-4 text-sm leading-6 text-[var(--color-text)]">
              Firebase is not configured yet. Add the values from
              <span className="mx-1 font-medium">`wizzle-agent/.env.example`</span>
              before using password reset.
            </div>
          ) : null}

          {isSent ? (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-success)] p-4 text-sm leading-6 text-[var(--color-text)]">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <MailCheck className="h-4 w-4 text-[var(--color-text)]" />
                Reset email sent
              </div>
              Check your inbox for the reset link.
            </div>
          ) : null}

          {errorMessage ? (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] p-4 text-sm leading-6 text-[var(--color-text)]">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <AlertCircle className="h-4 w-4 text-[var(--color-text)]" />
                Reset failed
              </div>
              {errorMessage}
            </div>
          ) : null}

          <Button
            disabled={!isConfigured || isSubmitting || Boolean(emailError)}
            fullWidth
            type="submit"
          >
            {isSubmitting ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin" />
                Sending reset email
              </>
            ) : (
              "Send reset email"
            )}
          </Button>

          <Link
            className="inline-flex w-full items-center justify-center gap-2 text-sm text-[var(--color-text-secondary)] transition hover:text-[var(--color-text)]"
            to="/login"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to login
          </Link>
        </form>
      </AuthCard>
    </div>
  );
}
