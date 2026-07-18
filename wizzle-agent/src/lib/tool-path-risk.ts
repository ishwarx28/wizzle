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

export type ResolvedPathCandidate = {
  error?: string | null;
  expandedPath?: string | null;
  hasUnexpandedVariables?: boolean;
  isInsideProjectRoot?: boolean | null;
  isSafeExternal?: boolean;
  rawPath: string;
  realPath?: string | null;
  resolvedPath?: string | null;
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
const SAFE_DEVICE_PATH_PREFIXES = ["/dev/fd/", "/dev/pts/"];
const MANUAL_APPROVAL_SHELL_ALLOWLIST = new Set([
  "ag",
  "cat",
  "cut",
  "egrep",
  "fgrep",
  "file",
  "find",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "sort",
  "stat",
  "tail",
  "wc",
  "where",
  "which",
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
  /^\.env(?:\.|$|\*|\?|\[)/,
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
const PATH_OPERAND_COMMANDS = new Set([
  ...MANUAL_APPROVAL_SHELL_ALLOWLIST,
  "cp",
  "mv",
  "rm",
  "rsync",
  "scp",
  "sftp",
  "sed",
  "unlink",
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

function resolveAgainstBasePath(projectRoot: string, basePath: string, requestedPath: string) {
  const requested = parsePath(requestedPath);

  if (requested.absolute) {
    return requested;
  }

  const base = parsePath(basePath).absolute
    ? parsePath(basePath)
    : resolveAgainstProjectRoot(projectRoot, basePath);
  const parts = [...base.parts];

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
    root: base.root,
  };
}

function isInsideProjectRoot(projectRoot: string, requestedPath: string, basePath = projectRoot) {
  const projectPath = parsePath(projectRoot);
  const resolvedPath = resolveAgainstBasePath(projectRoot, basePath, requestedPath);

  if (!resolvedPath.absolute || projectPath.root !== resolvedPath.root) {
    return false;
  }

  if (resolvedPath.parts.length < projectPath.parts.length) {
    return false;
  }

  return projectPath.parts.every((part, index) => resolvedPath.parts[index] === part);
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

function isExternalPath(projectRoot: string, value: string, basePath = projectRoot) {
  const trimmedValue = value.trim();

  if (!trimmedValue || isUrlLike(trimmedValue) || isSafeDevicePath(trimmedValue)) {
    return false;
  }

  if (trimmedValue === "~" || trimmedValue.startsWith("~/") || trimmedValue.startsWith("~\\")) {
    return true;
  }

  return !isInsideProjectRoot(projectRoot, trimmedValue, basePath);
}

function isSafeDevicePath(value: string) {
  const normalizedPath = normalizeSeparators(value.trim()).replace(/\/+$/, "") || "/";

  return (
    SAFE_DEVICE_PATHS.has(normalizedPath) ||
    SAFE_DEVICE_PATH_PREFIXES.some((prefix) =>
      normalizeSeparators(value.trim()).startsWith(prefix),
    )
  );
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

function markSearchPatternOperands(commandName: string, tokens: string[], skipIndexes: Set<number>) {
  if (!["ag", "egrep", "fgrep", "grep", "rg"].includes(commandName)) {
    return;
  }

  let hasPattern = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lowerToken = token.toLowerCase();

    if (lowerToken === "--") {
      continue;
    }

    if (["-e", "--regexp", "--regexp="].includes(lowerToken)) {
      if (index + 1 < tokens.length) {
        skipIndexes.add(index + 1);
        hasPattern = true;
        index += 1;
      }
      continue;
    }

    if (lowerToken.startsWith("-e") && lowerToken.length > 2) {
      skipIndexes.add(index);
      hasPattern = true;
      continue;
    }

    if (
      lowerToken.startsWith("--regexp=") ||
      lowerToken.startsWith("--glob=") ||
      lowerToken.startsWith("--iglob=")
    ) {
      skipIndexes.add(index);
      continue;
    }

    if (
      ["-g", "--glob", "--iglob", "--include", "--exclude"].includes(lowerToken) &&
      index + 1 < tokens.length
    ) {
      skipIndexes.add(index + 1);
      index += 1;
      continue;
    }

    if (token.startsWith("-")) {
      continue;
    }

    if (!hasPattern) {
      skipIndexes.add(index);
      hasPattern = true;
    }
  }
}

function markSedScriptOperands(commandName: string, tokens: string[], skipIndexes: Set<number>) {
  if (commandName !== "sed") {
    return;
  }

  let hasScript = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lowerToken = token.toLowerCase();

    if (lowerToken === "-e" || lowerToken === "--expression") {
      if (index + 1 < tokens.length) {
        skipIndexes.add(index + 1);
        hasScript = true;
        index += 1;
      }
      continue;
    }

    if (lowerToken.startsWith("-e") && lowerToken.length > 2) {
      skipIndexes.add(index);
      hasScript = true;
      continue;
    }

    if (lowerToken === "-f" || lowerToken === "--file") {
      hasScript = true;
      if (index + 1 < tokens.length) {
        index += 1;
      }
      continue;
    }

    if (token.startsWith("-")) {
      continue;
    }

    if (!hasScript) {
      skipIndexes.add(index);
      hasScript = true;
    }
  }
}

function markAwkProgramOperands(commandName: string, tokens: string[], skipIndexes: Set<number>) {
  if (commandName !== "awk") {
    return;
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lowerToken = token.toLowerCase();

    if (lowerToken === "-f" || lowerToken === "--file") {
      if (index + 1 < tokens.length) {
        index += 1;
      }
      continue;
    }

    if (lowerToken === "-v" && index + 1 < tokens.length) {
      index += 1;
      continue;
    }

    if (token.startsWith("-")) {
      continue;
    }

    skipIndexes.add(index);
    return;
  }
}

function markFindExpressionOperands(commandName: string, tokens: string[], skipIndexes: Set<number>) {
  if (commandName !== "find") {
    return;
  }

  const patternTests = new Set([
    "-ilname",
    "-iname",
    "-ipath",
    "-iregex",
    "-iwholename",
    "-lname",
    "-name",
    "-path",
    "-regex",
    "-wholename",
  ]);

  for (let index = 1; index < tokens.length; index += 1) {
    if (patternTests.has((tokens[index] ?? "").toLowerCase()) && index + 1 < tokens.length) {
      skipIndexes.add(index + 1);
      index += 1;
    }
  }
}

function buildNonPathOperandIndexes(commandName: string, tokens: string[]) {
  const skipIndexes = new Set<number>();
  markSearchPatternOperands(commandName, tokens, skipIndexes);
  markSedScriptOperands(commandName, tokens, skipIndexes);
  markAwkProgramOperands(commandName, tokens, skipIndexes);
  markFindExpressionOperands(commandName, tokens, skipIndexes);
  return skipIndexes;
}

function collectShellStagePathCandidates(command: string, candidates: Set<string>) {
  const tokens = unwrapCommandTokens(extractShellTokens(command));
  const commandName = getCommandName(tokens[0] ?? "");
  const nonPathOperandIndexes = buildNonPathOperandIndexes(commandName, tokens);

  for (const [index, token] of tokens.entries()) {
    if (nonPathOperandIndexes.has(index)) {
      continue;
    }

    const isBarePathOperand =
      index > 0 && PATH_OPERAND_COMMANDS.has(commandName) && !token.startsWith("-");

    if (
      isBarePathOperand ||
      isPathLike(token) ||
      isSensitivePath(token) ||
      isShellVariableReference(token)
    ) {
      candidates.add(token);
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 0) {
      const value = token.slice(equalsIndex + 1);
      if (isPathLike(value) || isSensitivePath(value) || isShellVariableReference(value)) {
        candidates.add(value);
      }
    }
  }
}

function collectShellPathCandidates(command: string) {
  const candidates = new Set<string>();
  const stages = splitInspectionPipeline(command.trim()) ?? [command];

  for (const stage of stages) {
    collectShellStagePathCandidates(stage, candidates);
  }

  return [...candidates];
}

export function collectToolPathCandidates(input: {
  command?: string;
  path?: string;
  toolName: ApprovalToolName;
}) {
  if (input.toolName === "shell") {
    return collectShellPathCandidates(input.command ?? "");
  }

  const path = input.path?.trim();
  return path ? [path] : [];
}

function findResolvedPathCandidate(
  resolvedPaths: readonly ResolvedPathCandidate[] | undefined,
  rawPath: string,
) {
  return resolvedPaths?.find((entry) => entry.rawPath === rawPath);
}

function isResolvedCandidateSensitive(
  candidate: string,
  resolved?: ResolvedPathCandidate,
) {
  return [
    candidate,
    resolved?.expandedPath,
    resolved?.realPath,
    resolved?.resolvedPath,
  ].some((value) => Boolean(value?.trim()) && isSensitivePath(value ?? ""));
}

function isResolvedCandidateExternal(input: {
  basePath?: string;
  candidate: string;
  projectRoot: string;
  resolved?: ResolvedPathCandidate;
}) {
  const resolved = input.resolved;

  if (
    isShellVariableReference(input.candidate) &&
    (!resolved || isShellVariableReference(resolved.expandedPath ?? input.candidate))
  ) {
    return true;
  }

  if (resolved?.hasUnexpandedVariables) {
    return true;
  }

  const resolvedPath =
    resolved?.realPath?.trim() ||
    resolved?.resolvedPath?.trim() ||
    resolved?.expandedPath?.trim() ||
    input.candidate;

  if (isSafeDevicePath(resolvedPath)) {
    return false;
  }

  if (typeof resolved?.isInsideProjectRoot === "boolean") {
    return !resolved.isInsideProjectRoot;
  }

  return isExternalPath(input.projectRoot, resolvedPath, input.basePath);
}

function getCommandName(token: string) {
  const normalized = token.trim().replace(/^['"`]+|['"`]+$/g, "");
  return normalized.split("/").pop()?.toLowerCase() ?? normalized.toLowerCase();
}

function tokenHasFlag(token: string, flagPattern: RegExp) {
  return token.startsWith("-") && flagPattern.test(token);
}

function isShellVariableReference(value: string) {
  return (
    /\$(?:\{[^}]+\}|[a-zA-Z_][a-zA-Z\d_]*)/.test(value) ||
    /%[a-zA-Z_][a-zA-Z\d_]*%/.test(value)
  );
}

function splitInspectionPipeline(command: string) {
  const stages: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";

    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }

    if (quote) {
      current += character;
      if (character === quote) {
        quote = null;
      } else if (
        quote === '"' &&
        (character === "`" || (character === "$" && command[index + 1] === "("))
      ) {
        return null;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }

    if (character === "|") {
      const stage = current.trim();
      if (!stage || command[index + 1] === "|") {
        return null;
      }
      stages.push(stage);
      current = "";
      continue;
    }

    if (character === "`" || ";&<>{}\n\r".includes(character)) {
      return null;
    }

    if (character === "$" && command[index + 1] === "(") {
      return null;
    }

    current += character;
  }

  const finalStage = current.trim();
  if (!finalStage || quote || escaped) {
    return null;
  }

  stages.push(finalStage);
  return stages;
}

function hasUnquotedGlob(command: string) {
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character === "*" || character === "?" || character === "[") {
      return true;
    }
  }

  return false;
}

function hasUnsafeFindAction(tokens: string[]) {
  const unsafeActions = new Set([
    "-delete",
    "-exec",
    "-execdir",
    "-fls",
    "-fprint",
    "-fprint0",
    "-ok",
    "-okdir",
  ]);

  return tokens.slice(1).some((token) => unsafeActions.has(token.toLowerCase()));
}

function searchCanReadHiddenFiles(commandName: string, tokens: string[]) {
  if (!["ag", "egrep", "fgrep", "grep", "rg"].includes(commandName)) {
    return false;
  }

  return tokens.slice(1).some((token) => {
    const lowerToken = token.toLowerCase();

    if (["--hidden", "--no-ignore", "--recursive"].includes(lowerToken)) {
      return true;
    }

    if (commandName === "rg" && /^-.*u{2,}/.test(lowerToken)) {
      return true;
    }

    return ["egrep", "fgrep", "grep"].includes(commandName) && /^-[^-]*[rR]/.test(token);
  });
}

function isWhitelistedShellStage(command: string) {
  const rawTokens = extractShellTokens(command);

  if (getCommandName(rawTokens[0] ?? "") === "sudo") {
    return false;
  }

  const tokens = unwrapCommandTokens(rawTokens);
  const commandName = getCommandName(tokens[0] ?? "");

  if (!MANUAL_APPROVAL_SHELL_ALLOWLIST.has(commandName)) {
    return false;
  }

  if (hasUnquotedGlob(command)) {
    return false;
  }

  if (commandName === "find" && hasUnsafeFindAction(tokens)) {
    return false;
  }

  if (
    commandName === "sort" &&
    tokens.slice(1).some((token) =>
      token === "-o" ||
      token.startsWith("--output=") ||
      (/^-[^-]+/.test(token) && token.slice(1).includes("o")),
    )
  ) {
    return false;
  }

  return !searchCanReadHiddenFiles(commandName, tokens);
}

export function isWhitelistedShellCommand(command: string) {
  const stages = splitInspectionPipeline(command.trim());
  return Boolean(stages?.every(isWhitelistedShellStage));
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
  return collectShellPathCandidates(command).some(isSensitivePath);
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

  if (
    isShellVariableReference(tokens[0] ?? "") ||
    commandName === "eval" ||
    (commandName === "xargs" &&
      tokens.some((token) => ["dd", "rm", "rmdir", "shred", "truncate", "unlink"].includes(getCommandName(token)))) ||
    /\bxargs\b[^;&|]*\b(?:dd|rm|rmdir|shred|truncate|unlink)\b/.test(lowerCommand) ||
    (["bash", "cmd", "sh", "zsh"].includes(commandName) &&
      tokens.slice(1).some((token) => token === "-c" || token === "/c")) ||
    (commandName === "find" && hasUnsafeFindAction(tokens)) ||
    /(?:\$\([^)]*|`[^`]*)\b(?:dd|rm|rmdir|shred|truncate|unlink)\b/.test(lowerCommand)
  ) {
    return "The command can execute a destructive operation indirectly.";
  }

  if (/(^|[;&|]\s*)(?:sudo\s+)?(?:rm|rmdir|unlink)\b/.test(lowerCommand)) {
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

  if (["rm", "rmdir", "unlink"].includes(commandName)) {
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
    collectShellPathCandidates(normalizedCommand).some(isSensitivePath)
  ) {
    return "The command can print credential-like file contents.";
  }

  if (commandCopiesOrUploadsSensitiveFiles(commandName, normalizedCommand)) {
    return "The command can copy or upload credential-like files.";
  }

  return null;
}

function warningMessage(toolName: ApprovalToolName) {
  if (toolName === "shell") {
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
  cwd?: string;
  path?: string;
  permissionMode: PermissionMode;
  projectRoot: string;
  resolvedCwd?: ResolvedPathCandidate;
  resolvedPaths?: ResolvedPathCandidate[];
  toolName: ApprovalToolName;
}): ToolApprovalRequest["warning"] {
  if (input.toolName === "shell") {
    const command = input.command ?? "";
    const pathCandidates = collectShellPathCandidates(command);
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
      pathCandidates.some(isSensitivePath)
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

    if (
      pathCandidates.some((candidate) =>
        isResolvedCandidateSensitive(
          candidate,
          findResolvedPathCandidate(input.resolvedPaths, candidate),
        ),
      )
    ) {
      return {
        kind: "sensitive-path",
        message:
          "This command references a credential-like file. Approve only if the file access is required.",
        title: "Sensitive file",
      };
    }
  } else if (
    input.toolName === "read" &&
    isResolvedCandidateSensitive(
      input.path ?? "",
      findResolvedPathCandidate(input.resolvedPaths, input.path?.trim() ?? ""),
    )
  ) {
    return {
      kind: "sensitive-path",
      message:
        "This request accesses a credential-like file. Approve only if the file access is required.",
      title: "Sensitive file",
    };
  }

  if (input.toolName === "read" && input.permissionMode === "full-access") {
    return undefined;
  }

  const hasExternalCwd =
    input.toolName === "shell" &&
    Boolean(input.cwd?.trim()) &&
    isResolvedCandidateExternal({
      candidate: input.cwd ?? "",
      projectRoot: input.projectRoot,
      resolved: input.resolvedCwd,
    });
  const hasExternalPath =
    input.toolName === "shell"
      ? hasExternalCwd ||
        collectShellPathCandidates(input.command ?? "").some((candidate) =>
            isResolvedCandidateExternal({
              basePath: input.cwd,
              candidate,
              projectRoot: input.projectRoot,
              resolved: findResolvedPathCandidate(input.resolvedPaths, candidate),
            }),
          )
      : Boolean(input.path?.trim()) &&
        isResolvedCandidateExternal({
          candidate: input.path ?? "",
          projectRoot: input.projectRoot,
          resolved: findResolvedPathCandidate(input.resolvedPaths, input.path?.trim() ?? ""),
        });

  if (!hasExternalPath) {
    return undefined;
  }

  return {
    kind: "external-path",
    message: `${warningMessage(input.toolName)} Approve only if you trust the target path.`,
    title: "External path",
  };
}
