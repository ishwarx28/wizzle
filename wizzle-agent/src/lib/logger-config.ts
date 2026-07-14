export type FrontendLogMode = "off" | "error" | "info" | "debug";

export function parseFrontendLogMode(rawValue: string | undefined): FrontendLogMode {
  const normalizedValue = (rawValue ?? "debug").trim().toLowerCase();

  switch (normalizedValue) {
    case "off":
    case "error":
    case "info":
    case "debug":
      return normalizedValue;
    default:
      return "debug";
  }
}
