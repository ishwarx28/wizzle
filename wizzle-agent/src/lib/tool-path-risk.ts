import type { PermissionMode, ToolApprovalRequest } from "../types/workspace";

type ApprovalToolName = ToolApprovalRequest["toolName"];
type PermissionAction = "allow" | "ask" | "deny";

export type PermissionRule = {
  action: PermissionAction;
  pattern: string;
  tool: ApprovalToolName | "*";
};

type NormalizedPath = {
  absolute: boolean;
  parts: string[];
  root: string;
};

const SAFE_DEVICE_PATHS = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
]);
const SECRET_FILE_NAMES = new Set([
  ".aws/credentials",
  ".docker/config.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
  "service-account.json",
]);
const SECRET_FILE_NAME_PATTERNS = [
  /^\.env(?:\.|$)/,
  /(?:^|[._-])api[_-]?key(?:[._-]|$)/,
  /(?:^|[._-])credential(?:s)?(?:[._-]|$)/,
  /\.(?:key|p12|pem|pfx)$/,
  /(?:^|[._-])secret(?:s)?(?:[._-]|$)/,
  /(?:^|[._-])token(?:s)?(?:[._-]|$)/,
];
const SECRET_PRINT_COMMANDS = new Set([
  "awk",
  "bat",
  "cat",
  "grep",
  "head",
  "less",
  "more",
  "sed",
  "tail",
]);
const SECRET_COPY_OR_UPLOAD_COMMANDS = new Set([
  "aws",
  "cp",
  "curl",
  "gh",
  "rsync",
  "scp",
  "sftp",
]);

function isUrlLike(value: string) {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value);
}

function isWindowsAbsolutePath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function normalizeSeparators(value: string) {
  return value.replace(/\\/g, "/");
}

function parsePath(value: string): NormalizedPath {
  const normalizedValue = normalizeSeparators(value.trim());
  let root = "";
  let rest = normalizedValue;
  let absolute = false;

  if (/^[a-zA-Z]:\//.test(normalizedValue)) {
    root = normalizedValue.slice(0, 2).toLowerCase();
    rest = normalizedValue.slice(3);
    absolute = true;
  } else if (normalizedValue.startsWith("//")) {
    const [, , host = "", share = "", ...tail] = normalizedValue.split("/");
    root = `//${host.toLowerCase()}/${share.toLowerCase()}`;
    rest = tail.join("/");
    absolute = true;
  } else if (normalizedValue.startsWith("/")) {
    root = "/";
    rest = normalizedValue.slice(1);
    absolute = true;
  }

  const parts: string[] = [];
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push(segment);
      }
      continue;
    }

    parts.push(segment);
  }

  return {
    absolute,
    parts,
    root,
  };
}

function resolveAgainstProjectRoot(projectRoot: string, requestedPath: string): NormalizedPath {
  const projectPath = parsePath(projectRoot);
  const requested = parsePath(requestedPath);

  if (requested.absolute) {
    return requested;
  }

  const parts = [...projectPath.parts];
  for (const segment of requested.parts) {
    if (segment === "..") {
      if (parts.length > 0) {
        parts.pop();
      }
      continue;
    }

    parts.push(segment);
  }

  return {
    absolute: true,
    parts,
    root: projectPath.root,
  };
}

function isInsideProjectRoot(projectRoot: string, requestedPath: string) {
  const projectPath = parsePath(projectRoot);
  const resolvedPath = resolveAgainstProjectRoot(projectRoot, requestedPath);

  if (!resolvedPath.absolute || projectPath.root !== resolvedPath.root) {
    return false;
  }

  if (resolvedPath.parts.length < projectPath.parts.length) {
    return false;
  }

  return projectPath.parts.every((part, index) => resolvedPath.parts[index] === part);
}

