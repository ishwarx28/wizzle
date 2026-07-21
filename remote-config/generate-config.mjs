import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const providerDir = join(root, "providers");
const promptDir = join(root, "prompts");
const baseUrl = "https://raw.githubusercontent.com/ishwarx28/wizzle/main/remote-config";
const modelsDevUrl = "https://models.dev/api.json";
const appPackagePath = join(root, "..", "wizzle-agent", "package.json");

const quote = (value) => JSON.stringify(String(value));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function yaml(value, depth = 0) {
  const indent = "  ".repeat(depth);
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return quote(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((entry) => ["string", "number", "boolean"].includes(typeof entry))) {
      return `[${value.map((entry) => yaml(entry)).join(", ")}]`;
    }
    return value
      .map((entry) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const lines = yaml(entry, depth + 1).split("\n");
          return `${indent}- ${lines[0].trimStart()}${lines.length > 1 ? `\n${lines.slice(1).join("\n")}` : ""}`;
        }
        return `${indent}- ${yaml(entry, depth + 1)}`;
      })
      .join("\n");
  }
  if (Object.keys(value).length === 0) return "{}";
  return Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => {
      const isInlineArray =
        Array.isArray(entry) &&
        entry.every((value) => ["string", "number", "boolean"].includes(typeof value));
      const isEmptyObject =
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.keys(entry).length === 0;
      if (
        entry &&
        typeof entry === "object" &&
        !isInlineArray &&
        !isEmptyObject &&
        (!Array.isArray(entry) || entry.length > 0)
      ) {
        return `${indent}${key}:\n${yaml(entry, depth + 1)}`;
      }
      return `${indent}${key}: ${yaml(entry, depth + 1)}`;
    })
    .join("\n");
}

const replayOpenAi = {
  variants: [],
  replay: {
    scope: "active_tool_loop",
    preserveExactly: true,
    capture: [
      {
        responsePath: "/choices/*/delta/reasoning_content",
        assistantMessagePath: "/reasoning_content",
        operation: "append",
      },
      {
        responsePath: "/choices/*/delta/reasoning",
        assistantMessagePath: "/reasoning",
        operation: "append",
      },
    ],
  },
};

const replayAnthropic = {
  variants: [],
  replay: {
    scope: "active_tool_loop",
    preserveExactly: true,
    capture: [
      {
        responsePath: "/content_block",
        assistantMessagePath: "/content/{/index}",
        operation: "merge",
        when: { responsePath: "/content_block/type", equals: "thinking" },
      },
      {
        responsePath: "/delta/thinking",
        assistantMessagePath: "/content/{/index}/thinking",
        operation: "append",
        when: { responsePath: "/delta/type", equals: "thinking_delta" },
      },
      {
        responsePath: "/delta/signature",
        assistantMessagePath: "/content/{/index}/signature",
        operation: "append",
        when: { responsePath: "/delta/type", equals: "signature_delta" },
      },
    ],
  },
};

function effortRecipe({
  path = "/reasoning_effort",
  off = "none",
  values = ["low", "medium", "high"],
} = {}) {
  return {
    defaultVariantId: "default",
    variants: [
      ...(off
        ? [{ id: "off", label: "Off", request: [{ operation: "set", path, value: off }] }]
        : []),
      { id: "default", label: "Default", request: [] },
      ...values.map((value) => ({
        id: value,
        label: value === "xhigh" ? "Extra high" : `${value[0].toUpperCase()}${value.slice(1)}`,
        request: [{ operation: "set", path, value }],
      })),
    ],
    replay: replayOpenAi.replay,
  };
}

