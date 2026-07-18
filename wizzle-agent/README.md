# Wizzle Agent

`wizzle-agent` is the Tauri desktop app for Wizzle.

## Responsibilities

- Render the local workspace UI
- Store local projects, sessions, composer state, provider metadata, settings, and permission mode in SQLite
- Discover ancestor, project, and nested `AGENTS.md` instruction scopes
- Discover flat global skills and `<skill>/SKILL.md` manifests for the agent prompt
- Handle local file access inside the selected project root
- Run host shell commands with the project as the working directory (not OS-sandboxed)
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

## Remote Configuration and Providers

Copy the example env file before starting the app:

```bash
cp .env.example .env
```

`WIZZLE_CONFIG_URL` is required and must point directly to the public root YAML manifest. The manifest supplies developer metadata, update information, system prompts, and links to independently validated provider catalogs. Wizzle downloads it over HTTPS and keeps a last-known-good local cache for temporary network failures. There are no bundled provider, reasoning, prompt, or identity fallbacks.

The `update` entry uses semantic versions and platform-specific signed updater endpoints. When the configured version is newer, Wizzle installs it inside the app; `critical` updates block the workspace until installation. Release builds embed `WIZZLE_UPDATER_PUBLIC_KEY`, while CI signs updater artifacts with `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The Providers page offers two paths:

- **Setup existing provider** installs a managed provider from the remote catalog. Only its API key and any provider-declared setup values are editable locally.
- **Add custom provider** stores a user-defined endpoint, models, headers, and JSON Pointer request fields locally.

Provider records are stored locally. API keys are encrypted before being written to SQLite using a private key in Wizzle's local state directory, and are not exposed through frontend provider/model state. `WIZZLE_DESKTOP_LOG_MODE` and `VITE_WIZZLE_FRONTEND_LOG_MODE` control local logging.

## Direct Provider Calls

The app no longer depends on a separate proxy process for model discovery, chat streaming, title generation, or prompt enhancement. Provider requests are made by Rust Tauri commands:

- `list_providers`
- `list_provider_models`
- `refresh_provider_models`
- `stream_provider_chat`
- `complete_provider_chat`
- `cancel_provider_chat`

The provider layer supports OpenAI-compatible chat completions, Anthropic's native Messages API, and Google's native Gemini GenerateContent API. Use an API base URL in provider settings; Wizzle adds the protocol-specific model and generation paths. Each adapter normalizes text, reasoning, images, tool calls, streaming events, errors, and model discovery into the same internal format.

## Agent Prompt and Skills

The frontend builds the agent system prompt from the validated remote prompt catalog, discovered `AGENTS.md` paths, and global skill metadata. Dedicated remote prompts cover title generation, enhancement, compaction, context pressure, subagents, and final-response recovery. For project work, the main agent first creates a durable Markdown implementation plan with approaches, affected files, ordered steps, and verification, then stops for user review. The plan opens in the in-app file sidebar through the Read plan tile; execution resumes from the user's next plain-language response and advances one completed step at a time. The agent reads applicable instruction files before relying on their rules; the closest scoped file takes precedence. Replay history is trimmed by `src/lib/context-budget.ts` before model calls so large sessions stay inside the selected model's context budget.

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
- Full Access automatically allows ordinary reads and in-project edits. Sensitive reads, non-whitelisted shell commands, dangerous commands, and out-of-project mutations require approval.
- Manual Approve also requires approval for in-project mutations. In-project reads and whitelisted read-only shell commands run without a prompt.
- Shell commands are host-capable and are not filesystem-sandboxed.

## License

This project is proprietary. See [LICENSE.txt](../LICENSE.txt).
