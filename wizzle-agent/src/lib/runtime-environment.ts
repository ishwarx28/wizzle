export type RuntimeOperatingSystem = "Linux" | "macOS" | "Unknown" | "Windows";

export function detectOperatingSystem(
  userAgent: string,
  platform: string,
): RuntimeOperatingSystem {
  const identity = `${platform} ${userAgent}`.toLowerCase();

  if (identity.includes("win")) {
    return "Windows";
  }
  if (identity.includes("mac")) {
    return "macOS";
  }
  if (identity.includes("linux") || identity.includes("x11")) {
    return "Linux";
  }
  return "Unknown";
}

export function resolveCommandShell(operatingSystem: RuntimeOperatingSystem) {
  switch (operatingSystem) {
    case "Windows":
      return "Command Prompt (cmd.exe /C)";
    case "Linux":
    case "macOS":
      return "POSIX shell (sh -lc)";
    default:
      return "Unknown host shell";
  }
}
