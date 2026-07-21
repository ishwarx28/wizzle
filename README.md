# Wizzle

Wizzle is an open-source, local-first desktop AI coding agent. It combines a React workspace with a Rust/Tauri backend for project tools, local SQLite state, and direct connections to supported AI providers.

## What it provides

- Project-aware AI sessions with durable implementation plans
- Local file, edit, shell, and subagent tools
- Automatic diagnostics after code mutations across common web, Python, Flutter, Rust, mobile, and JVM stacks
- OpenAI-compatible, Anthropic, Google Gemini, and local model providers
- Remotely managed prompts and provider catalogs with SHA-256 validation
- Local credentials and workspace data under `~/.wizzle`

## Download

The latest successful `main` build is published with stable URLs:

- [macOS DMG](https://github.com/ishwarx28/wizzle/releases/download/main-build/Wizzle-macOS.dmg)
- [Windows installer](https://github.com/ishwarx28/wizzle/releases/download/main-build/Wizzle-Windows.exe)
- [Linux AppImage](https://github.com/ishwarx28/wizzle/releases/download/main-build/Wizzle-Linux.AppImage)

Packages are currently unsigned, so your operating system may show a security warning. In-app updates remain disabled until release signing is configured.

## Develop

Requirements: Node.js 22, Rust stable, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
cd wizzle-agent
npm ci
cp .env.example .env
npm run tauri dev
```

Useful checks:

```bash
npm test
npm run build
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

The public runtime configuration lives in [`remote-config`](remote-config). Pushes to `main` verify the project, build macOS, Windows, and Linux installers, and replace the rolling `main-build` prerelease.

Contributions and focused bug reports are welcome. Please keep credentials, tokens, and user data out of commits.

## License

[MIT](LICENSE)
