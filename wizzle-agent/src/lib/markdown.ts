import DOMPurify from "dompurify";
import { Marked } from "marked";
import markedKatex from "marked-katex-extension";
import markedShiki from "marked-shiki";
import remend from "remend";
import { bundledLanguages, createHighlighter } from "shiki";

import type { EffectiveTheme } from "../utils/theme";

const SHIKI_THEME_BY_MODE: Record<EffectiveTheme, string> = {
  dark: "github-dark-default",
  light: "github-light-default",
};

const SHIKI_LANGUAGE_SET = new Set<string>(Object.keys(bundledLanguages));
const markedCache = new Map<string, Marked>();
const unsupportedLanguageSet = new Set<string>();

const highlighterPromise = createHighlighter({
  langs: [],
  themes: Object.values(SHIKI_THEME_BY_MODE),
});

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeLanguage(language: string) {
  const nextLanguage = language.trim().toLowerCase();

  switch (nextLanguage) {
    case "ts":
      return "typescript";
    case "js":
      return "javascript";
    case "py":
      return "python";
    case "rb":
      return "ruby";
    case "kt":
    case "kts":
      return "kotlin";
    case "c#":
    case "cs":
      return "csharp";
    case "c++":
      return "cpp";
    case "objc":
      return "objective-c";
    case "objcpp":
      return "objective-cpp";
    case "ps1":
      return "powershell";
    case "md":
      return "markdown";
    case "sh":
    case "shell":
    case "zsh":
      return "bash";
    case "yml":
      return "yaml";
    case "htm":
      return "html";
    default:
      return nextLanguage;
  }
}

function renderCodeContainer(code: string, language: string, bodyHtml: string) {
  return [
    `<div class="markdown-code-block" data-code-block data-language="${escapeHtml(language)}">`,
    '<div class="markdown-code-toolbar">',
    `<span class="markdown-code-language">${escapeHtml(language)}</span>`,
    `<button class="markdown-copy-button" type="button" data-copy-code="${escapeHtml(encodeURIComponent(code))}">Copy</button>`,
    "</div>",
    bodyHtml,
    "</div>",
  ].join("");
}

function renderPlainCodeBlock(code: string, language: string) {
  return renderCodeContainer(
    code,
    language,
    `<pre class="shiki shiki-plain"><code>${escapeHtml(code)}</code></pre>`,
  );
}

async function canHighlightLanguage(language: string) {
  if (language === "text") {
    return false;
  }

  if (unsupportedLanguageSet.has(language)) {
    return false;
  }

  const highlighter = await highlighterPromise;
  const resolvedLanguage = highlighter.resolveLangAlias(language);
  const loadedLanguages = highlighter.getLoadedLanguages();

  if (loadedLanguages.includes(language) || loadedLanguages.includes(resolvedLanguage)) {
    return true;
  }

  if (!SHIKI_LANGUAGE_SET.has(language) && !SHIKI_LANGUAGE_SET.has(resolvedLanguage)) {
    unsupportedLanguageSet.add(language);
    return false;
  }

  try {
    await highlighter.loadLanguage(resolvedLanguage as never);
    return true;
  } catch {
    unsupportedLanguageSet.add(language);
    return false;
  }
}

function createMarked(theme: EffectiveTheme, isStreaming: boolean) {
  const cacheKey = `${theme}:${isStreaming ? "streaming" : "settled"}`;
  const cached = markedCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const parser = new Marked({ async: true, breaks: true, gfm: true }).use(
    markedKatex({
      nonStandard: true,
      throwOnError: false,
    }),
    markedShiki({
      async highlight(code, language) {
        const normalizedLanguage = normalizeLanguage(language || "text");
        const languageLabel = normalizedLanguage === "text" ? "text" : normalizedLanguage;

        if (isStreaming || !(await canHighlightLanguage(normalizedLanguage))) {
          return renderPlainCodeBlock(code, languageLabel);
        }

        const highlighter = await highlighterPromise;
        const highlighted = highlighter.codeToHtml(code, {
          lang: normalizedLanguage,
          theme: SHIKI_THEME_BY_MODE[theme],
        });

        return renderCodeContainer(code, languageLabel, highlighted);
      },
    }),
  );

  markedCache.set(cacheKey, parser);
  return parser;
}

export async function renderMarkdownToHtml(options: {
  content: string;
  isStreaming?: boolean;
  theme: EffectiveTheme;
}) {
  const isStreaming = Boolean(options.isStreaming);
  const preparedContent = options.isStreaming
    ? remend(options.content, {
        inlineKatex: true,
        linkMode: "text-only",
      })
    : options.content;
  const parser = createMarked(options.theme, isStreaming);
  const html = await parser.parse(preparedContent, { async: true });

  return DOMPurify.sanitize(html, {
    ADD_ATTR: [
      "aria-hidden",
      "class",
      "data-copy-code",
      "data-language",
      "role",
      "style",
      "tabindex",
    ],
    FORBID_TAGS: ["script", "style"],
    USE_PROFILES: {
      html: true,
      mathMl: true,
      svg: true,
    },
  });
}
