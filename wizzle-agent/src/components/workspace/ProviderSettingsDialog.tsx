import type { ChangeEvent } from "react";
import { useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, Pencil, Plus, RefreshCw, Trash2, Upload } from "lucide-react";

import {
  deleteProvider,
  importProviderYaml,
  listProviderModels,
  listProviders,
  refreshProviderModels,
  upsertProvider,
} from "../../lib/local-workspace";
import { useWorkspaceStore } from "../../store/workspace-store";
import type { ProviderInfo, ProviderModelInfo } from "../../types/workspace";

type ProviderSettingsPageProps = {
  onBack: () => void;
};

type ProviderModelFormRow = {
  capabilities: string;
  displayName: string;
  maxContext: string;
  maxOutputTokens: string;
  modelId: string;
  reasoningLevels: string;
  tokenizerKind: string;
};

const emptyModelRow: ProviderModelFormRow = {
  capabilities: "text",
  displayName: "",
  maxContext: "",
  maxOutputTokens: "",
  modelId: "",
  reasoningLevels: "low, medium, high, max",
  tokenizerKind: "",
};

function normalizeError(caughtError: unknown, fallback: string) {
  if (caughtError instanceof Error && caughtError.message.trim()) {
    return caughtError.message;
  }

  if (typeof caughtError === "string" && caughtError.trim()) {
    return caughtError;
  }

  return fallback;
}

