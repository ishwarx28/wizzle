import { writeImage, writeText as writeNativeText } from "@tauri-apps/plugin-clipboard-manager";

function fallbackCopyText(value: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  textarea.style.top = "0";
  textarea.style.left = "0";

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await writeNativeText(value);
    return true;
  } catch {
    // Fall back to browser clipboard APIs when Tauri is unavailable.
  }

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    return fallbackCopyText(value);
  }

  return fallbackCopyText(value);
}

async function fallbackCopyImage(blob: Blob): Promise<boolean> {
  if (typeof document === "undefined") {
    return false;
  }

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(blob);
    const wrapper = document.createElement("div");
    const image = document.createElement("img");
    image.src = objectUrl;
    wrapper.contentEditable = "true";
    wrapper.style.position = "fixed";
    wrapper.style.opacity = "0";
    wrapper.style.pointerEvents = "none";
    wrapper.style.top = "0";
    wrapper.style.left = "0";
    wrapper.appendChild(image);
    document.body.appendChild(wrapper);

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNode(wrapper);
    selection?.removeAllRanges();
    selection?.addRange(range);

    try {
      resolve(document.execCommand("copy"));
    } catch {
      resolve(false);
    } finally {
      selection?.removeAllRanges();
      document.body.removeChild(wrapper);
      URL.revokeObjectURL(objectUrl);
    }
  });
}

export async function copyImage(imageSrc: string): Promise<boolean> {
  try {
    const response = await fetch(imageSrc);
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());

    try {
      await writeImage(bytes);
      return true;
    } catch {
      // Fall back to browser clipboard APIs when Tauri is unavailable.
    }

    if (
      typeof ClipboardItem !== "undefined" &&
      typeof navigator !== "undefined" &&
      navigator.clipboard?.write
    ) {
      await navigator.clipboard.write([
        new ClipboardItem({
          [blob.type || "image/png"]: blob,
        }),
      ]);

      return true;
    }

    return fallbackCopyImage(blob);
  } catch {
    return false;
  }
}