const reasoningRecipes = {
  "replay-openai": replayOpenAi,
  "replay-anthropic": replayAnthropic,
  "effort-low-high": effortRecipe({ off: null }),
  "effort-none-high": effortRecipe(),
  "effort-minimal-high": effortRecipe({
    off: null,
    values: ["minimal", "low", "medium", "high"],
  }),
  "effort-extended": effortRecipe({ values: ["low", "medium", "high", "xhigh"] }),
  "openrouter-effort": effortRecipe({
    path: "/reasoning/effort",
    values: ["minimal", "low", "medium", "high", "xhigh", "max"],
  }),
  "thinking-type-toggle": {
    defaultVariantId: "default",
    variants: [
      {
        id: "off",
        label: "Off",
        request: [{ operation: "set", path: "/thinking/type", value: "disabled" }],
      },
      { id: "default", label: "Default", request: [] },
      {
        id: "on",
        label: "On",
        request: [{ operation: "set", path: "/thinking/type", value: "enabled" }],
      },
    ],
    replay: replayOpenAi.replay,
  },
  "qwen-thinking-budget": {
    defaultVariantId: "default",
    variants: [
      {
        id: "off",
        label: "Off",
        request: [{ operation: "set", path: "/enable_thinking", value: false }],
      },
      { id: "default", label: "Default", request: [] },
      ...[["low", 512], ["medium", 1024], ["high", 2048], ["xhigh", 4096], ["max", 8192]]
        .map(([id, budget]) => ({
          id,
          label: `${id === "xhigh" ? "Extra high" : `${id[0].toUpperCase()}${id.slice(1)}`} · ${budget} tokens`,
          request: [
            { operation: "set", path: "/enable_thinking", value: true },
            { operation: "set", path: "/thinking_budget", value: budget },
          ],
        })),
    ],
    replay: replayOpenAi.replay,
  },
  "deepseek-v4": {
    defaultVariantId: "default",
    variants: [
      {
        id: "off",
        label: "Off",
        request: [{ operation: "set", path: "/thinking/type", value: "disabled" }],
      },
      { id: "default", label: "Default", request: [] },
      {
        id: "high",
        label: "High",
        request: [
          { operation: "set", path: "/thinking/type", value: "enabled" },
          { operation: "set", path: "/reasoning_effort", value: "high" },
        ],
      },
      {
        id: "max",
        label: "Max",
        request: [
          { operation: "set", path: "/thinking/type", value: "enabled" },
          { operation: "set", path: "/reasoning_effort", value: "max" },
        ],
      },
    ],
    replay: replayOpenAi.replay,
  },
  "google-levels": {
    defaultVariantId: "default",
    variants: [
      { id: "default", label: "Default", request: [] },
      ...["LOW", "MEDIUM", "HIGH"].map((value) => ({
        id: value.toLowerCase(),
        label: `${value[0]}${value.slice(1).toLowerCase()}`,
        request: [
          {
            operation: "set",
            path: "/generationConfig/thinkingConfig/thinkingLevel",
            value,
          },
          {
            operation: "set",
            path: "/generationConfig/thinkingConfig/includeThoughts",
            value: true,
          },
        ],
      })),
    ],
  },
  "anthropic-adaptive": {
    defaultVariantId: "default",
    variants: [
      { id: "default", label: "Default", request: [] },
      ...["low", "medium", "high", "max"].map((value) => ({
        id: value,
        label: `${value[0].toUpperCase()}${value.slice(1)}`,
        request: [
          { operation: "set", path: "/thinking/type", value: "adaptive" },
          { operation: "set", path: "/output_config/effort", value },
        ],
      })),
    ],
    replay: replayAnthropic.replay,
  },
  "nvidia-ultra": {
    defaultVariantId: "default",
    variants: [
      {
        id: "off",
        label: "Off",
        request: [{
          operation: "set",
          path: "/chat_template_kwargs/enable_thinking",
          value: false,
        }],
      },
      { id: "default", label: "Default", request: [] },
      ...[["low", 512], ["medium", 1024], ["high", 2048], ["max", 8192]]
        .map(([id, budget]) => ({
          id,
          label: `${id[0].toUpperCase()}${id.slice(1)} · ${budget} tokens`,
          request: [
            {
              operation: "set",
              path: "/chat_template_kwargs/enable_thinking",
              value: true,
            },
            { operation: "set", path: "/reasoning_budget", value: budget },
          ],
        })),
    ],
    replay: replayOpenAi.replay,
  },
};

const bearer = (required = true) => ({
  mode: "api_key",
  required,
  location: "header",
  name: "Authorization",
  prefix: "Bearer ",
});
const headerKey = (name) => ({
  mode: "api_key",
  required: true,
  location: "header",
  name,
  prefix: "",
});

