import {
  formatEnvironmentImageSupportLine,
  IMAGE_MODEL_REQUIRED_ERROR,
  isImageAttachment,
  modelSupportsImages,
  resolveImageAttachmentHardFailError,
  resolveReadToolDescription,
} from "./image-capability.ts";
import type { PreviewFile } from "../types/workspace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function imageFile(): PreviewFile {
  return {
    id: "img-1",
    kind: "image",
    name: "shot.png",
    path: "/tmp/shot.png",
    summary: "image",
    imageSrc: "data:image/png;base64,abc",
  };
}

function main() {
  assert(modelSupportsImages(["text", "image"]), "image capable");
  assert(!modelSupportsImages(["text"]), "text only");
  assert(isImageAttachment(imageFile()), "detect image attachment");

  assert(
    resolveImageAttachmentHardFailError(["text"], [imageFile()]) === IMAGE_MODEL_REQUIRED_ERROR,
    "hard fail text model + image",
  );
  assert(
    resolveImageAttachmentHardFailError(["text", "image"], [imageFile()]) === null,
    "ok when capable",
  );
  assert(
    resolveImageAttachmentHardFailError(["text"], []) === null,
    "ok with no attachments",
  );

  assert(formatEnvironmentImageSupportLine(false) === "image: disabled", "env disabled");
  assert(formatEnvironmentImageSupportLine(true) === "image: enabled", "env enabled");
  const readDescription =
    "Read a file from a path. Prefer targeted line ranges to avoid unnecessary context when possible.";
  assert(resolveReadToolDescription(false) === readDescription, "text-only read description stays concise");
  assert(resolveReadToolDescription(true) === readDescription, "image-capable read description stays concise");

  console.log("image-capability tests passed");
}

main();
