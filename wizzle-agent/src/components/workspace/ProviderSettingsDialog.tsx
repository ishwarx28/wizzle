import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Download,
  Eye,
  EyeOff,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";

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
import { AppDialog } from "../common/AppDialog";

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
  tokenizerJson: string;
  tokenizerKind: string;
};

type DialogState =
  | { type: "provider-form"; mode: "add" | "edit"; providerId?: string }
  | { type: "import-url"; value: string }
  | {
      type: "refresh-models";
      providerId: string;
      providerName: string;
      fetchAll: boolean;
      removeInvalid: boolean;
    };

const emptyModelRow: ProviderModelFormRow = {
  capabilities: "text",
  displayName: "",
  maxContext: "",
  maxOutputTokens: "",
  modelId: "",
  reasoningLevels: "low, medium, high, max",
  tokenizerJson: "",
  tokenizerKind: "",
};

const fieldClassName =
  "h-10 w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)]";

const modelFieldClassName =
  "h-9 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)]";

const headerButtonClassName =
  "inline-flex h-9 items-center gap-2 rounded-full border border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50";

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

/** Empty capabilities string is safe; backend re-defaults to `text` if omitted. */
function toModelInput(row: ProviderModelFormRow) {
  const modelId = row.modelId.trim();

  if (!modelId) {
    return null;
  }

  const capabilities = parseList(row.capabilities);

  return {
    // Prefer explicit list; empty means "use server default (text)" without crashing.
    capabilities: capabilities.length > 0 ? capabilities : ["text"],
    displayName: row.displayName.trim() || undefined,
    maxContext: parseOptionalInteger(row.maxContext),
    maxOutputTokens: parseOptionalInteger(row.maxOutputTokens),
    modelId,
    reasoningLevels: parseList(row.reasoningLevels),
    tokenizerJson: row.tokenizerJson.trim() || undefined,
    tokenizerKind: row.tokenizerKind.trim() || undefined,
  };
}

function isEmptyDraftRow(row: ProviderModelFormRow) {
  return (
    !row.modelId.trim() &&
    !row.displayName.trim() &&
    !row.maxContext.trim() &&
    !row.maxOutputTokens.trim() &&
    !row.tokenizerJson.trim() &&
    !row.tokenizerKind.trim() &&
    (row.capabilities.trim() === "" || row.capabilities.trim() === "text") &&
    (row.reasoningLevels.trim() === "" ||
      row.reasoningLevels.trim() === "low, medium, high, max")
  );
}

