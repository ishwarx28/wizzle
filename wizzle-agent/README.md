# Wizzle Agent

`wizzle-agent` is the Tauri desktop app for Wizzle.

## Responsibilities

- Render the local workspace UI
- Store local projects, sessions, composer state, provider metadata, settings, and permission mode in SQLite
- Discover ancestor, project, and nested `AGENTS.md` instruction scopes
- Discover flat global skills and `<skill>/SKILL.md` manifests for the agent prompt
- Handle local file access and shell execution inside the selected project root
- Call configured AI providers directly from the Tauri backend

## Stack

- Tauri v2
- React 19
- TypeScript
- Vite
- Tailwind CSS
- Zustand
- SQLite through `rusqlite`

## Scripts

Run commands from the `wizzle-agent` directory with Node.js 22 (see `.nvmrc`).

```bash
npm install
```

Frontend dev server:

```bash
npm run dev
```

Desktop app in development:

```bash
source "$HOME/.cargo/env"
cp .env.example .env
npm run tauri dev
```

Production frontend build:

```bash
npm run build
```

## Local State

The desktop app stores state under the user's home directory:

- Database: `~/.wizzle/wizzle.db`
- Session attachments: `~/.wizzle/sessions/<session-id>/attachments`
- Legacy JSON files may still be read for migration, but new writes go through SQLite.

## Provider Setup

Copy the example env file, then adjust provider import settings if needed:

```bash
cp .env.example .env
```

Useful values:

- `WIZZLE_PROVIDERS_YAML_PATH` points to the initial provider YAML file. The default is `../opencode-models.yaml`.
- `WIZZLE_PROVIDER_KEY` optionally overrides the local encryption key used for stored provider API keys. Leave it empty for normal local development.
- `WIZZLE_DESKTOP_LOG_MODE` and `VITE_WIZZLE_FRONTEND_LOG_MODE` control desktop/frontend logging.

The initial provider file is `../opencode-models.yaml`. It seeds OpenAI-compatible providers and model metadata when no providers are configured. Additional providers can be added from the Providers page.

Provider records are stored locally. API keys are encrypted before being written to SQLite and are not exposed through frontend provider/model state.

## Direct Provider Calls

The app no longer depends on a separate proxy process for model discovery, chat streaming, title generation, or prompt enhancement. Provider requests are made by Rust Tauri commands:

- `list_providers`
- `list_provider_models`
- `refresh_provider_models`
- `stream_provider_chat`
- `complete_provider_chat`
- `cancel_provider_chat`

OpenAI-compatible providers are supported by the current adapter. Unsupported provider protocols are shown as unavailable and cannot be saved until a dedicated adapter exists.

## Agent Prompt and Skills

The frontend builds the agent system prompt from `src/lib/prompts/system-prompt.txt`, discovered `AGENTS.md` paths, and global skill metadata. The agent reads applicable instruction files before relying on their rules; the closest scoped file takes precedence. Replay history is trimmed by `src/lib/context-budget.ts` before model calls so large sessions stay inside the selected model's context budget.

## Package Builds

If Rust is installed through `rustup`, load it first:

```bash
source "$HOME/.cargo/env"
```

Build a macOS `.dmg`:

```bash
npm run tauri build -- --bundles dmg
```

Build a Windows `.exe` installer:

```bash
npm run tauri build -- --bundles nsis
```

Build Linux packages:

```bash
npm run tauri build -- --bundles appimage
npm run tauri build -- --bundles deb
npm run tauri build -- --bundles rpm
```

Build default bundles for the current platform:

```bash
npm run tauri build
```

Bundle output is generated under `src-tauri/target/release/bundle/`.

CI is configured in `../.github/workflows/build-desktop-packages.yml`. It runs tests and quality checks before publishing `dmg`, `exe`, and `deb` assets to the rolling GitHub prerelease tag `main-build`.

## Notes

- The desktop app owns local state and local tool execution.
- The app launches directly into the workspace without sign-in.
- MVP permission modes are `manual-approve` and `full-access`.
- `full-access` must stay limited to the selected project root.

## License

This project is proprietary. See [LICENSE.txt](../LICENSE.txt).
