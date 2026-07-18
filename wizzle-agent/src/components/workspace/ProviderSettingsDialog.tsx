import type { ComponentProps } from "react";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  ListTree,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";

import {
  deleteProvider,
  listProviderModels,
  listProviders,
  refreshProviderModels,
  setupManagedProvider,
  updateManagedProviderApiKey,
  upsertProvider,
} from "../../lib/local-workspace";
import { getRemoteConfig } from "../../lib/remote-config";
import { useWorkspaceStore } from "../../store/workspace-store";
import type {
  ModelCapability,
  ProviderHeader,
  ProviderInfo,
  ProviderRequestField,
} from "../../types/workspace";
import { AppDialog } from "../common/AppDialog";

type ProviderSettingsPageProps = { onBack: () => void };

type EditablePair = { id: string; key: string; value: string };

type ProviderModelFormRow = {
  capabilities: ModelCapability[];
  displayName: string;
  maxContext: string;
  maxOutputTokens: string;
  modelId: string;
  rowId: string;
};

type DialogState =
  | { type: "add-choice" }
  | { type: "custom-form"; mode: "add" | "edit"; providerId?: string }
  | { type: "delete"; provider: ProviderInfo }
  | { type: "managed-edit"; provider: ProviderInfo }
  | { type: "managed-setup" }
  | { type: "model-manager"; providerId: string }
  | { type: "refresh"; provider: ProviderInfo };

const MODEL_CAPABILITIES: ModelCapability[] = ["text", "image", "video", "audio"];
const PROVIDER_PRESETS = {
  anthropic: { endpoint: "https://api.anthropic.com", name: "Anthropic" },
  google: { endpoint: "https://generativelanguage.googleapis.com", name: "Google Gemini" },
  openai_compatible: { endpoint: "https://api.openai.com/v1", name: "OpenAI compatible" },
} as const;

const fieldClassName =
  "h-10 w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-ui-tight text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)]";
const modelFieldClassName =
  "h-9 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-3 text-[13px] text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)]";
const smallButtonClassName =
  "inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 text-ui-tight text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40";

const noSuggestionProps = {
  autoCapitalize: "none" as const,
  autoComplete: "off",
  autoCorrect: "off",
  "data-1p-ignore": true,
  "data-bwignore": true,
  "data-form-type": "other",
  "data-lpignore": "true",
  spellCheck: false,
};

function SettingsInput(props: ComponentProps<"input">) {
  return <input {...noSuggestionProps} {...props} />;
}

function FieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1 block text-[12px] font-medium text-[var(--color-text-tertiary)]">
      {children}
    </label>
  );
}

function normalizeError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function parseOptionalInteger(value: string, label: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return parsed;
}

function newPair(): EditablePair {
  return { id: crypto.randomUUID(), key: "", value: "" };
}

function newModel(): ProviderModelFormRow {
  return {
    capabilities: ["text"],
    displayName: "",
    maxContext: "",
    maxOutputTokens: "",
    modelId: "",
    rowId: crypto.randomUUID(),
  };
}

function parseRequestValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function formatRequestValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function providerTypeLabel(type: string) {
  if (type === "anthropic") return "Anthropic Messages";
  if (type === "google") return "Google Generate Content";
  return "OpenAI compatible";
}

function CapabilitySelect({
  onChange,
  value,
}: {
  onChange: (value: ModelCapability[]) => void;
  value: ModelCapability[];
}) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--color-border)] p-2">
      {MODEL_CAPABILITIES.map((capability) => (
        <label
          className="flex items-center gap-2 text-[12px] capitalize text-[var(--color-text-secondary)]"
          key={capability}
        >
          <SettingsInput
            checked={value.includes(capability)}
            onChange={(event) => {
              const next = event.currentTarget.checked
                ? [...new Set([...value, capability])]
                : value.filter((entry) => entry !== capability);
              onChange(next.length ? next : ["text"]);
            }}
            type="checkbox"
          />
          {capability}
        </label>
      ))}
    </div>
  );
}

