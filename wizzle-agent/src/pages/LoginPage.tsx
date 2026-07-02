import { MailCheck, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { AuthCard } from "../components/auth/AuthCard";
import { GoogleButton } from "../components/auth/GoogleButton";
import { Button } from "../components/common/Button";
import { TextField } from "../components/common/TextField";

type LoginStatus = "idle" | "created" | "verify";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<LoginStatus>("idle");

  function submitLogin() {
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail || !password.trim()) {
      return;
    }

    if (normalizedEmail.includes("new")) {
      setStatus("created");
      return;
    }

    if (normalizedEmail.includes("verify")) {
      setStatus("verify");
      return;
    }

    navigate("/app");
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
        <AuthCard
        description="Built to think through your code, not just type it."
        title="Log in to Wizzle"
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
          <TextField
            autoComplete="current-password"
            label="Password"
            onChange={(event) => setPassword(event.currentTarget.value)}
            placeholder="Password"
            revealablePassword
            type="password"
            value={password}
          />

          {status === "created" ? (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-success)] p-4 text-sm leading-6 text-[var(--color-text)]">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <MailCheck className="h-4 w-4 text-[var(--color-text)]" />
                Account created
              </div>
              We created your account. Verify the email address before the first login.
            </div>
          ) : null}

          {status === "verify" ? (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-success)] p-4 text-sm leading-6 text-[var(--color-text)]">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <ShieldCheck className="h-4 w-4 text-[var(--color-text)]" />
                Verification required
              </div>
              Check your inbox and verify the email before signing in.
            </div>
          ) : null}

          <Button className="mt-1" fullWidth onClick={submitLogin}>
            Continue
          </Button>

          <div className="text-center text-[15px] text-[var(--color-text-secondary)]">
            New account? It will be created automatically.
          </div>

          <div className="relative py-1 text-center text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">
            <span className="relative z-10 bg-[var(--color-app-bg)] px-4">or</span>
            <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--color-border)]" />
          </div>

          <GoogleButton onClick={() => navigate("/app")} />

          <div className="text-center text-sm">
            <Link
              className="text-[var(--color-text-secondary)] transition hover:text-[var(--color-text)]"
              to="/reset-password"
            >
              Forgot password?
            </Link>
          </div>
        </div>
        </AuthCard>
    </div>
  );
}
