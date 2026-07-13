# Wizzle

Wizzle is a local-first desktop AI coding agent. The Tauri application owns the workspace UI, project/session state, tool execution, and direct calls to configured OpenAI-compatible model providers. This checkout does not require a separate proxy or sign-in service.

## Architecture

- `wizzle-agent/src`: React and TypeScript workspace UI plus agent orchestration.
- `wizzle-agent/src-tauri`: Rust commands for SQLite persistence, provider HTTP calls, local file tools, and process control.
- `opencode-models.yaml`: initial OpenAI-compatible provider and model metadata imported when no providers exist.
- Local state and provider credentials are stored under `~/.wizzle`.

A project maps to one user-selected local folder, and every stored session belongs to one project. Ordinary mutations stay within that project; approved external mutations and host-capable shell commands remain subject to the selected session permission mode.

## Quick Start

Wizzle uses Node.js 22, declared in `wizzle-agent/.nvmrc`.

```bash
cd wizzle-agent
npm install
cp .env.example .env
source "$HOME/.cargo/env"
npm run tauri dev
```

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