function isInsideAllowedRoot(allowedRoot: string, requestedPath: string) {
  const allowedPath = parsePath(allowedRoot);
  const resolvedPath = resolveAgainstProjectRoot(allowedRoot, requestedPath);

  if (!resolvedPath.absolute || allowedPath.root !== resolvedPath.root) {
    return false;
  }

  if (resolvedPath.parts.length < allowedPath.parts.length) {
    return false;
  }

  return allowedPath.parts.every((part, index) => resolvedPath.parts[index] === part);
}

function isPathLike(value: string) {
  if (!value || value.startsWith("-") || isUrlLike(value)) {
    return false;
  }

  return (
    value === "." ||
    value === ".." ||
    value === "~" ||
    value.startsWith("./") ||
    value.startsWith(".\\") ||
    value.startsWith("../") ||
    value.startsWith("..\\") ||
    value.startsWith("~/") ||
    value.startsWith("~\\") ||
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    isWindowsAbsolutePath(value) ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function isExternalPath(projectRoot: string, value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue || isUrlLike(trimmedValue) || SAFE_DEVICE_PATHS.has(trimmedValue)) {
    return false;
  }

  if (trimmedValue === "~" || trimmedValue.startsWith("~/") || trimmedValue.startsWith("~\\")) {
    return true;
  }

  return !isInsideProjectRoot(projectRoot, trimmedValue);
}

function isGlobalSkillsPath(value: string, globalSkillsDir?: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue || isUrlLike(trimmedValue)) {
    return false;
  }

  if (
    trimmedValue === "~/.wizzle/skills" ||
    trimmedValue === "~/.wizzle/skills/" ||
    trimmedValue.startsWith("~/.wizzle/skills/") ||
    trimmedValue === "~\\.wizzle\\skills" ||
    trimmedValue === "~\\.wizzle\\skills\\" ||
    trimmedValue.startsWith("~\\.wizzle\\skills\\")
  ) {
    return true;
  }

  if (!globalSkillsDir?.trim()) {
    return false;
  }

  return isInsideAllowedRoot(globalSkillsDir, trimmedValue);
}

