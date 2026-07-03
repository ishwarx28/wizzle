import { AlertCircle, LoaderCircle, MailCheck, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/auth-context";
import { AuthCard } from "../components/auth/AuthCard";
import { GoogleButton } from "../components/auth/GoogleButton";
import { Button } from "../components/common/Button";
import { TextField } from "../components/common/TextField";

type LoginStatus = "idle" | "created" | "verify";

const MIN_EMAIL_LENGTH = 5;
const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;
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

function validatePassword(password: string) {
  if (!password) {
    return "Enter your password.";
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }

  return null;
}

export function LoginPage() {
  const navigate = useNavigate();
  const {
    clearErrorMessage,
    errorMessage: authErrorMessage,
    isConfigured,
    isGoogleConfigured,
    signInOrCreateWithEmail,
    signInWithGoogle,
  } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<LoginStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);
  const emailError = validateEmail(email);
  const passwordError = validatePassword(password);

  async function submitLogin() {
    clearErrorMessage();
    setStatus("idle");
    setErrorMessage(null);

    if (emailError) {
      setErrorMessage(emailError);
      return;
    }

    if (passwordError) {
      setErrorMessage(passwordError);
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await signInOrCreateWithEmail(email, password);

      if (result.status === "created") {
        navigate("/app");
        return;
      }

      if (result.status === "verify") {
        navigate("/app");
        return;
      }

      navigate("/app");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to continue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitGoogleLogin() {
    clearErrorMessage();
    setStatus("idle");
    setErrorMessage(null);
    setIsGoogleSubmitting(true);

    try {
      const result = await signInWithGoogle();

      if (result === "signed-in") {
        navigate("/app");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Google sign-in failed.");
    } finally {
      setIsGoogleSubmitting(false);
    }
  }

  const isBusy = isSubmitting || isGoogleSubmitting;
  const isLoginDisabled = !isConfigured || isBusy || Boolean(emailError) || Boolean(passwordError);
  const visibleErrorMessage = errorMessage ?? authErrorMessage;

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
            onChange={(event) => {
              setEmail(event.currentTarget.value);
              setErrorMessage(null);
              clearErrorMessage();
              setStatus("idle");
            }}
            placeholder="Email address"
            disabled={isBusy}
            maxLength={MAX_EMAIL_LENGTH}
            type="email"
            value={email}
          />
          <TextField
            autoComplete="current-password"
            label="Password"
            onChange={(event) => {
              setPassword(event.currentTarget.value);
              setErrorMessage(null);
              clearErrorMessage();
              setStatus("idle");
            }}
            placeholder="Password"
            revealablePassword
            disabled={isBusy}
            maxLength={MAX_PASSWORD_LENGTH}
            type="password"
            value={password}
          />

          {!isConfigured ? (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] p-4 text-sm leading-6 text-[var(--color-text)]">
              Firebase is not configured yet. Add the values from
              <span className="mx-1 font-medium">`wizzle-agent/.env.example`</span>
              before signing in.
            </div>
          ) : null}

          {visibleErrorMessage ? (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] p-4 text-sm leading-6 text-[var(--color-text)]">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <AlertCircle className="h-4 w-4 text-[var(--color-text)]" />
                Sign-in failed
              </div>
              {visibleErrorMessage}
            </div>
          ) : null}

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
              Check your inbox and spam folder, then verify the email before signing in.
            </div>
          ) : null}

          <Button
            className="mt-1"
            disabled={isLoginDisabled}
            fullWidth
            onClick={() => {
              void submitLogin();
            }}
          >
            {isSubmitting ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin" />
                Continuing
              </>
            ) : (
              "Continue"
            )}
          </Button>

          <div className="text-center text-[15px] text-[var(--color-text-secondary)]">
            New account? It will be created automatically.
          </div>

          <div className="relative py-1 text-center text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">
            <span className="relative z-10 bg-[var(--color-app-bg)] px-4">or</span>
            <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--color-border)]" />
          </div>

          {!isGoogleConfigured ? (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] p-4 text-sm leading-6 text-[var(--color-text)]">
              Google desktop sign-in needs
              <span className="mx-1 font-medium">`VITE_GOOGLE_OAUTH_CLIENT_ID`</span>
              and
              <span className="mx-1 font-medium">`VITE_GOOGLE_OAUTH_CLIENT_SECRET`</span>.
            </div>
          ) : null}

          <GoogleButton
            disabled={!isConfigured || !isGoogleConfigured || isBusy}
            onClick={() => {
              void submitGoogleLogin();
            }}
          >
            {isGoogleSubmitting ? "Continue in browser..." : undefined}
          </GoogleButton>

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
