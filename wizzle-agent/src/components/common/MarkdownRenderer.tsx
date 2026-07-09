import morphdom from "morphdom";
import { useEffect, useRef, useState } from "react";
import "katex/dist/katex.min.css";

import { renderMarkdownToHtml } from "../../lib/markdown";
import { copyText } from "../../utils/clipboard";
import {
  getStoredThemePreference,
  getThemeChangeEventName,
  resolveEffectiveTheme,
} from "../../utils/theme";

interface MarkdownRendererProps {
  className?: string;
  content: string;
  streaming?: boolean;
}

export function MarkdownRenderer({ className, content, streaming = false }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderVersionRef = useRef(0);
  const [effectiveTheme, setEffectiveTheme] = useState(() =>
    resolveEffectiveTheme(getStoredThemePreference()),
  );

  useEffect(() => {
    function syncTheme() {
      setEffectiveTheme(resolveEffectiveTheme(getStoredThemePreference()));
    }

    window.addEventListener(getThemeChangeEventName(), syncTheme);

    return () => {
      window.removeEventListener(getThemeChangeEventName(), syncTheme);
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    let isCancelled = false;
    const renderVersion = renderVersionRef.current + 1;
    renderVersionRef.current = renderVersion;

    void renderMarkdownToHtml({
      content,
      isStreaming: streaming,
      theme: effectiveTheme,
    })
      .then((html) => {
        if (
          isCancelled ||
          renderVersion !== renderVersionRef.current ||
          !containerRef.current
        ) {
          return;
        }

        morphdom(containerRef.current, `<div>${html}</div>`, {
          childrenOnly: true,
          onBeforeElUpdated(fromEl, toEl) {
            if (fromEl.isEqualNode(toEl)) {
              return false;
            }

            return true;
          },
        });
      })
      .catch(() => {
        if (
          isCancelled ||
          renderVersion !== renderVersionRef.current ||
          !containerRef.current
        ) {
          return;
        }

        containerRef.current.textContent = content;
      });

    return () => {
      isCancelled = true;
    };
  }, [content, effectiveTheme, streaming]);

  return (
    <div
      className={["markdown-body", className].filter(Boolean).join(" ")}
      onClick={(event) => {
        const target = event.target as HTMLElement | null;
        const button = target?.closest<HTMLButtonElement>("[data-copy-code]");

        if (!button) {
          return;
        }

        event.preventDefault();

        const encodedCode = button.dataset.copyCode;

        if (!encodedCode) {
          return;
        }

        void copyText(decodeURIComponent(encodedCode)).then((didCopy) => {
          if (!didCopy) {
            return;
          }

          const originalText = button.textContent ?? "Copy";
          button.textContent = "Copied";
          button.disabled = true;

          window.setTimeout(() => {
            button.textContent = originalText;
            button.disabled = false;
          }, 1600);
        });
      }}
      ref={containerRef}
    />
  );
}
