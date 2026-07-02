import type { ButtonHTMLAttributes, PropsWithChildren } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  fullWidth?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--color-accent)] text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)]",
  secondary:
    "border border-[var(--color-border)] bg-[var(--color-panel-muted)] text-[var(--color-text)] hover:bg-[var(--color-panel-hover)]",
  ghost:
    "text-[var(--color-text-secondary)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]",
};

export function Button({
  children,
  className = "",
  fullWidth = false,
  type = "button",
  variant = "primary",
  ...props
}: PropsWithChildren<ButtonProps>) {
  return (
    <button
      className={[
        "inline-flex h-14 items-center justify-center gap-2 rounded-full px-6 text-[15px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60",
        fullWidth ? "w-full" : "",
        variantClasses[variant],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}