function providerModelsForExport(provider: ProviderInfo, models: ProviderModelInfo[]) {
  return models
    .filter((model) => model.providerId === provider.id)
    .map((model) => ({
      capabilities: model.capabilities ?? [],
      displayName: model.displayName ?? undefined,
      maxContext: model.maxContext,
      maxOutputTokens: model.maxOutputTokens ?? undefined,
      modelId: model.modelId,
      reasoningLevels: model.reasoningLevels ?? [],
      tokenizerJson: model.tokenizerJson ?? undefined,
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

    if (provider.tokenizerJson) {
      lines.push(`    tokenizerJson: ${yamlString(provider.tokenizerJson)}`);
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

        if (model.tokenizerJson) {
          lines.push(`        tokenizerJson: ${yamlString(model.tokenizerJson)}`);
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

function FieldLabel({ children }: { children: string }) {
  return <label className="mb-1 block text-[11px] font-medium text-[var(--color-text-tertiary)]">{children}</label>;
}

export function ProviderSettingsPage({ onBack }: ProviderSettingsPageProps) {
  const providers = useWorkspaceStore((state) => state.providers);
  const providerModels = useWorkspaceStore((state) => state.providerModels);
  const setProviderConfig = useWorkspaceStore((state) => state.setProviderConfig);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [defaultModelId, setDefaultModelId] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [endpoint, setEndpoint] = useState("https://api.openai.com");
  const [error, setError] = useState<string | null>(null);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [importMenuPosition, setImportMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [modelRows, setModelRows] = useState<ProviderModelFormRow[]>([{ ...emptyModelRow }]);
  const [name, setName] = useState("OpenAI");
  const [onlySpecifiedModels, setOnlySpecifiedModels] = useState(false);
  const [providerType, setProviderType] = useState("openai_compatible");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [tokenizerJson, setTokenizerJson] = useState("");
  const importButtonRef = useRef<HTMLButtonElement | null>(null);
  const yamlFileInputRef = useRef<HTMLInputElement | null>(null);

  const providerModelCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const model of providerModels) {
      counts.set(model.providerId, (counts.get(model.providerId) ?? 0) + 1);
    }

    return counts;
  }, [providerModels]);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setToastMessage(null);
    }, 2600);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [toastMessage]);

  useEffect(() => {
    if (!importMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (importButtonRef.current?.contains(target)) {
        return;
      }
      const menu = document.querySelector("[data-provider-import-menu]");
      if (menu?.contains(target)) {
        return;
      }
      setImportMenuOpen(false);
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setImportMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [importMenuOpen]);

  function showToast(message: string) {
    setToastMessage(message);
  }

  async function reloadProviderConfig() {
    const [nextProviders, nextModels] = await Promise.all([listProviders(), listProviderModels()]);
    setProviderConfig({ models: nextModels, providers: nextProviders });
  }

  function resetProviderForm() {
    setApiKey("");
    setApiKeyVisible(false);
    setDefaultModelId("");
    setEndpoint("https://api.openai.com");
    setError(null);
    setModelRows([{ ...emptyModelRow }]);
    setName("OpenAI");
    setOnlySpecifiedModels(false);
    setProviderType("openai_compatible");
    setTokenizerJson("");
  }

  function openAddProviderDialog() {
    resetProviderForm();
    setDialog({ type: "provider-form", mode: "add" });
  }

  function openEditProviderDialog(provider: ProviderInfo) {
    const models = providerModels.filter((model) => model.providerId === provider.id);

    setApiKey("");
    setApiKeyVisible(false);
    setDefaultModelId(provider.defaultModelId ?? "");
    setEndpoint(provider.endpoint);
    setError(null);
    setModelRows(
      models.length > 0
        ? models.map((model) => ({
            capabilities: (model.capabilities ?? ["text"]).join(", ") || "text",
            displayName: model.displayName ?? "",
            maxContext: String(model.maxContext ?? ""),
            maxOutputTokens: model.maxOutputTokens ? String(model.maxOutputTokens) : "",
            modelId: model.modelId,
            reasoningLevels: (model.reasoningLevels ?? []).join(", "),
            tokenizerJson: model.tokenizerJson ?? "",
            tokenizerKind: model.tokenizerKind ?? "",
          }))
        : [{ ...emptyModelRow }],
    );
    setName(provider.name);
    setOnlySpecifiedModels(false);
    setProviderType(provider.providerType);
    setTokenizerJson(provider.tokenizerJson ?? "");
    setDialog({ type: "provider-form", mode: "edit", providerId: provider.id });
  }

  function closeDialog() {
    setDialog(null);
    setApiKeyVisible(false);
  }

  async function handleSaveProvider() {
    if (isBusy || dialog?.type !== "provider-form") {
      return;
    }

    const editingProviderId = dialog.mode === "edit" ? dialog.providerId : undefined;
    const models = modelRows
      .map(toModelInput)
      .filter((model): model is NonNullable<typeof model> => Boolean(model));

    setError(null);
    setIsBusy(true);

    try {
      const providerId = await upsertProvider({
        apiKey: apiKey.trim() || undefined,
        defaultModelId: defaultModelId.trim() || undefined,
        endpoint,
        id: editingProviderId,
        models: models.length > 0 ? models : undefined,
        name,
        onlySpecifiedModels,
        providerType,
        tokenizerJson: tokenizerJson.trim() || undefined,
      });

      if (!onlySpecifiedModels) {
        // Default post-save refresh: fetch remote catalog without pruning customs.
        await refreshProviderModels(providerId, { fetchAll: true, removeInvalid: false });
      }

      await reloadProviderConfig();
      resetProviderForm();
      closeDialog();
      showToast(editingProviderId ? "Provider saved." : "Provider added.");
    } catch (caughtError) {
      setError(normalizeError(caughtError, "Provider could not be saved."));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleConfirmRefresh() {
    if (dialog?.type !== "refresh-models" || isRefreshing) {
      return;
    }

    if (!dialog.fetchAll && !dialog.removeInvalid) {
      closeDialog();
      return;
    }

    setError(null);
    setIsRefreshing(true);

    try {
      await refreshProviderModels(dialog.providerId, {
        fetchAll: dialog.fetchAll,
        removeInvalid: dialog.removeInvalid,
      });
      await reloadProviderConfig();
      closeDialog();
      showToast("Provider models refreshed.");
    } catch (caughtError) {
      setError(normalizeError(caughtError, "Provider models could not be refreshed."));
    } finally {
      setIsRefreshing(false);
    }
  }

  async function handleDelete(providerId: string) {
    setError(null);

    try {
      await deleteProvider(providerId);
      await reloadProviderConfig();
      showToast("Provider deleted.");
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
      showToast("Providers imported.");
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

  async function handleImportUrl(url: string) {
    if (!url.trim() || isBusy) {
      return;
    }

    setError(null);
    setIsBusy(true);

    try {
      const response = await fetch(url.trim());

      if (!response.ok) {
        throw new Error(`YAML URL returned HTTP ${response.status}.`);
      }

      await importProviderYaml(await response.text(), url.trim());
      await reloadProviderConfig();
      closeDialog();
      showToast("Providers imported.");
    } catch (caughtError) {
      setError(normalizeError(caughtError, "Wizzle could not import that YAML URL."));
    } finally {
      setIsBusy(false);
    }
  }

  function handleExport() {
    downloadTextFile("wizzle-providers.yaml", buildProvidersYaml(providers, providerModels));
    showToast("Providers exported.");
  }

  function openImportMenu() {
    const rect = importButtonRef.current?.getBoundingClientRect();
    if (!rect) {
      setImportMenuOpen(true);
      return;
    }

    setImportMenuPosition({ x: rect.right, y: rect.bottom + 6 });
    setImportMenuOpen((open) => !open);
  }

  const isSoleEmptyDraft =
    modelRows.length === 1 && isEmptyDraftRow(modelRows[0] ?? emptyModelRow);

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
              <span className="text-[13px] font-normal leading-none tracking-normal">
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
            <button className={headerButtonClassName} onClick={openAddProviderDialog} type="button">
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
            <button
              className={headerButtonClassName}
              onClick={openImportMenu}
              ref={importButtonRef}
              type="button"
            >
              <Upload className="h-3.5 w-3.5" />
              Import
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
            <button className={headerButtonClassName} onClick={handleExport} type="button">
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
              No providers configured. Use <span className="font-medium text-[var(--color-text)]">Add</span> or{" "}
              <span className="font-medium text-[var(--color-text)]">Import</span> to get started.
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
                    onClick={() => openEditProviderDialog(provider)}
                    type="button"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </button>
                  <button
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                    onClick={() => {
                      setDialog({
                        type: "refresh-models",
                        providerId: provider.id,
                        providerName: provider.name,
                        fetchAll: false,
                        removeInvalid: false,
                      });
                    }}
                    type="button"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Refresh
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
      </div>

      {importMenuOpen && importMenuPosition
        ? createPortal(
            <div
              className="fixed z-[350] min-w-[180px] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1.5 shadow-[0_18px_48px_rgba(0,0,0,0.28)]"
              data-provider-import-menu
              style={{
                left: Math.max(12, importMenuPosition.x - 180),
                top: importMenuPosition.y,
              }}
            >
              <button
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)]"
                onClick={() => {
                  setImportMenuOpen(false);
                  yamlFileInputRef.current?.click();
                }}
                type="button"
              >
                <Upload className="h-3.5 w-3.5 text-[var(--color-text-tertiary)]" />
                Import file
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)]"
                onClick={() => {
                  setImportMenuOpen(false);
                  setDialog({ type: "import-url", value: "" });
                }}
                type="button"
              >
                <Link2 className="h-3.5 w-3.5 text-[var(--color-text-tertiary)]" />
                Import from URL
              </button>
            </div>,
            document.body,
          )
        : null}

      {dialog?.type === "import-url" ? (
        <AppDialog
          actions={
            <>
              <button
                className="h-10 rounded-full px-4 text-[14px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={closeDialog}
                type="button"
              >
                Cancel
              </button>
              <button
                className="h-10 rounded-full bg-[var(--color-accent)] px-4 text-[14px] font-medium text-[var(--color-accent-foreground)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isBusy || !dialog.value.trim()}
                onClick={() => {
                  void handleImportUrl(dialog.value);
                }}
                type="button"
              >
                {isBusy ? "Importing..." : "Import"}
              </button>
            </>
          }
          description="Load a providers YAML document from an HTTPS URL."
          onClose={closeDialog}
          title="Import from URL"
        >
          <input
            autoFocus
            className={fieldClassName}
            onChange={(event) => setDialog({ ...dialog, value: event.currentTarget.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && dialog.value.trim() && !isBusy) {
                void handleImportUrl(dialog.value);
              }
            }}
            placeholder="https://example.com/providers.yaml"
            value={dialog.value}
          />
        </AppDialog>
      ) : null}

      {dialog?.type === "refresh-models" ? (
        <AppDialog
          actions={
            <>
              <button
                className="h-10 rounded-full px-4 text-[14px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={closeDialog}
                type="button"
              >
                Cancel
              </button>
              <button
                className="h-10 rounded-full bg-[var(--color-accent)] px-4 text-[14px] font-medium text-[var(--color-accent-foreground)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isRefreshing || (!dialog.fetchAll && !dialog.removeInvalid)}
                onClick={() => {
                  void handleConfirmRefresh();
                }}
                type="button"
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </>
          }
          description={`Choose how to sync models for ${dialog.providerName}. With nothing selected, refresh does nothing.`}
          onClose={closeDialog}
          title="Refresh models"
        >
          <div className="space-y-3">
            <label className="flex items-start gap-2.5 text-[13px] text-[var(--color-text-secondary)]">
              <input
                checked={dialog.fetchAll}
                className="mt-0.5"
                onChange={(event) =>
                  setDialog({ ...dialog, fetchAll: event.currentTarget.checked })
                }
                type="checkbox"
              />
              <span>
                <span className="font-medium text-[var(--color-text)]">Fetch all models</span>
                <span className="mt-0.5 block text-[12px] text-[var(--color-text-tertiary)]">
                  Upsert every model returned by the provider catalog.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 text-[13px] text-[var(--color-text-secondary)]">
              <input
                checked={dialog.removeInvalid}
                className="mt-0.5"
                onChange={(event) =>
                  setDialog({ ...dialog, removeInvalid: event.currentTarget.checked })
                }
                type="checkbox"
              />
              <span>
                <span className="font-medium text-[var(--color-text)]">Remove invalid models</span>
                <span className="mt-0.5 block text-[12px] text-[var(--color-text-tertiary)]">
                  Drop local models that are not present on the remote catalog.
                </span>
              </span>
            </label>
          </div>
        </AppDialog>
      ) : null}

      {dialog?.type === "provider-form" ? (
        <AppDialog
          actions={
            <>
              <button
                className="h-10 rounded-full px-4 text-[14px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={() => {
                  resetProviderForm();
                  closeDialog();
                }}
                type="button"
              >
                Cancel
              </button>
              <button
                className="h-10 rounded-full bg-[var(--color-accent)] px-4 text-[14px] font-medium text-[var(--color-accent-foreground)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isBusy || !name.trim() || !endpoint.trim()}
                onClick={() => {
                  void handleSaveProvider();
                }}
                type="button"
              >
                {isBusy ? "Saving..." : dialog.mode === "edit" ? "Save provider" : "Add provider"}
              </button>
            </>
          }
          description={
            dialog.mode === "edit"
              ? "Update endpoint, models, and optional tokenizer settings."
              : "Add an OpenAI-compatible or other local provider."
          }
          onClose={() => {
            resetProviderForm();
            closeDialog();
          }}
          size="wide"
          title={dialog.mode === "edit" ? "Edit provider" : "Add provider"}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <FieldLabel>Provider name</FieldLabel>
              <input
                className={fieldClassName}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="OpenAI"
                value={name}
              />
            </div>
            <div>
              <FieldLabel>Provider type</FieldLabel>
              <select
                className={fieldClassName}
                onChange={(event) => setProviderType(event.currentTarget.value)}
                value={providerType}
              >
                <option value="openai_compatible">OpenAI compatible</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <FieldLabel>Endpoint</FieldLabel>
              <input
                className={fieldClassName}
                onChange={(event) => setEndpoint(event.currentTarget.value)}
                placeholder="https://api.openai.com"
                value={endpoint}
              />
            </div>
            <div>
              <FieldLabel>Default model ID</FieldLabel>
              <input
                className={fieldClassName}
                onChange={(event) => setDefaultModelId(event.currentTarget.value)}
                placeholder="gpt-4o"
                value={defaultModelId}
              />
            </div>
            <div>
              <FieldLabel>API key</FieldLabel>
              <div className="relative">
                <input
                  className={`${fieldClassName} pr-11`}
                  onChange={(event) => setApiKey(event.currentTarget.value)}
                  placeholder={
                    dialog.mode === "edit" ? "New API key (blank keeps current)" : "API key"
                  }
                  type={apiKeyVisible ? "text" : "password"}
                  value={apiKey}
                />
                <button
                  aria-label={apiKeyVisible ? "Hide API key" : "Show API key"}
                  className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                  onClick={() => setApiKeyVisible((visible) => !visible)}
                  type="button"
                >
                  {apiKeyVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
            <div className="md:col-span-2">
              <FieldLabel>Provider tokenizer.json (optional)</FieldLabel>
              <input
                className={fieldClassName}
                onChange={(event) => setTokenizerJson(event.currentTarget.value)}
                placeholder="Local path or HTTPS URL"
                value={tokenizerJson}
              />
              <p className="mt-1.5 text-[11px] text-[var(--color-text-tertiary)]">
                Fallback order: model tokenizer.json → provider tokenizer.json → character heuristic.
              </p>
            </div>
          </div>

          <label className="mt-4 flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
            <input
              checked={onlySpecifiedModels}
              onChange={(event) => setOnlySpecifiedModels(event.currentTarget.checked)}
              type="checkbox"
            />
            Use only the manually specified models below
          </label>

          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-medium text-[var(--color-text-secondary)]">Manual models</p>
              <button
                className="rounded-full px-2 py-1 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={() => setModelRows((rows) => [...rows, { ...emptyModelRow }])}
                type="button"
              >
                Add model
              </button>
            </div>
            {modelRows.map((row, index) => (
              <div
                className="grid gap-2 rounded-2xl border border-[var(--color-border)] p-3 md:grid-cols-2"
                key={index}
              >
                <div>
                  <FieldLabel>Model Id</FieldLabel>
                  <input
                    className={modelFieldClassName}
                    onChange={(event) =>
                      setModelRows((rows) =>
                        rows.map((entry, rowIndex) =>
                          rowIndex === index ? { ...entry, modelId: event.currentTarget.value } : entry,
                        ),
                      )
                    }
                    placeholder="Model Id"
                    value={row.modelId}
                  />
                </div>
                <div>
                  <FieldLabel>Display name</FieldLabel>
                  <input
                    className={modelFieldClassName}
                    onChange={(event) =>
                      setModelRows((rows) =>
                        rows.map((entry, rowIndex) =>
                          rowIndex === index
                            ? { ...entry, displayName: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                    placeholder="Display name"
                    value={row.displayName}
                  />
                </div>
                <div>
                  <FieldLabel>Max context</FieldLabel>
                  <input
                    className={modelFieldClassName}
                    onChange={(event) =>
                      setModelRows((rows) =>
                        rows.map((entry, rowIndex) =>
                          rowIndex === index
                            ? { ...entry, maxContext: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                    placeholder="Max context"
                    value={row.maxContext}
                  />
                </div>
                <div>
                  <FieldLabel>Max output tokens</FieldLabel>
                  <input
                    className={modelFieldClassName}
                    onChange={(event) =>
                      setModelRows((rows) =>
                        rows.map((entry, rowIndex) =>
                          rowIndex === index
                            ? { ...entry, maxOutputTokens: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                    placeholder="Max output tokens"
                    value={row.maxOutputTokens}
                  />
                </div>
                <div>
                  <FieldLabel>Capabilities</FieldLabel>
                  <input
                    className={modelFieldClassName}
                    onChange={(event) =>
                      setModelRows((rows) =>
                        rows.map((entry, rowIndex) =>
                          rowIndex === index
                            ? { ...entry, capabilities: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                    placeholder="text, image"
                    value={row.capabilities}
                  />
                </div>
                <div>
                  <FieldLabel>Reasoning levels</FieldLabel>
                  <input
                    className={modelFieldClassName}
                    onChange={(event) =>
                      setModelRows((rows) =>
                        rows.map((entry, rowIndex) =>
                          rowIndex === index
                            ? { ...entry, reasoningLevels: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                    placeholder="low, medium, high, max"
                    value={row.reasoningLevels}
                  />
                </div>
                <div className="md:col-span-2">
                  <FieldLabel>Model tokenizer.json (optional)</FieldLabel>
                  <input
                    className={modelFieldClassName}
                    onChange={(event) =>
                      setModelRows((rows) =>
                        rows.map((entry, rowIndex) =>
                          rowIndex === index
                            ? { ...entry, tokenizerJson: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                    placeholder="Overrides provider tokenizer"
                    value={row.tokenizerJson}
                  />
                </div>
                <div>
                  <FieldLabel>Tokenizer kind (optional)</FieldLabel>
                  <input
                    className={modelFieldClassName}
                    onChange={(event) =>
                      setModelRows((rows) =>
                        rows.map((entry, rowIndex) =>
                          rowIndex === index
                            ? { ...entry, tokenizerKind: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                    placeholder="hf-json"
                    value={row.tokenizerKind}
                  />
                </div>
                <div className="flex items-end">
                  <button
                    className="h-9 rounded-xl px-3 text-[12px] text-[var(--color-danger)] transition hover:bg-[var(--color-panel-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={isSoleEmptyDraft}
                    onClick={() =>
                      setModelRows((rows) =>
                        rows.length === 1
                          ? [{ ...emptyModelRow }]
                          : rows.filter((_, rowIndex) => rowIndex !== index),
                      )
                    }
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          {error && dialog.type === "provider-form" ? (
            <p className="mt-3 rounded-2xl border border-[var(--color-danger)] px-3 py-2 text-[12px] text-[var(--color-danger)]">
              {error}
            </p>
          ) : null}
        </AppDialog>
      ) : null}

      {toastMessage ? (
        <div className="pointer-events-none fixed bottom-6 right-6 z-[420] rounded-2xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel)_92%,transparent)] px-3.5 py-2 text-[12px] font-medium text-[var(--color-text)] shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          {toastMessage}
        </div>
      ) : null}
    </div>
  );
}
