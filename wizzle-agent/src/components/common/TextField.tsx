import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState } from "react";
import type { InputHTMLAttributes } from "react";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  revealablePassword?: boolean;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(props, ref) {
  const { label, revealablePassword = false, type, ...fieldProps } = props;
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const isPasswordField = revealablePassword && type === "password";
  const resolvedType = isPasswordField && isPasswordVisible ? "text" : type;
  const commonClassName =
    "h-14 w-full rounded-full border border-[var(--color-border-strong)] bg-[var(--color-panel)] text-[15px] text-[var(--color-text)] outline-none transition placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:ring-3 focus:ring-[var(--color-accent-soft)] disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <label className="flex w-full flex-col gap-2">
      <span className="sr-only">{label}</span>
      <div className="relative">
        <input
          {...fieldProps}
          className={[
            commonClassName,
            isPasswordField ? "px-7 pr-14" : "px-7",
          ].join(" ")}
          ref={ref}
          type={resolvedType}
        />
        {isPasswordField ? (
          <button
            aria-label={isPasswordVisible ? "Hide password" : "Show password"}
            className="absolute right-5 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={fieldProps.disabled}
            onClick={(event) => {
              event.preventDefault();
              setIsPasswordVisible((value) => !value);
            }}
            type="button"
          >
            {isPasswordVisible ? <EyeOff className="h-4.5 w-4.5" /> : <Eye className="h-4.5 w-4.5" />}
          </button>
        ) : null}
      </div>
    </label>
  );
});
