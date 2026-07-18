import { detectOperatingSystem, resolveCommandShell } from "./runtime-environment.ts";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

assertEqual(
  detectOperatingSystem(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Win32",
  ),
  "Windows",
  "detects Windows",
);
assertEqual(
  detectOperatingSystem("Mozilla/5.0 (Macintosh; Intel Mac OS X)", "MacIntel"),
  "macOS",
  "detects macOS",
);
assertEqual(
  detectOperatingSystem("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64"),
  "Linux",
  "detects Linux",
);
assertEqual(detectOperatingSystem("custom", "custom"), "Unknown", "handles unknown OS");
assertEqual(
  resolveCommandShell("Windows"),
  "Command Prompt (cmd.exe /C)",
  "uses Command Prompt on Windows",
);
assertEqual(
  resolveCommandShell("macOS"),
  "POSIX shell (sh -lc)",
  "uses POSIX shell on macOS",
);

console.log("runtime environment tests passed");
