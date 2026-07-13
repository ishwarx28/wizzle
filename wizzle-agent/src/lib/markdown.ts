import DOMPurify from "dompurify";
import { Marked, Renderer, type Tokens } from "marked";
import markedKatex from "marked-katex-extension";
import markedShiki from "marked-shiki";
import remend from "remend";
import githubDarkDefault from "@shikijs/themes/github-dark-default";
import githubLightDefault from "@shikijs/themes/github-light-default";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import type { EffectiveTheme } from "../utils/theme";
import { normalizeNestedCodeFences } from "./markdown-normalization";

const SHIKI_THEME_BY_MODE: Record<EffectiveTheme, string> = {
  dark: "github-dark-default",
  light: "github-light-default",
};

const SHIKI_LANGUAGE_LOADERS = {
  bash: () => import("@shikijs/langs/bash").then((module) => module.default),
  c: () => import("@shikijs/langs/c").then((module) => module.default),
  cpp: () => import("@shikijs/langs/cpp").then((module) => module.default),
  csharp: () => import("@shikijs/langs/csharp").then((module) => module.default),
  css: () => import("@shikijs/langs/css").then((module) => module.default),
  diff: () => import("@shikijs/langs/diff").then((module) => module.default),
  dockerfile: () => import("@shikijs/langs/dockerfile").then((module) => module.default),
  go: () => import("@shikijs/langs/go").then((module) => module.default),
  html: () => import("@shikijs/langs/html").then((module) => module.default),
  java: () => import("@shikijs/langs/java").then((module) => module.default),
  javascript: () => import("@shikijs/langs/javascript").then((module) => module.default),
  json: () => import("@shikijs/langs/json").then((module) => module.default),
  jsx: () => import("@shikijs/langs/jsx").then((module) => module.default),
  kotlin: () => import("@shikijs/langs/kotlin").then((module) => module.default),
  markdown: () => import("@shikijs/langs/markdown").then((module) => module.default),
  "objective-c": () => import("@shikijs/langs/objective-c").then((module) => module.default),
  "objective-cpp": () => import("@shikijs/langs/objective-cpp").then((module) => module.default),
  powershell: () => import("@shikijs/langs/powershell").then((module) => module.default),
  python: () => import("@shikijs/langs/python").then((module) => module.default),
  ruby: () => import("@shikijs/langs/ruby").then((module) => module.default),
  rust: () => import("@shikijs/langs/rust").then((module) => module.default),
  sql: () => import("@shikijs/langs/sql").then((module) => module.default),
  svelte: () => import("@shikijs/langs/svelte").then((module) => module.default),
  swift: () => import("@shikijs/langs/swift").then((module) => module.default),
  toml: () => import("@shikijs/langs/toml").then((module) => module.default),
  tsx: () => import("@shikijs/langs/tsx").then((module) => module.default),
  typescript: () => import("@shikijs/langs/typescript").then((module) => module.default),
  vue: () => import("@shikijs/langs/vue").then((module) => module.default),
  yaml: () => import("@shikijs/langs/yaml").then((module) => module.default),
} as const;
const markedCache = new Map<string, Marked>();
const languageLoadPromises = new Map<string, Promise<void>>();
const unsupportedLanguageSet = new Set<string>();

const highlighterPromise = createHighlighterCore({
  engine: createJavaScriptRegexEngine(),
  langs: [],
  themes: [githubDarkDefault, githubLightDefault],
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
  const loadedLanguages = highlighter.getLoadedLanguages();
  if (loadedLanguages.includes(language)) {
    return true;
  }

  const loader = SHIKI_LANGUAGE_LOADERS[language as keyof typeof SHIKI_LANGUAGE_LOADERS];
  if (!loader) {
    unsupportedLanguageSet.add(language);
    return false;
  }

  let loadPromise = languageLoadPromises.get(language);
  if (!loadPromise) {
    loadPromise = highlighter.loadLanguage(loader).then(() => undefined);
    languageLoadPromises.set(language, loadPromise);
  }

  try {
    await loadPromise;
    return true;
  } catch {
    languageLoadPromises.delete(language);
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

  const renderer = new Renderer();
  const renderTable = renderer.table;
  renderer.table = function table(token: Tokens.Table) {
    return `<div class="markdown-table-wrap">${renderTable.call(this, token)}</div>`;
  };

  const parser = new Marked({ async: true, breaks: true, gfm: true, renderer }).use(
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
  const repairedContent = options.isStreaming
    ? remend(options.content, {
        inlineKatex: true,
        linkMode: "text-only",
      })
    : options.content;
  const preparedContent = normalizeNestedCodeFences(repairedContent);
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
