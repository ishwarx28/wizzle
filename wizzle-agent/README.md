# Wizzle Agent

`wizzle-agent` is the Tauri desktop app for Wizzle.

## Responsibilities

- Render the auth flow and workspace UI
- Store local projects, chats, settings, and permission mode
- Load local instructions such as `AGENTS.md` and `harness.md`
- Handle local file access and shell execution inside the selected project root
- Send model requests through `wizzle-proxy`

## Stack

- Tauri v2
- React 19
- TypeScript
- Vite
- Tailwind CSS
- Zustand

## Scripts

Run commands from `/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent`.

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
npm run tauri dev
```

Production frontend build:

```bash
npm run build
```

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

CI builds are also configured in `/Users/mrdev.288/StudioProjects/wizzle/.github/workflows/build-desktop-packages.yml` and run on every push to `main`, uploading `dmg`, `exe`, and `deb` artifacts to the workflow run.

## Notes

- The desktop app owns local state and local tool execution.
- MVP permission modes are `ask` and `full-access`.
- `full-access` must stay limited to the selected project root.

## License

This project is proprietary. See [LICENSE.txt](../LICENSE.txt).
