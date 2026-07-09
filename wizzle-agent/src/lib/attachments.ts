import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { ModelCapability, PreviewFile } from "../types/workspace";

const TEXT_FILE_EXTENSIONS = [
  "bash",
  "c",
  "cjs",
  "cpp",
  "csv",
  "css",
  "dart",
  "dockerfile",
  "env",
  "gitignore",
  "go",
  "gradle",
  "h",
  "html",
  "ipynb",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "kts",
  "less",
  "log",
  "lock",
  "md",
  "mdx",
  "mjs",
  "prisma",
  "py",
  "pyi",
  "pyx",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
  "Dockerfile",
];

const IMAGE_FILE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

interface AttachmentPreviewPayload extends Omit<PreviewFile, "id"> {
  error?: string;
}

const MAX_TEXT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_SOURCE_BYTES = 20 * 1024 * 1024;

interface FilePreviewSource {
  path: string;
  projectId: string;
  projectRoot?: string;
  summary?: string;
}

function hashString(value: string) {
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

function buildAttachmentId(sourceKey?: string) {
  if (sourceKey?.trim()) {
    return `attachment-${hashString(sourceKey)}`;
  }

  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `attachment-${crypto.randomUUID()}`;
  }

  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSelectedPaths(selected: string | string[] | null) {
  if (!selected) {
    return [];
  }

  return Array.isArray(selected) ? selected : [selected];
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/");
}

function buildPreviewIdentity(preview: AttachmentPreviewPayload) {
  const normalizedPath = preview.path?.trim() ? normalizePath(preview.path) : "";

  if (normalizedPath) {
    return normalizedPath;
  }

  if (preview.imageSrc?.trim()) {
    return `image:${preview.name}:${preview.imageSrc.slice(0, 96)}`;
  }

  if (preview.content?.trim()) {
    return `text:${preview.name}:${preview.content.slice(0, 96)}`;
  }

  return `${preview.kind}:${preview.name}`;
}

export function buildSupportedFileAccept(capabilities: ModelCapability[]) {
  const accepts = [
    [
      ".dart",
      ".yaml",
      ".yml",
      ".py",
      ".pyi",
      ".pyx",
      ".ipynb",
      ".jsx",
      ".tsx",
      ".ts",
      ".js",
      ".mjs",
      ".cjs",
      ".vue",
      ".svelte",
      ".scss",
      ".sass",
      ".less",
      ".css",
      ".html",
      ".json",
      ".md",
      ".mdx",
      ".kt",
      ".kts",
      ".xml",
      ".gradle",
      ".rs",
      ".go",
      ".java",
      ".c",
      ".cpp",
      ".h",
      ".sh",
      ".zsh",
      ".bash",
      ".sql",
      ".prisma",
      ".csv",
      ".log",
      ".env",
      ".toml",
      ".lock",
      ".dockerfile",
      ".gitignore",
      "Dockerfile",
    ].join(","),
  ];

  if (capabilities.includes("image")) {
    accepts.unshift("image/*");
  }

  return accepts.join(",");
}

function confirmSensitiveAttachmentPreviews(previews: AttachmentPreviewPayload[]) {
  const sensitivePreviews = previews.filter((preview) => preview.isSensitive);

  if (sensitivePreviews.length === 0) {
    return {
      previews,
      rejectedMessage: null,
    };
  }

  const names = sensitivePreviews.map((preview) => preview.name).join(", ");
  const didConfirm = window.confirm(
    `The selected attachment may contain credentials or environment secrets: ${names}. Attach it anyway?`,
  );

  if (didConfirm) {
    return {
      previews,
      rejectedMessage: null,
    };
  }

  return {
    previews: previews.filter((preview) => !preview.isSensitive),
    rejectedMessage: "Sensitive attachments were skipped.",
  };
}

export async function pickAttachmentPreviews(
  projectId: string,
  capabilities: ModelCapability[],
) {
  const selected = await open({
    filters: [
      {
        name: "Supported files",
        extensions: capabilities.includes("image")
          ? [...TEXT_FILE_EXTENSIONS, ...IMAGE_FILE_EXTENSIONS]
          : TEXT_FILE_EXTENSIONS,
      },
    ],
    multiple: true,
    title: "Attach files",
  });

  const paths = normalizeSelectedPaths(selected);

  if (paths.length === 0) {
    return {
      previews: [] as PreviewFile[],
      selectedCount: 0,
    };
  }

  const payloads = await invoke<AttachmentPreviewPayload[]>("read_attachment_previews", {
    capabilities,
    paths,
    projectId,
  });
  const rejectedMessages = payloads
    .filter((preview) => typeof preview.error === "string" && preview.error.trim().length > 0)
    .map((preview) => preview.error!.trim());
  const confirmed = confirmSensitiveAttachmentPreviews(
    payloads.filter((preview) => !preview.error),
  );

  if (confirmed.rejectedMessage) {
    rejectedMessages.push(confirmed.rejectedMessage);
  }

  return {
    previews: confirmed.previews.map((preview) => ({
      ...preview,
      id: buildAttachmentId(buildPreviewIdentity(preview)),
    })),
    rejectedMessages,
    selectedCount: paths.length,
  };
}

export async function loadPreviewFilesFromPaths(sources: FilePreviewSource[]) {
  const previews = await Promise.all(
    sources.map(async (source) => {
      const payloads = await invoke<AttachmentPreviewPayload[]>("read_attachment_previews", {
        capabilities: ["image"],
        paths: [source.path],
        projectId: source.projectId,
      });
      const preview = payloads[0];

      if (!preview) {
        return null;
      }

      if (preview.error?.trim()) {
        return {
          content: preview.error,
          id: buildAttachmentId(source.path),
          kind: "other",
          name: preview.name,
          path: normalizePath(source.path),
          summary: preview.error,
        } satisfies PreviewFile;
      }

      return {
        ...preview,
        id: buildAttachmentId(source.path),
        path: normalizePath(source.path),
        summary: source.summary ?? preview.summary,
      } satisfies PreviewFile;
    }),
  );

  return previews.filter((preview): preview is PreviewFile => Boolean(preview));
}

export async function buildAttachmentPreviewFromBytes(input: {
  capabilities: ModelCapability[];
  bytes: Uint8Array;
  name: string;
  virtualPath: string;
}) {
  const payload = await invoke<AttachmentPreviewPayload | null>("build_attachment_preview_from_bytes", {
    bytes: Array.from(input.bytes),
    capabilities: input.capabilities,
    name: input.name,
    virtualPath: input.virtualPath,
  });

  if (!payload) {
    return null;
  }

  const confirmed = confirmSensitiveAttachmentPreviews([payload]);

  if (confirmed.previews.length === 0) {
    return null;
  }

  return {
    ...confirmed.previews[0]!,
    id: buildAttachmentId(buildPreviewIdentity(confirmed.previews[0]!)),
  } satisfies PreviewFile;
}

export { MAX_IMAGE_ATTACHMENT_SOURCE_BYTES, MAX_TEXT_ATTACHMENT_BYTES };
