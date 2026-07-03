import { ArrowUp, ChevronDown, FileCode2, FileImage, FileText, Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useScrollActivity } from "../../hooks/use-scroll-activity";
import { useWorkspaceStore } from "../../store/workspace-store";
import type { ModelId, PermissionMode, PreviewFile } from "../../types/workspace";

interface ComposerProps {
  expanded?: boolean;
  placeholder: string;
}

const MAX_ATTACHMENTS = 5;
const SUPPORTED_FILE_ACCEPT =
  "image/*,.md,.mdx,.markdown,.txt,.ts,.tsx,.js,.jsx,.json,.css,.html,.htm,.sh,.yaml,.yml,.xml";

const markdownExtensions = new Set(["md", "mdx", "markdown"]);
const textExtensions = new Set([
  "txt",
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "css",
  "html",
  "htm",
  "sh",
  "yaml",
  "yml",
  "xml",
]);

function getExtension(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return extension ?? "";
}

function fileIcon(kind: PreviewFile["kind"]) {
  switch (kind) {
    case "image":
      return <FileImage className="h-3.5 w-3.5" />;
    case "markdown":
      return <FileText className="h-3.5 w-3.5" />;
    default:
      return <FileCode2 className="h-3.5 w-3.5" />;
  }
}

function inferPreviewKind(file: File): PreviewFile["kind"] | null {
  if (file.type.startsWith("image/")) {
    return "image";
  }

  const extension = getExtension(file.name);

  if (markdownExtensions.has(extension)) {
    return "markdown";
  }

  if (
    file.type.startsWith("text/") ||
    file.type === "application/json" ||
    file.type === "application/xml" ||
    textExtensions.has(extension)
  ) {
    return "text";
  }

  return null;
}

function inferLanguage(fileName: string) {
  const extension = getExtension(fileName);

  switch (extension) {
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    case "ts":
      return "ts";
    case "tsx":
      return "tsx";
    case "js":
      return "js";
    case "jsx":
      return "jsx";
    case "json":
      return "json";
    case "css":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "sh":
      return "sh";
    case "yaml":
    case "yml":
      return "yaml";
    case "xml":
      return "xml";
    default:
      return "text";
  }
}

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

