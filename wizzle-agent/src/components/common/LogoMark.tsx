import { useEffect, useState } from "react";

import logoSrc from "../../assets/brand/wizzle-logo.png";
import darkLogoSrc from "../../assets/brand/wizzle-logo-dark.png";
import {
  getStoredThemePreference,
  getThemeChangeEventName,
  resolveEffectiveTheme,
} from "../../utils/theme";

interface LogoMarkProps {
  className?: string;
}

export function LogoMark({ className }: LogoMarkProps) {
  const [effectiveTheme, setEffectiveTheme] = useState(() =>
    resolveEffectiveTheme(getStoredThemePreference()),
  );

  useEffect(() => {
    function syncTheme() {
      setEffectiveTheme(resolveEffectiveTheme(getStoredThemePreference()));
    }

    window.addEventListener(getThemeChangeEventName(), syncTheme);

    return () => {
      window.removeEventListener(getThemeChangeEventName(), syncTheme);
    };
  }, []);

  return (
    <img
      alt="Wizzle logo"
      className={className}
      src={effectiveTheme === "dark" ? darkLogoSrc : logoSrc}
    />
  );
}
