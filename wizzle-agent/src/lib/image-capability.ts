import type { ModelCapability, PreviewFile } from "../types/workspace";

export const IMAGE_MODEL_REQUIRED_ERROR =
  "The selected model does not support images. Choose an image-capable model or remove image attachments.";

export const IMAGE_READ_DISABLED_ERROR =
  "This model does not support images. Image files cannot be read with the current model.";

export function modelSupportsImages(capabilities: ModelCapability[] | null | undefined) {
  return (capabilities ?? []).includes("image");
}

export function isImageAttachment(attachment: PreviewFile) {
  return attachment.kind === "image" || Boolean(attachment.imageSrc?.trim());
}

export function listImageAttachments(attachments: PreviewFile[] | null | undefined) {
  return (attachments ?? []).filter(isImageAttachment);
}

/**
 * Hard-fail guard for non-image models that somehow still have image attachments (#40).
 * Returns an error message, or null when OK.
 */
export function resolveImageAttachmentHardFailError(
  capabilities: ModelCapability[] | null | undefined,
  attachments: PreviewFile[] | null | undefined,
): string | null {
  if (modelSupportsImages(capabilities)) {
    return null;
  }

  if (listImageAttachments(attachments).length === 0) {
    return null;
  }

  return IMAGE_MODEL_REQUIRED_ERROR;
}

export function formatEnvironmentImageSupportLine(imageCapable: boolean) {
  return imageCapable ? "image: enabled" : "image: disabled";
}

export function resolveReadToolDescription(_imageCapable: boolean) {
  return "Read a file from a path. Prefer targeted line ranges to avoid unnecessary context when possible.";
}