async function createAttachmentPreview(file: File): Promise<PreviewFile | null> {
  const kind = inferPreviewKind(file);

  if (!kind) {
    return null;
  }

  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `attachment-${crypto.randomUUID()}`
      : `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (kind === "image") {
    const imageSrc = await readAsDataUrl(file);

    return {
      id,
      name: file.name,
      kind,
      path: `Attachments/${file.name}`,
      summary: "Image attachment",
      imageSrc,
    };
  }

  return {
    id,
    name: file.name,
    kind,
    path: `Attachments/${file.name}`,
    summary: kind === "markdown" ? "Markdown attachment" : "Text attachment",
    content: await file.text(),
    language: inferLanguage(file.name),
  };
}

export function Composer({ expanded = false, placeholder }: ComposerProps) {
  const modelId = useWorkspaceStore((state) => state.modelId);
  const permissionMode = useWorkspaceStore((state) => state.permissionMode);
  const sendPrompt = useWorkspaceStore((state) => state.sendPrompt);
  const setModelId = useWorkspaceStore((state) => state.setModelId);
  const setPermissionMode = useWorkspaceStore((state) => state.setPermissionMode);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PreviewFile[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { handleScrollActivity, isScrolling } = useScrollActivity();

  const isDisabled = draft.trim().length === 0 && attachments.length === 0;
  const permissionModeLabel =
    permissionMode === "full-access" ? "Full access" : "Manual approve";
  const modelIdLabel =
    modelId === "wizzle-1-thinking" ? "wizzle-1-thinking" : "wizzle-1-thinking-max";

  async function addAttachments(files: File[]) {
    if (files.length === 0) {
      return;
    }

    const remainingSlots = Math.max(MAX_ATTACHMENTS - attachments.length, 0);

    if (remainingSlots === 0) {
      setAttachmentNotice("You can attach up to 5 items.");
      return;
    }

    const previews = (await Promise.all(files.map((file) => createAttachmentPreview(file)))).filter(
      (preview): preview is PreviewFile => Boolean(preview),
    );
    const nextAttachments = previews.slice(0, remainingSlots);
    const unsupportedCount = files.length - previews.length;
    const overflowCount = Math.max(previews.length - nextAttachments.length, 0);

    if (nextAttachments.length > 0) {
      setAttachments((current) => [...current, ...nextAttachments]);
    }

    if (unsupportedCount > 0 && overflowCount > 0) {
      setAttachmentNotice(`Some files were skipped. Only supported files and 5 total items are allowed.`);
      return;
    }

    if (unsupportedCount > 0) {
      setAttachmentNotice("Only supported text, markdown, code files, and images can be attached.");
      return;
    }

    if (overflowCount > 0) {
      setAttachmentNotice("Only the first 5 attachments were kept.");
      return;
    }

    setAttachmentNotice(null);
  }

  function handleSend() {
    const nextPrompt = draft.trim();

    if (nextPrompt.length === 0 && attachments.length === 0) {
      return;
    }

    window.dispatchEvent(new CustomEvent("wizzle:composer-send"));
    sendPrompt(nextPrompt, attachments);
    setDraft("");
    setAttachments([]);
    setAttachmentNotice(null);
  }

  useEffect(() => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    const minHeight = 48;
    const maxHeight = 256;

    textarea.style.height = "0px";

    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft, expanded]);

  return (
    <div className="rounded-[24px] border border-[var(--color-border)] bg-[var(--color-composer)]">
      <input
        accept={SUPPORTED_FILE_ACCEPT}
        className="hidden"
        multiple
        onChange={(event) => {
          void addAttachments(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
        ref={fileInputRef}
        type="file"
      />
      <textarea
        ref={textareaRef}
        className={[
          "auto-hide-scrollbar w-full resize-none bg-transparent px-5 pb-0.5 pt-4 text-[14px] leading-7 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-tertiary)]",
          isScrolling ? "is-scrolling" : "",
        ].join(" ")}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            handleSend();
          }
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);

          if (files.length === 0) {
            return;
          }

          event.preventDefault();
          void addAttachments(files);
        }}
        onScroll={handleScrollActivity}
        placeholder={placeholder}
        rows={1}
        value={draft}
      />
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-4 pb-2 pt-2">
          {attachments.map((attachment) => (
            <div
              className="flex items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-2.5 py-1.5 text-[12px] text-[var(--color-text-secondary)]"
              key={attachment.id}
            >
              <span className="text-[var(--color-text)]">{fileIcon(attachment.kind)}</span>
              <span className="max-w-[180px] truncate">{attachment.name}</span>
              <button
                aria-label={`Remove ${attachment.name}`}
                className="rounded-full p-0.5 text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={() =>
                  setAttachments((current) =>
                    current.filter((currentAttachment) => currentAttachment.id !== attachment.id),
                  )
                }
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {attachmentNotice ? (
        <div className="px-5 pb-1 text-[12px] text-[var(--color-text-tertiary)]">
          {attachmentNotice}
        </div>
      ) : null}
      <div className="flex items-center px-4 pb-1.25 pt-0">
        <div className="flex items-center gap-3">
          <button
            className="flex h-10 w-10 items-center justify-center rounded-2xl text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            onClick={() => fileInputRef.current?.click()}
            title="Attach file or image"
            type="button"
          >
            <Paperclip className="h-4 w-4" />
          </button>

          <div className="relative inline-flex items-center">
            <span
              className={[
                "pointer-events-none pr-5 text-[14px] font-normal leading-none tracking-[0.01em]",
                permissionMode === "full-access"
                  ? "text-[#ff9b6b]"
                  : "text-[var(--color-text-secondary)]",
              ].join(" ")}
            >
              {permissionModeLabel}
            </span>
            <select
              className={[
                "absolute inset-0 w-full cursor-pointer appearance-none opacity-0 outline-none",
              ].join(" ")}
              onChange={(event) => setPermissionMode(event.currentTarget.value as PermissionMode)}
              value={permissionMode}
            >
              <option value="full-access">Full access</option>
              <option value="manual-approve">Manual approve</option>
            </select>
            <ChevronDown
              className={[
                "pointer-events-none absolute right-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2",
                permissionMode === "full-access"
                  ? "text-[#ff9b6b]"
                  : "text-[var(--color-text-secondary)]",
              ].join(" ")}
            />
          </div>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-3">
          <div className="relative inline-flex items-center">
            <span className="pointer-events-none pr-5 text-[14px] font-normal leading-none tracking-[0.01em] text-[var(--color-text-secondary)]">
              {modelIdLabel}
            </span>
            <select
              className="absolute inset-0 w-full cursor-pointer appearance-none opacity-0 outline-none"
              onChange={(event) => setModelId(event.currentTarget.value as ModelId)}
              value={modelId}
            >
              <option value="wizzle-1-thinking">wizzle-1-thinking</option>
              <option value="wizzle-1-thinking-max">wizzle-1-thinking-max</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-secondary)]" />
          </div>

          <button
            className={[
              "flex h-10 w-10 items-center justify-center rounded-full transition",
              isDisabled
                ? "cursor-not-allowed bg-[var(--color-panel-muted)] text-[var(--color-text-tertiary)]"
                : "bg-[var(--color-send-button)] text-[var(--color-send-button-foreground)] hover:bg-[var(--color-send-button-hover)]",
            ].join(" ")}
            disabled={isDisabled}
            onClick={handleSend}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
