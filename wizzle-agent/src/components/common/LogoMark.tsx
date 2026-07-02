import logoSrc from "../../assets/brand/wizzle-logo.png";
import darkLogoSrc from "../../assets/brand/wizzle-logo-dark.png";

interface LogoMarkProps {
  className?: string;
}

export function LogoMark({ className }: LogoMarkProps) {
  return (
    <picture>
      <source media="(prefers-color-scheme: dark)" srcSet={darkLogoSrc} />
      <img alt="Wizzle logo" className={className} src={logoSrc} />
    </picture>
  );
}