function normalizeSecretPath(value: string) {
  return normalizeSeparators(value.trim())
    .replace(/^~\//, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

export function isSensitivePath(value: string) {
  const normalizedPath = normalizeSecretPath(value);

  if (!normalizedPath) {
    return false;
  }

  const parts = normalizedPath.split("/").filter(Boolean);
  const fileName = parts[parts.length - 1] ?? normalizedPath;
  const tailPath = parts.slice(-2).join("/");

  if (SECRET_FILE_NAMES.has(fileName) || SECRET_FILE_NAMES.has(tailPath)) {
    return true;
  }

  return SECRET_FILE_NAME_PATTERNS.some((pattern) => pattern.test(fileName));
}

function extractShellTokens(command: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaped = true;
      current += character;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }

    if (/\s/.test(character) || character === "|" || character === "&" || character === ";" || character === "<" || character === ">") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function collectBashPathCandidates(command: string) {
  const candidates = new Set<string>();

  for (const token of extractShellTokens(command)) {
    if (isPathLike(token) || isSensitivePath(token)) {
      candidates.add(token);
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 0) {
      const value = token.slice(equalsIndex + 1);
      if (isPathLike(value) || isSensitivePath(value)) {
        candidates.add(value);
      }
    }
  }

  return [...candidates];
}

function getCommandName(token: string) {
  const normalized = token.trim().replace(/^['"`]+|['"`]+$/g, "");
  return normalized.split("/").pop()?.toLowerCase() ?? normalized.toLowerCase();
}

function tokenHasFlag(token: string, flagPattern: RegExp) {
  return token.startsWith("-") && flagPattern.test(token);
}

function wildcardToRegExp(pattern: string) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+.,]/g, "\\$&");

  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

function unwrapCommandTokens(tokens: string[]) {
  let offset = 0;

  while (offset < tokens.length) {
    const commandName = getCommandName(tokens[offset] ?? "");

    if (!["command", "noglob", "sudo", "time"].includes(commandName)) {
      break;
    }

    offset += 1;

    while (tokens[offset]?.startsWith("-")) {
      offset += 1;
    }
  }

  return tokens.slice(offset);
}

function hasAnySensitivePath(command: string) {
  return collectBashPathCandidates(command).some(isSensitivePath);
}

function commandCopiesOrUploadsSensitiveFiles(commandName: string, command: string) {
  if (!SECRET_COPY_OR_UPLOAD_COMMANDS.has(commandName) || !hasAnySensitivePath(command)) {
    return false;
  }

  const lowerCommand = command.toLowerCase();

  if (commandName === "aws") {
    return /\baws\s+s3\s+cp\b/.test(lowerCommand);
  }

  if (commandName === "curl") {
    return /\b(-t|--upload-file|--form|-f)\b/.test(lowerCommand);
  }

  if (commandName === "gh") {
    return /\bgh\s+(gist|release)\b/.test(lowerCommand);
  }

  return true;
}

export function evaluatePermissionRules(input: {
  commandOrPath: string;
  rules: PermissionRule[];
  toolName: ApprovalToolName;
}): PermissionAction {
  let action: PermissionAction = "ask";

  for (const rule of input.rules) {
    if (rule.tool !== "*" && rule.tool !== input.toolName) {
      continue;
    }

    if (wildcardToRegExp(rule.pattern).test(input.commandOrPath)) {
      action = rule.action;
    }
  }

  return action;
}

export function classifyDangerousCommand(command: string) {
  const normalizedCommand = command.trim();

  if (!normalizedCommand) {
    return null;
  }

  const lowerCommand = normalizedCommand.toLowerCase();
  const tokens = unwrapCommandTokens(extractShellTokens(normalizedCommand));
  const commandName = getCommandName(tokens[0] ?? "");

  if (/(^|[;&|]\s*)(?:sudo\s+)?rm\b/.test(lowerCommand)) {
    return "The command deletes files.";
  }

  if (/(^|[;&|]\s*)(?:sudo\s+)?(?:dd|shred|truncate)\b/.test(lowerCommand)) {
    return "The command can destroy or truncate file contents.";
  }

  if (/(^|[;&|]\s*)git\s+reset\s+--hard\b/.test(lowerCommand)) {
    return "The command discards local git changes.";
  }

  if (/(^|[;&|]\s*)git\s+clean\b[^;&|]*-[a-z]*f/.test(lowerCommand)) {
    return "The command permanently removes untracked git files.";
  }

  if (commandName === "env" || commandName === "printenv") {
    return "The command can print environment secrets.";
  }

  if (commandName === "rm") {
    return "The command deletes files.";
  }

  if (lowerCommand.includes("find . -delete") || /\bfind\b[\s\S]*\s-delete\b/.test(lowerCommand)) {
    return "The command deletes files through find.";
  }

  if (
    commandName === "git" &&
    tokens[1] === "clean" &&
    tokens.slice(2).some((token) => tokenHasFlag(token.toLowerCase(), /f|d/))
  ) {
    return "The command permanently removes untracked git files.";
  }

  if (
    commandName === "git" &&
    tokens[1] === "reset" &&
    tokens.slice(2).some((token) => token.toLowerCase() === "--hard")
  ) {
    return "The command discards local git changes.";
  }

  if (
    commandName === "git" &&
    tokens[1] === "checkout" &&
    tokens
      .slice(2)
      .some((token) => token === "--" || token === "-f" || token === "--force" || isPathLike(token))
  ) {
    return "The command can overwrite files from git history.";
  }

  if (commandName === "mv") {
    return "The command can replace files.";
  }

  if (["dd", "shred", "truncate"].includes(commandName)) {
    return "The command can destroy or truncate file contents.";
  }

  if (
    ["chmod", "chown"].includes(commandName) &&
    tokens
      .slice(1)
      .some((token) => tokenHasFlag(token.toLowerCase(), /r/) || token.toLowerCase() === "--recursive")
  ) {
    return "The command recursively changes file permissions or ownership.";
  }

  if (
    commandName === "docker" &&
    tokens[1] === "system" &&
    tokens[2] === "prune"
  ) {
    return "The command deletes Docker system data.";
  }

  if (
    SECRET_PRINT_COMMANDS.has(commandName) &&
    collectBashPathCandidates(normalizedCommand).some(isSensitivePath)
  ) {
    return "The command can print credential-like file contents.";
  }

  if (commandCopiesOrUploadsSensitiveFiles(commandName, normalizedCommand)) {
    return "The command can copy or upload credential-like files.";
  }

  return null;
}

function warningMessage(toolName: ApprovalToolName) {
  if (toolName === "bash") {
    return "This command references a file path outside the selected project.";
  }

  if (toolName === "read") {
    return "This read would access a file outside the selected project.";
  }

  if (toolName === "write") {
    return "This write would change a file outside the selected project.";
  }

  return "This edit would change a file outside the selected project.";
}

export function createExternalPathWarning(input: {
  command?: string;
  globalSkillsDir?: string;
  path?: string;
  permissionMode: PermissionMode;
  projectRoot: string;
  toolName: ApprovalToolName;
}): ToolApprovalRequest["warning"] {
  if (input.toolName === "bash") {
    const command = input.command ?? "";
    const commandTokens = unwrapCommandTokens(extractShellTokens(command));
    const commandName = getCommandName(commandTokens[0] ?? "");

    if (commandName === "env" || commandName === "printenv") {
      return {
        kind: "sensitive-path",
        message:
          "This command can print environment-secret values. Approve only if the output is required.",
        title: "Sensitive output",
      };
    }

    if (
      SECRET_PRINT_COMMANDS.has(commandName) &&
      collectBashPathCandidates(command).some(isSensitivePath)
    ) {
      return {
        kind: "sensitive-path",
        message:
          "This command can print credential-like file contents. Approve only if the output is required.",
        title: "Sensitive output",
      };
    }

    if (commandCopiesOrUploadsSensitiveFiles(commandName, command)) {
      return {
        kind: "sensitive-path",
        message:
          "This command can copy or upload credential-like files. Approve only if that transfer is intended.",
        title: "Sensitive file transfer",
      };
    }

    const dangerousReason = classifyDangerousCommand(command);

    if (dangerousReason) {
      return {
        kind: "dangerous-command",
        message: `${dangerousReason} Approve only if this action is required.`,
        title: "Dangerous command",
      };
    }

    if (collectBashPathCandidates(command).some(isSensitivePath)) {
      return {
        kind: "sensitive-path",
        message:
          "This command references a credential-like file. Approve only if the file access is required.",
        title: "Sensitive file",
      };
    }
  } else if (isSensitivePath(input.path ?? "")) {
    return {
      kind: "sensitive-path",
      message:
        "This request accesses a credential-like file. Approve only if the file access is required.",
      title: "Sensitive file",
    };
  }

  if (input.permissionMode !== "manual-approve") {
    return undefined;
  }

  const hasExternalPath =
    input.toolName === "bash"
      ? collectBashPathCandidates(input.command ?? "").some((candidate) =>
          isExternalPath(input.projectRoot, candidate),
        )
      : isPathLike(input.path ?? "") &&
        isExternalPath(input.projectRoot, input.path ?? "") &&
        !(input.toolName === "read" && isGlobalSkillsPath(input.path ?? "", input.globalSkillsDir));

  if (!hasExternalPath) {
    return undefined;
  }

  return {
    kind: "external-path",
    message: `${warningMessage(input.toolName)} Approve only if you trust the target path.`,
    title: "External path",
  };
}
