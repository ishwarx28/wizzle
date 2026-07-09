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

export function resolveReadToolDescription(imageCapable: boolean) {
  if (imageCapable) {
    return "Read a text or image file from the selected project, or a markdown skill file from ~/.wizzle/skills/. You can request a specific line range for text files. If the file is an image (png, jpg, jpeg, gif, webp, bmp, svg, avif), the result includes the image data you can view and analyze.";
  }

  return "Read a text file from the selected project, or a markdown skill file from ~/.wizzle/skills/. You can request a specific line range. Image support is disabled for this model (see environment: image: disabled). Do not use read on image files (png, jpg, jpeg, gif, webp, bmp, svg, avif, etc.).";
}
