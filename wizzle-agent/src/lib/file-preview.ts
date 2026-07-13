import type { PreviewFile } from "../types/workspace";

export const MAX_HIGHLIGHTED_PREVIEW_CHARACTERS = 200_000;
export const MAX_HIGHLIGHTED_PREVIEW_LINES = 5_000;

export function isAbsoluteNativePath(path: string | null | undefined) {
  if (!path || path.includes("\0")) {
    return false;
  }

  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function shouldHighlightPreview(content: string) {
  if (content.length > MAX_HIGHLIGHTED_PREVIEW_CHARACTERS) {
    return false;
  }

  let lines = 1;
  for (const character of content) {
    if (character === "\n" && ++lines > MAX_HIGHLIGHTED_PREVIEW_LINES) {
      return false;
    }
  }

  return true;
}

export function buildPreviewMarkdown(content: string, language?: string) {
  const matches = content.match(/`+/g);
  const longestRun = matches?.reduce((maximum, run) => Math.max(maximum, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const safeLanguage = language?.trim().toLowerCase().replace(/[^a-z0-9_+#.-]/g, "") ?? "text";
  return `${fence}${safeLanguage || "text"}\n${content}\n${fence}`;
}

export function resolveFileOpenLabel(file: Pick<PreviewFile, "kind" | "language" | "name">) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "html" || extension === "htm" || file.language === "html") {
    return "Open in browser";
  }
  if (file.kind === "image") {
    return "Open image";
  }
  if (file.kind === "markdown" || file.kind === "text") {
    return "Open in editor";
  }
  return "Open file";
}
