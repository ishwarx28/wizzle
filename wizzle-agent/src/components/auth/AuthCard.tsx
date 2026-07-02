import type { PropsWithChildren } from "react";

import { LogoMark } from "../common/LogoMark";

interface AuthCardProps {
  title: string;
  description?: string;
}

export function AuthCard({
  children,
  description,
  title,
}: PropsWithChildren<AuthCardProps>) {
  return (
    <div className="w-full max-w-[474px]">
      <div className="mb-5 flex flex-col items-center text-center">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-xl">
          <LogoMark className="h-12 w-12 object-contain" />
        </div>
        <h1 className="text-[2rem] font-semibold tracking-[-0.04em] text-[var(--color-text)]">
          {title}
        </h1>
        {description ? (
          <p className="mt-3 max-w-[420px] text-[15px] leading-7 text-[var(--color-text-secondary)]">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </div>
  );
}
