import { ArrowLeft, MailCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { AuthCard } from "../components/auth/AuthCard";
import { Button } from "../components/common/Button";
import { TextField } from "../components/common/TextField";

export function ResetPasswordPage() {
  const [email, setEmail] = useState("");
  const [isSent, setIsSent] = useState(false);

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
        <AuthCard
        description="Enter your email and Wizzle will send a reset link."
        title="Reset your password"
      >
        <div className="mx-auto max-w-[474px] space-y-5">
          <TextField
            autoComplete="email"
            label="Email"
            onChange={(event) => setEmail(event.currentTarget.value)}
            placeholder="Email address"
            type="email"
            value={email}
          />

          {isSent ? (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-success)] p-4 text-sm leading-6 text-[var(--color-text)]">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <MailCheck className="h-4 w-4 text-[var(--color-text)]" />
                Reset email sent
              </div>
              Check your inbox for the reset link.
            </div>
          ) : null}

          <Button
            fullWidth
            onClick={() => {
              if (email.trim()) {
                setIsSent(true);
              }
            }}
          >
            Send reset email
          </Button>

          <Link
            className="inline-flex w-full items-center justify-center gap-2 text-sm text-[var(--color-text-secondary)] transition hover:text-[var(--color-text)]"
            to="/login"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to login
          </Link>
        </div>
        </AuthCard>
    </div>
  );
}
