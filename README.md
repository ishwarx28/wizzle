# Wizzle

Wizzle is a desktop AI coding agent paired with a stateless OpenAI-compatible proxy.

## Repositories

- `wizzle-agent`: Tauri desktop app for auth screens, workspace UI, local state, local file access, and local tool execution.
- `wizzle-proxy`: Node.js proxy for auth validation, model routing, and OpenAI-compatible `/v1` endpoints.

## Product Contract

- A project is one local folder chosen by the user.
- A chat belongs to exactly one project.
- The desktop app stores projects, chats, settings, and permission mode locally.
- The proxy stays stateless and does not store project files or chat history.
- The desktop app never calls model providers directly.
- The proxy never executes local shell commands or accesses local files.

## Public Model Contract

- Public model ids belong to Wizzle.
- Current public model: `wizzle-1-thinking`
- Chat requests must include `X-Wizzle-Reasoning-Level: balanced|max`

## Quick Start

Desktop app:

```bash
cd /Users/mrdev.288/StudioProjects/wizzle/wizzle-agent
npm install
cp .env.example .env
source "$HOME/.cargo/env"
npm run tauri dev
```

Proxy:

```bash
cd /Users/mrdev.288/StudioProjects/wizzle/wizzle-proxy
npm install
cp .env.example .env
npm run dev
```

Google sign-in in the desktop app opens in the system browser and returns through a temporary loopback callback on `127.0.0.1`. For that flow you must also set `VITE_GOOGLE_OAUTH_CLIENT_ID` in `/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/.env` with a Google desktop OAuth client id.

## Verification

- Agent frontend build: `cd wizzle-agent && npm run build`
- Proxy typecheck: `cd wizzle-proxy && npm run check`
- Proxy tests: `cd wizzle-proxy && npm run test`

## Packaging

- macOS `.dmg`: `cd wizzle-agent && npm run tauri build -- --bundles dmg`
- Windows `.exe` installer: `cd wizzle-agent && npm run tauri build -- --bundles nsis`
- Linux bundles: `cd wizzle-agent && npm run tauri build -- --bundles appimage`, `deb`, or `rpm`
- GitHub Actions also builds `dmg`, `exe`, and `deb` on every push to `main` and publishes them to the rolling prerelease tag `main-build` via `.github/workflows/build-desktop-packages.yml`

## License

This repository is proprietary. See [LICENSE.txt](/Users/mrdev.288/StudioProjects/wizzle/LICENSE.txt).