function parseList(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseOptionalInteger(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function toModelInput(row: ProviderModelFormRow) {
  const modelId = row.modelId.trim();

  if (!modelId) {
    return null;
  }

  return {
    capabilities: parseList(row.capabilities),
    displayName: row.displayName.trim() || undefined,
    maxContext: parseOptionalInteger(row.maxContext),
    maxOutputTokens: parseOptionalInteger(row.maxOutputTokens),
    modelId,
    reasoningLevels: parseList(row.reasoningLevels),
    tokenizerKind: row.tokenizerKind.trim() || undefined,
  };
}

function providerModelsForExport(provider: ProviderInfo, models: ProviderModelInfo[]) {
  return models
    .filter((model) => model.providerId === provider.id)
    .map((model) => ({
      capabilities: model.capabilities,
      displayName: model.displayName ?? undefined,
      maxContext: model.maxContext,
      maxOutputTokens: model.maxOutputTokens ?? undefined,
      modelId: model.modelId,
      reasoningLevels: model.reasoningLevels,
      tokenizerKind: model.tokenizerKind ?? undefined,
    }));
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function buildProvidersYaml(providers: ProviderInfo[], models: ProviderModelInfo[]) {
  const lines = [
    "# Exported by Wizzle. API keys are intentionally not included.",
    "providers:",
  ];

  for (const provider of providers) {
    lines.push(`  - name: ${yamlString(provider.name)}`);
    lines.push(`    providerType: ${yamlString(provider.providerType)}`);
    lines.push(`    endpoint: ${yamlString(provider.endpoint)}`);

    if (provider.defaultModelId) {
      lines.push(`    defaultModelId: ${yamlString(provider.defaultModelId)}`);
    }

    const providerModels = providerModelsForExport(provider, models);

    if (providerModels.length > 0) {
      lines.push("    models:");

      for (const model of providerModels) {
        lines.push(`      - modelId: ${yamlString(model.modelId)}`);

        if (model.displayName) {
          lines.push(`        displayName: ${yamlString(model.displayName)}`);
        }

        lines.push(`        maxContext: ${model.maxContext}`);

        if (model.maxOutputTokens) {
          lines.push(`        maxOutputTokens: ${model.maxOutputTokens}`);
        }

        if (model.capabilities.length > 0) {
          lines.push(`        capabilities: [${model.capabilities.map(yamlString).join(", ")}]`);
        }

        if (model.reasoningLevels.length > 0) {
          lines.push(`        reasoningLevels: [${model.reasoningLevels.map(yamlString).join(", ")}]`);
        }

        if (model.tokenizerKind) {
          lines.push(`        tokenizerKind: ${yamlString(model.tokenizerKind)}`);
        }
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function downloadTextFile(fileName: string, content: string) {
  const blob = new Blob([content], { type: "application/yaml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ProviderSettingsPage({ onBack }: ProviderSettingsPageProps) {
  const providers = useWorkspaceStore((state) => state.providers);
  const providerModels = useWorkspaceStore((state) => state.providerModels);
  const setProviderConfig = useWorkspaceStore((state) => state.setProviderConfig);
  const [apiKey, setApiKey] = useState("");
  const [defaultModelId, setDefaultModelId] = useState("");
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState("https://api.openai.com");
  const [error, setError] = useState<string | null>(null);
  const [importUrl, setImportUrl] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [isRefreshingProviderId, setIsRefreshingProviderId] = useState<string | null>(null);
  const [modelRows, setModelRows] = useState<ProviderModelFormRow[]>([{ ...emptyModelRow }]);
  const [name, setName] = useState("OpenAI");
  const [onlySpecifiedModels, setOnlySpecifiedModels] = useState(false);
  const [providerType, setProviderType] = useState("openai_compatible");
  const [yaml, setYaml] = useState("");
  const yamlFileInputRef = useRef<HTMLInputElement | null>(null);

  const providerModelCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const model of providerModels) {
      counts.set(model.providerId, (counts.get(model.providerId) ?? 0) + 1);
    }

    return counts;
  }, [providerModels]);

  async function reloadProviderConfig() {
    const [nextProviders, nextModels] = await Promise.all([listProviders(), listProviderModels()]);
    setProviderConfig({ models: nextModels, providers: nextProviders });
  }

  function resetProviderForm() {
    setApiKey("");
    setDefaultModelId("");
    setEditingProviderId(null);
    setEndpoint("https://api.openai.com");
    setError(null);
    setModelRows([{ ...emptyModelRow }]);
    setName("OpenAI");
    setOnlySpecifiedModels(false);
    setProviderType("openai_compatible");
  }

  function editProvider(provider: ProviderInfo) {
    const models = providerModels.filter((model) => model.providerId === provider.id);

    setApiKey("");
    setDefaultModelId(provider.defaultModelId ?? "");
    setEditingProviderId(provider.id);
    setEndpoint(provider.endpoint);
    setError(null);
    setModelRows(
      models.length > 0
        ? models.map((model) => ({
            capabilities: model.capabilities.join(", "),
            displayName: model.displayName ?? "",
            maxContext: String(model.maxContext),
            maxOutputTokens: model.maxOutputTokens ? String(model.maxOutputTokens) : "",
            modelId: model.modelId,
            reasoningLevels: model.reasoningLevels.join(", "),
            tokenizerKind: model.tokenizerKind ?? "",
          }))
        : [{ ...emptyModelRow }],
    );
    setName(provider.name);
    setOnlySpecifiedModels(false);
    setProviderType(provider.providerType);
  }

  async function handleSaveProvider() {
    if (isBusy) {
      return;
    }

    const models = modelRows.map(toModelInput).filter((model): model is NonNullable<typeof model> => Boolean(model));

    setError(null);
    setIsBusy(true);

    try {
      const providerId = await upsertProvider({
        apiKey: apiKey.trim() || undefined,
        defaultModelId: defaultModelId.trim() || undefined,
        endpoint,
        id: editingProviderId ?? undefined,
        models: models.length > 0 ? models : undefined,
        name,
        onlySpecifiedModels,
        providerType,
      });

      if (!onlySpecifiedModels) {
        await refreshProviderModels(providerId);
      }

      await reloadProviderConfig();
      resetProviderForm();
    } catch (caughtError) {
      setError(normalizeError(caughtError, "Provider could not be saved."));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRefresh(providerId: string) {
    setError(null);
    setIsRefreshingProviderId(providerId);

    try {
      await refreshProviderModels(providerId);
      await reloadProviderConfig();
    } catch (caughtError) {
      setError(normalizeError(caughtError, "Provider models could not be refreshed."));
    } finally {
      setIsRefreshingProviderId(null);
    }
  }

  async function handleDelete(providerId: string) {
    setError(null);

    try {
      await deleteProvider(providerId);
      await reloadProviderConfig();
    } catch (caughtError) {
      setError(normalizeError(caughtError, "Provider could not be deleted."));
    }
  }

  async function handleImportYaml(nextYaml: string, source: string) {
    if (!nextYaml.trim() || isBusy) {
      return;
    }

    setError(null);
    setIsBusy(true);

    try {
      await importProviderYaml(nextYaml, source);
      await reloadProviderConfig();
      setYaml("");
      setImportUrl("");
    } catch (caughtError) {
      setError(normalizeError(caughtError, "Provider YAML could not be imported."));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleYamlFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    try {
      await handleImportYaml(await file.text(), file.name);
    } catch {
      setError("Wizzle could not read that YAML file.");
    }
  }

  async function handleImportUrl() {
    if (!importUrl.trim() || isBusy) {
      return;
    }

    setError(null);
    setIsBusy(true);

    try {
      const response = await fetch(importUrl.trim());

      if (!response.ok) {
        throw new Error(`YAML URL returned HTTP ${response.status}.`);
      }

      await handleImportYaml(await response.text(), importUrl.trim());
    } catch (caughtError) {
      setError(normalizeError(caughtError, "Wizzle could not import that YAML URL."));
      setIsBusy(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-8" data-provider-dialog>
      <div className="mx-auto flex max-w-[1080px] flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <button
              className="mb-3 inline-flex items-center gap-2 rounded-full px-2 py-1 text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
              onClick={onBack}
              type="button"
            >
              <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
              <span className="text-[13px] font-medium leading-none tracking-normal">
                Back to chat
              </span>
            </button>
            <h1 className="text-[24px] font-semibold tracking-[-0.03em] text-[var(--color-text)]">
              Providers
            </h1>
            <p className="mt-1 text-[13px] text-[var(--color-text-secondary)]">
              Configure local model providers. API keys stay in the desktop database and are never exported.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
              onClick={() => yamlFileInputRef.current?.click()}
              type="button"
            >
              <Upload className="h-3.5 w-3.5" />
              Import file
            </button>
            <input
              accept=".yaml,.yml,text/yaml,text/plain"
              className="hidden"
              onChange={(event) => {
                void handleYamlFileChange(event);
              }}
              ref={yamlFileInputRef}
              type="file"
            />
            <button
              className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
              onClick={() => downloadTextFile("wizzle-providers.yaml", buildProvidersYaml(providers, providerModels))}
              type="button"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </button>
          </div>
        </div>

        {error ? (
          <p className="rounded-2xl border border-[var(--color-danger)] px-3 py-2 text-[12px] text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {providers.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--color-border)] p-4 text-[13px] text-[var(--color-text-secondary)]">
              No providers configured.
            </div>
          ) : (
            providers.map((provider) => (
              <article
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-card)] p-4"
                key={provider.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-[15px] font-medium text-[var(--color-text)]">
                      {provider.name}
                    </h2>
                    <p className="mt-1 truncate text-[12px] text-[var(--color-text-tertiary)]">
                      {provider.providerType}
                    </p>
                  </div>
                  <span className="rounded-full border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)]">
                    {providerModelCounts.get(provider.id) ?? provider.modelCount} models
                  </span>
                </div>
                <p className="mt-3 truncate text-[12px] text-[var(--color-text-secondary)]">
                  {provider.endpoint}
                </p>
                <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">
                  API key: {provider.hasApiKey ? "Stored locally" : "Not set"}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                    onClick={() => editProvider(provider)}
                    type="button"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </button>
                  <button
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
                    disabled={isRefreshingProviderId === provider.id}
                    onClick={() => {
                      void handleRefresh(provider.id);
                    }}
                    type="button"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {isRefreshingProviderId === provider.id ? "Refreshing" : "Refresh"}
                  </button>
                  <button
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)] px-3 text-[12px] text-[var(--color-danger)] transition hover:bg-[var(--color-panel-hover)] disabled:opacity-50"
                    onClick={() => {
                      void handleDelete(provider.id);
                    }}
                    type="button"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                </div>
              </article>
            ))
          )}
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-card)] p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[15px] font-medium text-[var(--color-text)]">
                {editingProviderId ? "Edit provider" : "Add provider"}
              </h2>
              {editingProviderId ? (
                <button
                  className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                  onClick={resetProviderForm}
                  type="button"
                >
                  <Plus className="h-3 w-3" />
                  New provider
                </button>
              ) : null}
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <input className="h-10 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)]" onChange={(event) => setName(event.currentTarget.value)} placeholder="Provider name" value={name} />
              <select className="h-10 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)]" onChange={(event) => setProviderType(event.currentTarget.value)} value={providerType}>
                <option value="openai_compatible">OpenAI compatible</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
              </select>
              <input className="h-10 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)] md:col-span-2" onChange={(event) => setEndpoint(event.currentTarget.value)} placeholder="https://api.openai.com" value={endpoint} />
              <input className="h-10 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)]" onChange={(event) => setDefaultModelId(event.currentTarget.value)} placeholder="Default model ID" value={defaultModelId} />
              <input className="h-10 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)]" onChange={(event) => setApiKey(event.currentTarget.value)} placeholder={editingProviderId ? "New API key (blank keeps current)" : "API key"} type="password" value={apiKey} />
            </div>
            <label className="mt-3 flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
              <input checked={onlySpecifiedModels} onChange={(event) => setOnlySpecifiedModels(event.currentTarget.checked)} type="checkbox" />
              Use only the manually specified models below
            </label>

            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[12px] font-medium text-[var(--color-text-secondary)]">Manual models</p>
                <button className="rounded-full px-2 py-1 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]" onClick={() => setModelRows((rows) => [...rows, { ...emptyModelRow }])} type="button">Add model</button>
              </div>
              {modelRows.map((row, index) => (
                <div className="grid gap-2 rounded-2xl border border-[var(--color-border)] p-3 md:grid-cols-2" key={index}>
                  <input className="h-9 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[12px] text-[var(--color-text)] outline-none" onChange={(event) => setModelRows((rows) => rows.map((entry, rowIndex) => rowIndex === index ? { ...entry, modelId: event.currentTarget.value } : entry))} placeholder="modelId" value={row.modelId} />
                  <input className="h-9 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[12px] text-[var(--color-text)] outline-none" onChange={(event) => setModelRows((rows) => rows.map((entry, rowIndex) => rowIndex === index ? { ...entry, displayName: event.currentTarget.value } : entry))} placeholder="displayName" value={row.displayName} />
                  <input className="h-9 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[12px] text-[var(--color-text)] outline-none" onChange={(event) => setModelRows((rows) => rows.map((entry, rowIndex) => rowIndex === index ? { ...entry, maxContext: event.currentTarget.value } : entry))} placeholder="maxContext" value={row.maxContext} />
                  <input className="h-9 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[12px] text-[var(--color-text)] outline-none" onChange={(event) => setModelRows((rows) => rows.map((entry, rowIndex) => rowIndex === index ? { ...entry, maxOutputTokens: event.currentTarget.value } : entry))} placeholder="maxOutputTokens" value={row.maxOutputTokens} />
                  <input className="h-9 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[12px] text-[var(--color-text)] outline-none" onChange={(event) => setModelRows((rows) => rows.map((entry, rowIndex) => rowIndex === index ? { ...entry, capabilities: event.currentTarget.value } : entry))} placeholder="capabilities" value={row.capabilities} />
                  <input className="h-9 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[12px] text-[var(--color-text)] outline-none" onChange={(event) => setModelRows((rows) => rows.map((entry, rowIndex) => rowIndex === index ? { ...entry, reasoningLevels: event.currentTarget.value } : entry))} placeholder="reasoningLevels" value={row.reasoningLevels} />
                  <input className="h-9 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[12px] text-[var(--color-text)] outline-none" onChange={(event) => setModelRows((rows) => rows.map((entry, rowIndex) => rowIndex === index ? { ...entry, tokenizerKind: event.currentTarget.value } : entry))} placeholder="tokenizerKind" value={row.tokenizerKind} />
                  <button className="h-9 rounded-xl px-3 text-[12px] text-[var(--color-danger)] transition hover:bg-[var(--color-panel-hover)]" onClick={() => setModelRows((rows) => rows.length === 1 ? [{ ...emptyModelRow }] : rows.filter((_, rowIndex) => rowIndex !== index))} type="button">Remove</button>
                </div>
              ))}
            </div>

            <button className="mt-4 h-10 rounded-full bg-[var(--color-accent)] px-4 text-[14px] font-medium text-[var(--color-accent-foreground)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50" disabled={isBusy || !name.trim() || !endpoint.trim()} onClick={handleSaveProvider} type="button">
              {isBusy ? "Saving..." : editingProviderId ? "Save provider" : "Add provider"}
            </button>
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-card)] p-4">
              <h2 className="text-[15px] font-medium text-[var(--color-text)]">Import YAML</h2>
              <textarea className="mt-3 min-h-[160px] w-full resize-y rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 py-2 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)]" onChange={(event) => setYaml(event.currentTarget.value)} placeholder={"providers:\n  - name: OpenAI\n    providerType: openai_compatible\n    endpoint: https://api.openai.com\n    apiKey: sk-..."} value={yaml} />
              <button className="mt-3 h-9 rounded-full border border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] disabled:opacity-50" disabled={isBusy || !yaml.trim()} onClick={() => void handleImportYaml(yaml, "manual")} type="button">Import pasted YAML</button>
            </div>
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-card)] p-4">
              <h2 className="text-[15px] font-medium text-[var(--color-text)]">Import from URL</h2>
              <input className="mt-3 h-10 w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)]" onChange={(event) => setImportUrl(event.currentTarget.value)} placeholder="https://example.com/providers.yaml" value={importUrl} />
              <button className="mt-3 h-9 rounded-full border border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] disabled:opacity-50" disabled={isBusy || !importUrl.trim()} onClick={() => void handleImportUrl()} type="button">Import URL</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