function PairEditor({
  addLabel,
  keyPlaceholder,
  onChange,
  rows,
  valuePlaceholder,
}: {
  addLabel: string;
  keyPlaceholder: string;
  onChange: (rows: EditablePair[]) => void;
  rows: EditablePair[];
  valuePlaceholder: string;
}) {
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] gap-2" key={row.id}>
          <SettingsInput
            className={modelFieldClassName}
            onChange={(event) =>
              onChange(
                rows.map((entry) =>
                  entry.id === row.id ? { ...entry, key: event.currentTarget.value } : entry,
                ),
              )
            }
            placeholder={keyPlaceholder}
            value={row.key}
          />
          <SettingsInput
            className={modelFieldClassName}
            onChange={(event) =>
              onChange(
                rows.map((entry) =>
                  entry.id === row.id ? { ...entry, value: event.currentTarget.value } : entry,
                ),
              )
            }
            placeholder={valuePlaceholder}
            value={row.value}
          />
          <button
            aria-label="Remove row"
            className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-danger)]"
            onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button className={smallButtonClassName} onClick={() => onChange([...rows, newPair()])} type="button">
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </button>
    </div>
  );
}

export function ProviderSettingsPage({ onBack }: ProviderSettingsPageProps) {
  const providers = useWorkspaceStore((state) => state.providers);
  const providerModels = useWorkspaceStore((state) => state.providerModels);
  const setProviderConfig = useWorkspaceStore((state) => state.setProviderConfig);
  const managedCatalog = getRemoteConfig().providers;

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [managedConfigId, setManagedConfigId] = useState("");
  const [setupValues, setSetupValues] = useState<Record<string, string>>({});

  const [name, setName] = useState("");
  const [providerType, setProviderType] = useState("openai_compatible");
  const [endpoint, setEndpoint] = useState("");
  const [defaultModelId, setDefaultModelId] = useState("");
  const [defaultMaxContext, setDefaultMaxContext] = useState("");
  const [defaultMaxOutput, setDefaultMaxOutput] = useState("");
  const [headerRows, setHeaderRows] = useState<EditablePair[]>([]);
  const [requestRows, setRequestRows] = useState<EditablePair[]>([]);

  const [modelRows, setModelRows] = useState<ProviderModelFormRow[]>([newModel()]);
  const [modelSearch, setModelSearch] = useState("");
  const [selectedModelRowId, setSelectedModelRowId] = useState<string | null>(null);

  const configuredManagedIds = useMemo(
    () => new Set(providers.flatMap((provider) => provider.managedConfigId ?? [])),
    [providers],
  );
  const availableManaged = managedCatalog.filter((entry) => !configuredManagedIds.has(entry.id));
  const selectedManaged = managedCatalog.find((entry) => entry.id === managedConfigId) ?? null;
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return query
      ? modelRows.filter((row) =>
          `${row.modelId} ${row.displayName}`.toLowerCase().includes(query),
        )
      : modelRows;
  }, [modelRows, modelSearch]);
  const selectedModel =
    modelRows.find((row) => row.rowId === selectedModelRowId) ?? modelRows[0] ?? null;

  async function reload() {
    const [nextProviders, nextModels] = await Promise.all([listProviders(), listProviderModels()]);
    setProviderConfig({ providers: nextProviders, models: nextModels });
  }

  function closeDialog() {
    if (busy) return;
    setDialog(null);
    setError(null);
    setApiKey("");
    setShowApiKey(false);
  }

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 2_600);
  }

  function resetCustomForm(type = "openai_compatible") {
    const preset = PROVIDER_PRESETS[type as keyof typeof PROVIDER_PRESETS] ?? PROVIDER_PRESETS.openai_compatible;
    setName(preset.name);
    setProviderType(type);
    setEndpoint(preset.endpoint);
    setApiKey("");
    setDefaultModelId("");
    setDefaultMaxContext("");
    setDefaultMaxOutput("");
    setHeaderRows([]);
    setRequestRows([]);
    setError(null);
  }

  function openCustomAdd() {
    resetCustomForm();
    setDialog({ type: "custom-form", mode: "add" });
  }

  function openCustomEdit(provider: ProviderInfo) {
    setName(provider.name);
    setProviderType(provider.providerType);
    setEndpoint(provider.endpoint);
    setApiKey("");
    setDefaultModelId(provider.defaultModelId ?? "");
    setDefaultMaxContext(provider.defaultMaxContext ? String(provider.defaultMaxContext) : "");
    setDefaultMaxOutput(
      provider.defaultMaxOutputTokens ? String(provider.defaultMaxOutputTokens) : "",
    );
    setHeaderRows(
      provider.headers.map((header) => ({
        id: crypto.randomUUID(),
        key: header.name,
        value: header.value,
      })),
    );
    setRequestRows(
      provider.requestFields.map((field) => ({
        id: crypto.randomUUID(),
        key: field.path,
        value: formatRequestValue(field.value),
      })),
    );
    setError(null);
    setDialog({ type: "custom-form", mode: "edit", providerId: provider.id });
  }

  function openManagedSetup() {
    const first = availableManaged[0];
    setManagedConfigId(first?.id ?? "");
    setSetupValues({});
    setApiKey("");
    setError(null);
    setDialog({ type: "managed-setup" });
  }

  function openModelManager(provider: ProviderInfo) {
    if (provider.isManaged) return;
    const rows = providerModels
      .filter((model) => model.providerId === provider.id)
      .map((model) => ({
        capabilities: model.capabilities.length ? model.capabilities : ["text" as const],
        displayName: model.displayName ?? "",
        maxContext: model.configuredMaxContext ? String(model.configuredMaxContext) : "",
        maxOutputTokens: model.configuredMaxOutputTokens
          ? String(model.configuredMaxOutputTokens)
          : "",
        modelId: model.modelId,
        rowId: crypto.randomUUID(),
      }));
    const next = rows.length ? rows : [newModel()];
    setModelRows(next);
    setSelectedModelRowId(next[0]?.rowId ?? null);
    setModelSearch("");
    setError(null);
    setDialog({ type: "model-manager", providerId: provider.id });
  }

  async function saveManagedSetup() {
    if (!selectedManaged || busy) return;
    setBusy(true);
    setError(null);
    try {
      const providerId = await setupManagedProvider({
        apiKey: apiKey.trim() || undefined,
        providerConfigId: selectedManaged.id,
        setupValues,
      });
      if (selectedManaged.modelCatalogMode === "provider_api") {
        try {
          await refreshProviderModels(providerId, { fetchAll: true, removeInvalid: true });
        } catch (refreshError) {
          showToast(
            `Provider added; live model discovery failed: ${normalizeError(refreshError, "Unknown error")}`,
          );
        }
      }
      await reload();
      setDialog(null);
      showToast(`${selectedManaged.name} added.`);
    } catch (caught) {
      setError(normalizeError(caught, "Managed provider could not be added."));
    } finally {
      setBusy(false);
    }
  }

  async function saveManagedKey(provider: ProviderInfo) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateManagedProviderApiKey({
        apiKey: apiKey.trim() || undefined,
        providerId: provider.id,
      });
      await reload();
      setDialog(null);
      showToast(apiKey.trim() ? "API key updated." : "No changes made.");
    } catch (caught) {
      setError(normalizeError(caught, "API key could not be updated."));
    } finally {
      setBusy(false);
    }
  }

  function normalizedHeaders(): ProviderHeader[] {
    return headerRows
      .filter((row) => row.key.trim() || row.value.trim())
      .map((row) => {
        if (!row.key.trim()) throw new Error("Every custom header requires a name.");
        return { name: row.key.trim(), value: row.value };
      });
  }

  function normalizedRequestFields(): ProviderRequestField[] {
    return requestRows
      .filter((row) => row.key.trim() || row.value.trim())
      .map((row) => {
        if (!row.key.trim()) throw new Error("Every request field requires a JSON pointer path.");
        return { path: row.key.trim(), value: parseRequestValue(row.value) };
      });
  }

  async function saveCustomProvider() {
    if (dialog?.type !== "custom-form" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const providerId = await upsertProvider({
        apiKey: apiKey.trim() || undefined,
        defaultMaxContext: parseOptionalInteger(defaultMaxContext, "Default max context"),
        defaultMaxOutputTokens: parseOptionalInteger(defaultMaxOutput, "Default max output"),
        defaultModelId: defaultModelId.trim() || undefined,
        endpoint,
        headers: normalizedHeaders(),
        id: dialog.providerId,
        name,
        providerType,
        requestFields: normalizedRequestFields(),
      });
      if (dialog.mode === "add") {
        try {
          await refreshProviderModels(providerId, { fetchAll: true });
        } catch {
          // Custom endpoints may not expose /models; model management remains available.
        }
      }
      await reload();
      setDialog(null);
      showToast(dialog.mode === "add" ? "Custom provider added." : "Custom provider saved.");
    } catch (caught) {
      setError(normalizeError(caught, "Custom provider could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function saveModels() {
    if (dialog?.type !== "model-manager" || busy) return;
    const provider = providers.find((entry) => entry.id === dialog.providerId);
    if (!provider || provider.isManaged) return;
    setBusy(true);
    setError(null);
    try {
      const models = modelRows
        .filter((row) => row.modelId.trim())
        .map((row) => ({
          capabilities: row.capabilities,
          displayName: row.displayName.trim() || undefined,
          maxContext: parseOptionalInteger(row.maxContext, "Max context"),
          maxOutputTokens: parseOptionalInteger(row.maxOutputTokens, "Max output tokens"),
          modelId: row.modelId.trim(),
        }));
      if (new Set(models.map((model) => model.modelId)).size !== models.length) {
        throw new Error("Model IDs must be unique within a provider.");
      }
      await upsertProvider({
        defaultMaxContext: provider.defaultMaxContext ?? undefined,
        defaultMaxOutputTokens: provider.defaultMaxOutputTokens ?? undefined,
        defaultModelId: provider.defaultModelId ?? undefined,
        endpoint: provider.endpoint,
        headers: provider.headers,
        id: provider.id,
        models,
        name: provider.name,
        providerType: provider.providerType,
        replaceModels: true,
        requestFields: provider.requestFields,
      });
      await reload();
      setDialog(null);
      showToast("Provider models saved.");
    } catch (caught) {
      setError(normalizeError(caught, "Provider models could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function refresh(provider: ProviderInfo) {
    if (!provider.canRefreshModels || busy) return;
    setBusy(true);
    setError(null);
    try {
      await refreshProviderModels(provider.id, { fetchAll: true, removeInvalid: true });
      await reload();
      setDialog(null);
      showToast("Provider models refreshed.");
    } catch (caught) {
      setError(normalizeError(caught, "Provider models could not be refreshed."));
    } finally {
      setBusy(false);
    }
  }

  async function removeProvider(provider: ProviderInfo) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteProvider(provider.id);
      await reload();
      setDialog(null);
      showToast("Provider removed.");
    } catch (caught) {
      setError(normalizeError(caught, "Provider could not be removed."));
    } finally {
      setBusy(false);
    }
  }

  function patchSelectedModel(patch: Partial<ProviderModelFormRow>) {
    if (!selectedModel) return;
    setModelRows((rows) =>
      rows.map((row) => (row.rowId === selectedModel.rowId ? { ...row, ...patch } : row)),
    );
  }

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-6 sm:px-6 sm:py-8 lg:px-8">
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <button
              className="mb-3 inline-flex items-center gap-2 rounded-full px-2 py-1 text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
              onClick={onBack}
              type="button"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to chat
            </button>
            <h1 className="text-[25px] font-semibold tracking-[-0.03em] text-[var(--color-text)]">
              Providers
            </h1>
            <p className="mt-1 text-ui text-[var(--color-text-secondary)]">
              Set up managed providers or connect a custom endpoint. Credentials stay local.
            </p>
          </div>
          <button className={smallButtonClassName} onClick={() => setDialog({ type: "add-choice" })} type="button">
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>

        {error && !dialog ? (
          <p className="rounded-2xl border border-[var(--color-danger)] px-3 py-2 text-[13px] text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}

        <section className="grid gap-3 md:grid-cols-2">
          {providers.length ? (
            providers.map((provider) => (
              <article
                className="min-w-0 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-card)] p-4"
                key={provider.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-ui-tight font-medium text-[var(--color-text)]">
                      {provider.name}
                    </h2>
                    <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">
                      {provider.isManaged ? "Managed" : "Custom"} · {providerTypeLabel(provider.providerType)}
                    </p>
                  </div>
                  <span className="rounded-full border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-text-secondary)]">
                    {provider.modelCount} models
                  </span>
                </div>
                <p className="mt-3 truncate text-[13px] text-[var(--color-text-secondary)]">
                  {provider.endpoint}
                </p>
                <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">
                  API key: {provider.hasApiKey ? "Stored locally" : "Not set"}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    className={smallButtonClassName}
                    onClick={() => {
                      setApiKey("");
                      setError(null);
                      provider.isManaged
                        ? setDialog({ type: "managed-edit", provider })
                        : openCustomEdit(provider);
                    }}
                    type="button"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button
                    className={smallButtonClassName}
                    disabled={provider.isManaged}
                    onClick={() => openModelManager(provider)}
                    title={
                      provider.isManaged
                        ? "Managed models are controlled by the remote Wizzle catalog."
                        : undefined
                    }
                    type="button"
                  >
                    <ListTree className="h-3.5 w-3.5" /> Manage models
                  </button>
                  <button
                    className={smallButtonClassName}
                    disabled={!provider.canRefreshModels}
                    onClick={() => setDialog({ type: "refresh", provider })}
                    title={
                      provider.canRefreshModels
                        ? "Refresh the provider model list"
                        : "This provider uses a fixed remote model catalog."
                    }
                    type="button"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Refresh
                  </button>
                  <button
                    className={`${smallButtonClassName} text-[var(--color-danger)]`}
                    onClick={() => setDialog({ type: "delete", provider })}
                    type="button"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                </div>
              </article>
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-[var(--color-border)] p-5 text-ui text-[var(--color-text-secondary)] md:col-span-2">
              No provider is configured yet. Use Add to set up a listed provider or connect a custom endpoint.
            </div>
          )}
        </section>
      </div>

      {toast ? (
        <div className="fixed bottom-5 left-1/2 z-[500] -translate-x-1/2 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-[13px] text-[var(--color-text)] shadow-lg">
          {toast}
        </div>
      ) : null}

      {dialog?.type === "add-choice" ? (
        <AppDialog actions={null} onClose={closeDialog} title="Add provider">
          <div className="grid gap-2">
            <button
              className="rounded-2xl border border-[var(--color-border)] p-4 text-left transition hover:bg-[var(--color-panel-hover)]"
              onClick={openManagedSetup}
              type="button"
            >
              <span className="block text-ui-tight font-medium text-[var(--color-text)]">Setup existing provider</span>
              <span className="mt-1 block text-[12px] text-[var(--color-text-secondary)]">Choose a provider maintained by the Wizzle remote catalog.</span>
            </button>
            <button
              className="rounded-2xl border border-[var(--color-border)] p-4 text-left transition hover:bg-[var(--color-panel-hover)]"
              onClick={openCustomAdd}
              type="button"
            >
              <span className="block text-ui-tight font-medium text-[var(--color-text)]">Add custom provider</span>
              <span className="mt-1 block text-[12px] text-[var(--color-text-secondary)]">Configure an endpoint, models, headers, and nested request fields.</span>
            </button>
          </div>
        </AppDialog>
      ) : null}

      {dialog?.type === "managed-setup" ? (
        <AppDialog
          actions={
            <>
              <button className={smallButtonClassName} disabled={busy} onClick={closeDialog} type="button">Cancel</button>
              <button
                className="h-10 rounded-full bg-[var(--color-accent)] px-4 text-ui-tight font-medium text-[var(--color-accent-foreground)] disabled:opacity-50"
                disabled={
                  busy ||
                  !selectedManaged ||
                  (selectedManaged.apiKeyRequired && !apiKey.trim()) ||
                  selectedManaged?.setupFields.some(
                    (field) => field.required && !setupValues[field.id]?.trim(),
                  )
                }
                onClick={() => void saveManagedSetup()}
                type="button"
              >
                {busy ? "Adding…" : "Add provider"}
              </button>
            </>
          }
          busy={busy}
          description="Provider settings and models come from the validated remote Wizzle catalog."
          onClose={closeDialog}
          title="Setup existing provider"
        >
          {availableManaged.length ? (
            <div className="space-y-3">
              <div>
                <FieldLabel>Provider</FieldLabel>
                <select
                  className={fieldClassName}
                  onChange={(event) => {
                    setManagedConfigId(event.currentTarget.value);
                    setSetupValues({});
                    setApiKey("");
                  }}
                  value={managedConfigId}
                >
                  {availableManaged.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.name}</option>
                  ))}
                </select>
              </div>
              {selectedManaged?.setupFields.map((field) => (
                <div key={field.id}>
                  <FieldLabel>{field.label}</FieldLabel>
                  <SettingsInput
                    className={fieldClassName}
                    onChange={(event) =>
                      setSetupValues((values) => ({ ...values, [field.id]: event.currentTarget.value }))
                    }
                    type={field.secret ? "password" : "text"}
                    value={setupValues[field.id] ?? ""}
                  />
                </div>
              ))}
              <div>
                <FieldLabel>{selectedManaged?.apiKeyRequired ? "API key" : "API key (optional)"}</FieldLabel>
                <div className="relative">
                  <SettingsInput className={`${fieldClassName} pr-11`} onChange={(event) => setApiKey(event.currentTarget.value)} type={showApiKey ? "text" : "password"} value={apiKey} />
                  <button aria-label="Toggle API key visibility" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-[var(--color-text-tertiary)]" onClick={() => setShowApiKey((value) => !value)} type="button">
                    {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
              {error ? <p className="text-[12px] text-[var(--color-danger)]">{error}</p> : null}
            </div>
          ) : (
            <p className="text-ui text-[var(--color-text-secondary)]">Every listed provider is already configured.</p>
          )}
        </AppDialog>
      ) : null}

      {dialog?.type === "managed-edit" ? (
        <AppDialog
          actions={
            <>
              <button className={smallButtonClassName} disabled={busy} onClick={closeDialog} type="button">Cancel</button>
              <button className="h-10 rounded-full bg-[var(--color-accent)] px-4 text-ui-tight font-medium text-[var(--color-accent-foreground)] disabled:opacity-50" disabled={busy} onClick={() => void saveManagedKey(dialog.provider)} type="button">{busy ? "Saving…" : "Save"}</button>
            </>
          }
          busy={busy}
          description="Managed connection settings and models are controlled by the remote catalog."
          onClose={closeDialog}
          title={`Edit ${dialog.provider.name}`}
        >
          <FieldLabel>API key</FieldLabel>
          <div className="relative">
            <SettingsInput className={`${fieldClassName} pr-11`} onChange={(event) => setApiKey(event.currentTarget.value)} placeholder={dialog.provider.hasApiKey ? "Blank keeps the stored key" : "API key"} type={showApiKey ? "text" : "password"} value={apiKey} />
            <button aria-label="Toggle API key visibility" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-[var(--color-text-tertiary)]" onClick={() => setShowApiKey((value) => !value)} type="button">{showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button>
          </div>
          {error ? <p className="mt-3 text-[12px] text-[var(--color-danger)]">{error}</p> : null}
        </AppDialog>
      ) : null}

      {dialog?.type === "custom-form" ? (
        <AppDialog
          actions={
            <>
              <button className={smallButtonClassName} disabled={busy} onClick={closeDialog} type="button">Cancel</button>
              <button className="h-10 rounded-full bg-[var(--color-accent)] px-4 text-ui-tight font-medium text-[var(--color-accent-foreground)] disabled:opacity-50" disabled={busy || !name.trim() || !endpoint.trim()} onClick={() => void saveCustomProvider()} type="button">{busy ? "Saving…" : dialog.mode === "add" ? "Add provider" : "Save provider"}</button>
            </>
          }
          busy={busy}
          footerDivider
          onClose={closeDialog}
          size="wide"
          title={dialog.mode === "add" ? "Add custom provider" : "Edit custom provider"}
        >
          <div className="space-y-4">
            <div><FieldLabel>Provider name</FieldLabel><SettingsInput className={fieldClassName} onChange={(event) => setName(event.currentTarget.value)} value={name} /></div>
            <div><FieldLabel>Provider type</FieldLabel><select className={fieldClassName} onChange={(event) => { const type = event.currentTarget.value; setProviderType(type); if (dialog.mode === "add") { const preset = PROVIDER_PRESETS[type as keyof typeof PROVIDER_PRESETS]; setEndpoint(preset.endpoint); setName(preset.name); } }} value={providerType}><option value="openai_compatible">OpenAI compatible</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option></select></div>
            <div className="grid gap-3 md:grid-cols-2">
              <div><FieldLabel>Endpoint</FieldLabel><SettingsInput className={fieldClassName} onChange={(event) => setEndpoint(event.currentTarget.value)} value={endpoint} /></div>
              <div><FieldLabel>API key</FieldLabel><SettingsInput className={fieldClassName} onChange={(event) => setApiKey(event.currentTarget.value)} placeholder={dialog.mode === "edit" ? "Blank keeps the stored key" : "Optional for local providers"} type="password" value={apiKey} /></div>
            </div>
            <div><FieldLabel>Default model ID</FieldLabel><SettingsInput className={fieldClassName} onChange={(event) => setDefaultModelId(event.currentTarget.value)} value={defaultModelId} /></div>
            <div className="grid gap-3 md:grid-cols-2">
              <div><FieldLabel>Default max context</FieldLabel><SettingsInput className={fieldClassName} inputMode="numeric" min={1} onChange={(event) => setDefaultMaxContext(event.currentTarget.value)} placeholder="128,000 app fallback" type="number" value={defaultMaxContext} /></div>
              <div><FieldLabel>Default max output tokens</FieldLabel><SettingsInput className={fieldClassName} inputMode="numeric" min={1} onChange={(event) => setDefaultMaxOutput(event.currentTarget.value)} type="number" value={defaultMaxOutput} /></div>
            </div>
            <div><FieldLabel>Custom headers</FieldLabel><PairEditor addLabel="Add header" keyPlaceholder="Header name" onChange={setHeaderRows} rows={headerRows} valuePlaceholder="Header value" /></div>
            <div>
              <FieldLabel>Custom request fields</FieldLabel>
              <p className="mb-2 text-[11px] leading-4 text-[var(--color-text-tertiary)]">Use JSON Pointer paths. Values accept JSON (`true`, `1024`, objects) or plain text.</p>
              <PairEditor addLabel="Add request field" keyPlaceholder="/chat_template_kwargs/enable_thinking" onChange={setRequestRows} rows={requestRows} valuePlaceholder="true" />
            </div>
            {error ? <p className="text-[12px] text-[var(--color-danger)]">{error}</p> : null}
          </div>
        </AppDialog>
      ) : null}

      {dialog?.type === "model-manager" ? (
        <AppDialog
          actions={<><button className={smallButtonClassName} disabled={busy} onClick={closeDialog} type="button">Cancel</button><button className="h-10 rounded-full bg-[var(--color-accent)] px-4 text-ui-tight font-medium text-[var(--color-accent-foreground)] disabled:opacity-50" disabled={busy} onClick={() => void saveModels()} type="button">{busy ? "Saving…" : "Save models"}</button></>}
          busy={busy}
          flushContent
          hideHeader
          onClose={closeDialog}
          size="provider"
          title="Manage models"
        >
          <div className="grid min-h-[360px] overflow-hidden md:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col border-b border-[var(--color-border)] bg-[var(--color-panel-muted)] md:border-b-0 md:border-r">
              <div className="space-y-2 border-b border-[var(--color-border)] p-3">
                <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-tertiary)]" /><SettingsInput aria-label="Search models" className={`${modelFieldClassName} pl-9`} onChange={(event) => setModelSearch(event.currentTarget.value)} placeholder={`Search ${modelRows.length} models`} value={modelSearch} /></div>
                <button className="flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] text-[13px] text-[var(--color-text-secondary)]" onClick={() => { const row = newModel(); setModelRows((rows) => [...rows, row]); setSelectedModelRowId(row.rowId); setModelSearch(""); }} type="button"><Plus className="h-3.5 w-3.5" /> Add new model</button>
              </div>
              <div className="max-h-[420px] min-h-0 flex-1 overflow-y-auto p-2">
                {filteredModels.map((row) => <button className={`mb-1 w-full rounded-xl px-3 py-2.5 text-left transition ${row.rowId === selectedModel?.rowId ? "bg-[var(--color-panel)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-panel-hover)]"}`} key={row.rowId} onClick={() => setSelectedModelRowId(row.rowId)} type="button"><span className="block truncate text-[13px] font-medium">{row.displayName.trim() || row.modelId.trim() || "Untitled model"}</span><span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-tertiary)]">{row.modelId.trim() || "Model ID not set"}</span></button>)}
              </div>
            </aside>
            <div className="max-h-[560px] min-w-0 overflow-y-auto p-4">
              {selectedModel ? <div className="space-y-4">
                <p className="text-[12px] leading-4 text-[var(--color-text-tertiary)]">Blank model limits inherit provider defaults. If context is also blank, Wizzle uses 128,000 tokens.</p>
                <div className="grid gap-3 md:grid-cols-2"><div><FieldLabel>Model ID</FieldLabel><SettingsInput className={modelFieldClassName} onChange={(event) => patchSelectedModel({ modelId: event.currentTarget.value })} value={selectedModel.modelId} /></div><div><FieldLabel>Display name</FieldLabel><SettingsInput className={modelFieldClassName} onChange={(event) => patchSelectedModel({ displayName: event.currentTarget.value })} value={selectedModel.displayName} /></div><div><FieldLabel>Max context</FieldLabel><SettingsInput className={modelFieldClassName} min={1} onChange={(event) => patchSelectedModel({ maxContext: event.currentTarget.value })} type="number" value={selectedModel.maxContext} /></div><div><FieldLabel>Max output tokens</FieldLabel><SettingsInput className={modelFieldClassName} min={1} onChange={(event) => patchSelectedModel({ maxOutputTokens: event.currentTarget.value })} type="number" value={selectedModel.maxOutputTokens} /></div></div>
                <div><FieldLabel>Capabilities</FieldLabel><CapabilitySelect onChange={(capabilities) => patchSelectedModel({ capabilities })} value={selectedModel.capabilities} /></div>
                <button className={`${smallButtonClassName} text-[var(--color-danger)]`} onClick={() => { const remaining = modelRows.filter((row) => row.rowId !== selectedModel.rowId); const next = remaining.length ? remaining : [newModel()]; setModelRows(next); setSelectedModelRowId(next[0]?.rowId ?? null); }} type="button"><Trash2 className="h-3.5 w-3.5" /> Remove model</button>
                {error ? <p className="text-[12px] text-[var(--color-danger)]">{error}</p> : null}
              </div> : null}
            </div>
          </div>
        </AppDialog>
      ) : null}

      {dialog?.type === "refresh" ? (
        <AppDialog actions={<><button className={smallButtonClassName} disabled={busy} onClick={closeDialog} type="button">Cancel</button><button className="h-10 rounded-full bg-[var(--color-accent)] px-4 text-ui-tight font-medium text-[var(--color-accent-foreground)] disabled:opacity-50" disabled={busy} onClick={() => void refresh(dialog.provider)} type="button">{busy ? "Refreshing…" : "Refresh"}</button></>} busy={busy} description="Fetch the current provider model catalog and remove models no longer returned." onClose={closeDialog} title={`Refresh ${dialog.provider.name}?`}>{error ? <p className="text-[12px] text-[var(--color-danger)]">{error}</p> : null}</AppDialog>
      ) : null}

      {dialog?.type === "delete" ? (
        <AppDialog actions={<><button className={smallButtonClassName} disabled={busy} onClick={closeDialog} type="button">Cancel</button><button className="h-10 rounded-full bg-[var(--color-danger)] px-4 text-ui-tight font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => void removeProvider(dialog.provider)} type="button">{busy ? "Deleting…" : "Delete provider"}</button></>} busy={busy} description={`Remove ${dialog.provider.name} and its configured models. Stored API credentials are deleted with it.`} onClose={closeDialog} title="Delete provider?">{error ? <p className="text-[12px] text-[var(--color-danger)]">{error}</p> : null}</AppDialog>
      ) : null}
    </div>
  );
}
