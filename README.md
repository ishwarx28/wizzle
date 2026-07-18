# Wizzle

Wizzle is a local-first desktop AI coding agent. The Tauri application owns the workspace UI, project/session state, tool execution, and direct calls to configured OpenAI-compatible, Anthropic, and Google Gemini model providers. This checkout does not require a separate proxy or sign-in service.

## Architecture

- `wizzle-agent/src`: React and TypeScript workspace UI plus agent orchestration.
- `wizzle-agent/src-tauri`: Rust commands for SQLite persistence, provider HTTP calls, local file tools, and process control.
- `WIZZLE_CONFIG_URL`: required public manifest for developer metadata, updates, prompts, and managed provider catalogs.
- Local state and provider credentials are stored under `~/.wizzle`.

A project maps to one user-selected local folder, and every stored session belongs to one project. Ordinary mutations stay within that project; approved external mutations and host-capable shell commands remain subject to the selected session permission mode.

After in-project write, edit, or foreground shell mutations, Wizzle runs bounded stack-aware verification and returns normalized diagnostics directly to the agent. Built-in adapters cover web/TypeScript, Python with Pyright and Ruff, Flutter/Dart, Rust, Go, JVM via Gradle/Maven, native Android/Gradle, native iOS/Swift/Xcode, and .NET; project-specific direct commands can be declared in `.wizzle.yaml`.

## Quick Start

Wizzle uses Node.js 22, declared in `wizzle-agent/.nvmrc`.

```bash
cd wizzle-agent
npm install
cp .env.example .env
source "$HOME/.cargo/env"
npm run tauri dev
```

The app validates and caches the remote configuration at startup. Managed providers are installed explicitly from the Providers page; custom providers and their models remain locally configurable.

### In-app updates

The root YAML manifest declares the latest semantic version, severity, release note, and a signed Tauri update-manifest URL for each desktop platform:

```yaml
update:
  version: "0.2.0"
  status: "normal" # or critical
  note: "Release summary"
  platforms:
    macos:
      url: "https://github.com/OWNER/REPO/releases/download/main-build/macos.json"
    windows:
      url: "https://github.com/OWNER/REPO/releases/download/main-build/windows.json"
    linux:
      url: "https://github.com/OWNER/REPO/releases/download/main-build/linux.json"
```

Release builds require `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The matching public key must be embedded with `WIZZLE_UPDATER_PUBLIC_KEY`. GitHub Actions generates signed updater packages and the three platform manifests without sending users to a browser.

## Verification

- TypeScript tests: `cd wizzle-agent && npm test`
- Frontend build and bundle budget: `cd wizzle-agent && npm run build`
- Rust tests: `cd wizzle-agent/src-tauri && cargo test --all-features`
- Rust formatting: `cd wizzle-agent/src-tauri && cargo fmt --all -- --check`
- Strict Rust linting: `cd wizzle-agent/src-tauri && cargo clippy --all-targets --all-features -- -D warnings`

## Packaging

- macOS `.dmg`: `cd wizzle-agent && npm run tauri build -- --bundles dmg`
- Windows `.exe` installer: `cd wizzle-agent && npm run tauri build -- --bundles nsis`
- Linux bundles: `cd wizzle-agent && npm run tauri build -- --bundles appimage`, `deb`, or `rpm`
- GitHub Actions verifies the app, builds all three package formats on pushes to `main`, and publishes them to the rolling `main-build` prerelease.

## License

This repository is proprietary. See [LICENSE.txt](LICENSE.txt).