const isOpenCodeChatCompletionsModel = (model) =>
  !/^(claude-|gemini-|gpt-|qwen)/.test(model.id.toLowerCase());

const specs = [
  { id: "opencode", source: "opencode", name: "OpenCode", endpoint: "https://opencode.ai/zen/v1", auth: bearer(false), defaults: ["deepseek-v4-flash-free"], modelFilter: isOpenCodeChatCompletionsModel },
  { id: "nvidia-build", source: "nvidia", name: "NVIDIA Build", endpoint: "https://integrate.api.nvidia.com/v1", auth: bearer(), defaults: ["nvidia/nemotron-3-ultra-550b-a55b", "nemotron-3-ultra-550b-a55b"] },
  { id: "openrouter", source: "openrouter", name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", auth: bearer(), defaults: ["anthropic/claude-sonnet-4.6", "openai/gpt-5.4"] },
  { id: "ollama", name: "Ollama", endpoint: "http://localhost:11434/v1", auth: { mode: "none" }, catalogMode: "provider_api", defaults: ["qwen3.5:4b"] },
  { id: "lm-studio", name: "LM Studio", endpoint: "http://localhost:1234/v1", auth: { mode: "none" }, catalogMode: "provider_api", defaults: ["qwen3.5-4b-mlx"] },
  { id: "kilo", source: "kilo", name: "Kilo", endpoint: "https://api.kilo.ai/api/gateway", auth: bearer(), defaults: ["kilo-auto/free"] },
  { id: "groq", source: "groq", name: "Groq", endpoint: "https://api.groq.com/openai/v1", auth: bearer(), defaults: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"] },
  { id: "kimi", source: "kimi-for-coding", name: "Kimi", endpoint: "https://api.kimi.com/coding/v1", transport: "anthropic_messages", auth: headerKey("x-api-key"), defaults: ["k2p6", "k2p5"] },
  { id: "deepseek", source: "deepseek", name: "DeepSeek", endpoint: "https://api.deepseek.com", auth: bearer(), defaults: ["deepseek-chat"] },
  { id: "zai", source: "zai", name: "Z.AI", endpoint: "https://api.z.ai/api/paas/v4", auth: bearer(), defaults: ["glm-4.7", "glm-5"] },
  { id: "moonshot-ai", source: "moonshotai", name: "Moonshot AI", endpoint: "https://api.moonshot.ai/v1", auth: bearer(), defaults: ["kimi-k2.5", "kimi-k2-thinking"] },
  { id: "sarvam", source: "sarvam", name: "Sarvam AI", endpoint: "https://api.sarvam.ai/v1", auth: bearer(), defaults: ["sarvam-105b", "sarvam-30b"] },
  { id: "agnes-ai", name: "Agnes AI", endpoint: "https://apihub.agnes-ai.com/v1", auth: bearer(), defaults: ["agnes-2.0-flash"] },
  { id: "gemini", source: "google", name: "Google Gemini", endpoint: "https://generativelanguage.googleapis.com", transport: "google_generate_content", auth: headerKey("x-goog-api-key"), defaults: ["gemini-3.5-flash", "gemini-3.1-pro"] },
  { id: "meta", source: "meta", name: "Meta", endpoint: "https://api.meta.ai/v1", auth: bearer(), defaults: [] },
  { id: "anthropic", source: "anthropic", name: "Anthropic", endpoint: "https://api.anthropic.com", transport: "anthropic_messages", auth: headerKey("x-api-key"), defaults: ["claude-sonnet-4-6", "claude-opus-4-6"] },
  { id: "alibaba", source: "alibaba", name: "Alibaba", endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", auth: bearer(), defaults: ["qwen3.5-plus", "qwen3-coder-plus"] },
  { id: "cloudflare-workers-ai", source: "cloudflare-workers-ai", name: "Cloudflare Workers AI", endpoint: "https://api.cloudflare.com/client/v4/accounts/{{accountId}}/ai/v1", auth: bearer(), setupFields: [{ id: "accountId", label: "Cloudflare account ID", required: true, secret: false }], defaults: [] },
  { id: "xai", source: "xai", name: "xAI", endpoint: "https://api.x.ai/v1", auth: bearer(), defaults: ["grok-4.3", "grok-4"] },
  { id: "mistral", source: "mistral", name: "Mistral", endpoint: "https://api.mistral.ai/v1", auth: bearer(), defaults: ["devstral-medium-latest", "mistral-medium-latest"] },
  { id: "cohere", source: "cohere", name: "Cohere", endpoint: "https://api.cohere.ai/compatibility/v1", auth: bearer(), defaults: ["command-a-03-2025"] },
  { id: "cerebras", source: "cerebras", name: "Cerebras", endpoint: "https://api.cerebras.ai/v1", auth: bearer(), defaults: ["gpt-oss-120b"] },
  { id: "fireworks-ai", source: "fireworks-ai", name: "Fireworks AI", endpoint: "https://api.fireworks.ai/inference/v1", auth: bearer(), defaults: ["accounts/fireworks/models/deepseek-v4-flash"] },
  { id: "github-models", source: "github-models", name: "GitHub Models", endpoint: "https://models.github.ai/inference", auth: bearer(), defaults: ["openai/gpt-5", "anthropic/claude-sonnet-4"] },
  { id: "hugging-face", source: "huggingface", name: "Hugging Face", endpoint: "https://router.huggingface.co/v1", auth: bearer(), defaults: [] },
  { id: "openai", source: "openai", name: "OpenAI", endpoint: "https://api.openai.com/v1", auth: bearer(), defaults: ["gpt-5.4", "gpt-5.2"] },
  { id: "ollama-cloud", source: "ollama-cloud", name: "Ollama Cloud", endpoint: "https://ollama.com/v1", auth: bearer(), defaults: [] },
];

const localModels = {
  ollama: [
    ["qwen3.5:4b", "Qwen 3.5 4B"],
    ["qwen3:8b", "Qwen 3 8B"],
    ["deepseek-r1:8b", "DeepSeek R1 8B"],
    ["gemma3:12b", "Gemma 3 12B"],
    ["gpt-oss:20b", "GPT OSS 20B"],
    ["llama3.3:70b", "Llama 3.3 70B"],
  ],
  "lm-studio": [
    ["qwen3.5-4b-mlx", "Qwen 3.5 4B MLX"],
    ["qwen3-8b", "Qwen 3 8B"],
    ["deepseek-r1-8b", "DeepSeek R1 8B"],
    ["gemma-3-12b", "Gemma 3 12B"],
    ["gpt-oss-20b", "GPT OSS 20B"],
  ],
  "agnes-ai": [["agnes-2.0-flash", "Agnes 2.5 Flash"]],
};

const localProviderIds = new Set(["ollama", "lm-studio"]);

const providerWideFreeTierIds = new Set([
  "nvidia-build",
  "groq",
  "mistral",
  "cloudflare-workers-ai",
  "github-models",
  "hugging-face",
  "ollama-cloud",
]);

const freeTierModelIds = {
  gemini: new Set([
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.5-flash",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
  ]),
  zai: new Set(["glm-4.7-flash"]),
  cerebras: new Set(["gpt-oss-120b", "zai-glm-4.7"]),
  cohere: new Set([
    "command-a-03-2025",
    "command-a-plus-05-2026",
    "command-a-reasoning-08-2025",
    "command-a-translate-08-2025",
    "command-r-08-2024",
    "command-r-plus-08-2024",
    "command-r7b-12-2024",
    "command-r7b-arabic-02-2025",
  ]),
};

function isFreeTierModel(spec, modelId) {
  if (localProviderIds.has(spec.id)) return false;
  if (providerWideFreeTierIds.has(spec.id)) return true;

  const id = modelId.toLowerCase();
  if (freeTierModelIds[spec.id]?.has(id)) return true;
  if (spec.id === "opencode") return id === "big-pickle" || id.endsWith("-free");
  if (spec.id === "openrouter") return id === "openrouter/free" || id.endsWith(":free");
  if (spec.id === "kilo") return id.endsWith(":free") || id.endsWith("/free");
  return false;
}

function modelDisplayName(spec, modelId, displayName) {
  if (!isFreeTierModel(spec, modelId)) return displayName;
  const normalized = displayName
    .replace(/\s+\(free\)$/i, "")
    .replace(/\s+free$/i, "")
    .trimEnd();
  return `${normalized} (free)`;
}

function validateFreeTierLabels(spec, models) {
  for (const model of models) {
    const isLabelledFree = model.displayName.endsWith(" (free)");
    if (isLabelledFree !== isFreeTierModel(spec, model.modelId)) {
      throw new Error(`Incorrect free-tier label for ${spec.id}/${model.modelId}`);
    }
  }
}

function reasoningRef(spec, model) {
  if (!model.reasoning) return undefined;
  const id = model.id.toLowerCase();
  if (spec.id === "openrouter") return "openrouter-effort";
  if (spec.id === "opencode") {
    if (["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-free", "deepseek-v4-pro-free"].includes(id)) return "deepseek-v4";
    return "replay-openai";
  }
  if (spec.id === "nvidia-build") {
    if (id.includes("nemotron-3-ultra") || id.includes("nemotron-3-super")) return "nvidia-ultra";
    if (id.includes("gpt-oss")) return "effort-low-high";
    return "replay-openai";
  }
  if (spec.id === "deepseek") return id.startsWith("deepseek-v4") ? "deepseek-v4" : "replay-openai";
  if (spec.id === "zai" || spec.id === "moonshot-ai") return "thinking-type-toggle";
  if (spec.id === "alibaba") return id.startsWith("qwen") || id.startsWith("qwq") ? "qwen-thinking-budget" : "replay-openai";
  if (spec.id === "groq" || spec.id === "cerebras") return id.includes("gpt-oss") ? "effort-low-high" : "replay-openai";
  if (spec.id === "openai") {
    if (/^gpt-5\.[2-6](?!-pro)/.test(id) || id.startsWith("codex-max")) return "effort-extended";
    if (/^gpt-5(?!\.[1-6]|-pro)/.test(id)) return "effort-minimal-high";
    if (/^(o1|o3|o4|codex|gpt-oss)/.test(id)) return "effort-low-high";
    return "replay-openai";
  }
  if (spec.id === "anthropic") {
    return /claude-(opus|sonnet)-4-[6-9]|claude-(sonnet|opus)-5/.test(id)
      ? "anthropic-adaptive"
      : "replay-anthropic";
  }
  if (spec.id === "gemini") return id.startsWith("gemini-3") ? "google-levels" : undefined;
  if (spec.transport === "anthropic_messages") return "replay-anthropic";
  return "replay-openai";
}

function capabilities(model) {
  const supported = new Set(["text", "image", "audio", "video"]);
  const input = model.modalities?.input ?? ["text"];
  const values = input.filter((entry) => supported.has(entry));
  return values.includes("text") ? values : ["text", ...values];
}

function configuredModels(spec, catalog) {
  if (localModels[spec.id]) {
    return localModels[spec.id].map(([modelId, displayName]) => ({
      modelId,
      displayName: modelDisplayName(spec, modelId, displayName),
      capabilities: ["text"],
      maxContext: 128000,
      maxOutputTokens: 8192,
      ...(spec.id === "lm-studio" ? { reasoningRef: "replay-openai" } : {}),
    }));
  }
  return Object.entries(catalog?.models ?? {})
    .map(([id, model]) => ({ id, ...model }))
    .filter((model) =>
      model.tool_call === true &&
      (model.modalities?.input ?? ["text"]).includes("text") &&
      (model.modalities?.output ?? ["text"]).includes("text") &&
      (spec.modelFilter?.(model) ?? true))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((model) => ({
      modelId: model.id,
      displayName: modelDisplayName(spec, model.id, model.name || model.id),
      capabilities: capabilities(model),
      maxContext: model.limit?.context > 0 ? model.limit.context : 128000,
      maxOutputTokens: model.limit?.output > 0 ? model.limit.output : 8192,
      reasoningRef: reasoningRef(spec, model),
    }));
}

function selectDefault(spec, models) {
  for (const candidate of spec.defaults) {
    if (models.some((model) => model.modelId === candidate)) return candidate;
  }
  return models[0]?.modelId;
}

const promptFiles = {
  system: "agent-system.txt",
  title: "title-system.txt",
  enhancement: "enhancement-system.txt",
  compaction: "compaction-system.txt",
  explorer: "explorer-system.txt",
  reviewer: "reviewer-system.txt",
  worker: "worker-system.txt",
  "final-response": "final-response-system.txt",
  "max-steps-final": "max-steps-final-system.txt",
  "context-pressure": "context-pressure-system.txt",
};

async function main() {
  await mkdir(providerDir, { recursive: true });
  await mkdir(promptDir, { recursive: true });
  const appPackage = JSON.parse(await readFile(appPackagePath, "utf8"));
  if (typeof appPackage.version !== "string" || !appPackage.version.trim()) {
    throw new Error("wizzle-agent/package.json must contain a version");
  }
  const response = await fetch(modelsDevUrl);
  if (!response.ok) throw new Error(`Models.dev returned HTTP ${response.status}`);
  const modelCatalog = await response.json();

  const promptIndex = {};
  for (const [id, fileName] of Object.entries(promptFiles)) {
    const content = await readFile(join(promptDir, fileName), "utf8");
    promptIndex[id] = { url: `${baseUrl}/prompts/${fileName}`, sha256: sha256(content) };
  }

  const providerIndex = [];
  for (const spec of specs) {
    const models = configuredModels(spec, spec.source ? modelCatalog[spec.source] : undefined);
    if (models.length === 0) throw new Error(`No models were generated for ${spec.id}`);
    validateFreeTierLabels(spec, models);
    const refs = new Set(models.map((model) => model.reasoningRef).filter(Boolean));
    const catalog = {
      schemaVersion: 1,
      revision: `models.dev-${new Date().toISOString().slice(0, 10)}`,
      source: spec.source
        ? { url: modelsDevUrl, providerId: spec.source }
        : { type: "local-curated" },
      provider: {
        id: spec.id,
        name: spec.name,
        transport: spec.transport ?? "openai_chat_completions",
        endpoint: spec.endpoint,
        routes: (spec.transport ?? "openai_chat_completions") === "openai_chat_completions"
          ? { chatCompletions: "/chat/completions", models: "/models" }
          : undefined,
        auth: spec.auth,
        setupFields: spec.setupFields ?? [],
        defaults: {
          modelId: selectDefault(spec, models),
          maxContext: 128000,
          maxOutputTokens: 8192,
        },
        modelCatalog: {
          mode: spec.catalogMode ?? "fixed",
          unknownModelPolicy: spec.catalogMode === "provider_api"
            ? "include_without_reasoning"
            : "exclude",
        },
        headers: [],
      },
      reasoningRecipes: Object.fromEntries(
        [...refs].sort().map((ref) => [ref, reasoningRecipes[ref]]),
      ),
      models,
    };
    const content = `# Generated from Models.dev plus Wizzle transport/reasoning metadata.\n${yaml(catalog)}\n`;
    const fileName = `${spec.id}.yaml`;
    await writeFile(join(providerDir, fileName), content);
    providerIndex.push({
      id: spec.id,
      name: spec.name,
      configUrl: `${baseUrl}/providers/${fileName}`,
      sha256: sha256(content),
    });
  }

  const appConfig = {
    schemaVersion: 1,
    revision: new Date().toISOString().slice(0, 10),
    developer: {
      name: "Ishwar Meghwal",
      email: "mrdev.288@gmail.com",
      links: [
        { id: "github", label: "GitHub", url: "https://github.com/ishwarx28" },
        {
          id: "linkedin",
          label: "LinkedIn",
          url: "https://www.linkedin.com/in/ishwar-meghwal/",
        },
      ],
    },
    update: {
      enabled: false,
      version: appPackage.version,
      status: "normal",
      note: "In-app updates are temporarily disabled until release signing is configured.",
      platforms: {
        macos: {
          url: "https://github.com/ishwarx28/wizzle/releases/download/main-build/Wizzle-macOS.dmg",
        },
        windows: {
          url: "https://github.com/ishwarx28/wizzle/releases/download/main-build/Wizzle-Windows.exe",
        },
        linux: {
          url: "https://github.com/ishwarx28/wizzle/releases/download/main-build/Wizzle-Linux.AppImage",
        },
      },
    },
    prompts: promptIndex,
    providers: providerIndex,
  };
  await writeFile(join(root, "app-config.yaml"), `${yaml(appConfig)}\n`);
}

await main();
