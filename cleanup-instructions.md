## Cleanup Instructions

This file records what was installed or generated for Tauri frontend setup and how to remove it later if you no longer need it.

### Installed in this step

1. Rust toolchain via `rustup`
   - Installed with:
     - `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`
   - Verified versions:
     - `rustc 1.96.1`
     - `cargo 1.96.1`
     - `rustup 1.29.0`
   - Active toolchain:
     - `stable-aarch64-apple-darwin`

2. Local frontend dependencies inside `wizzle-agent`
   - Installed with:
     - `npm install`
     - `npm install react-router-dom zustand react-markdown lucide-react tailwindcss @tailwindcss/vite`
   - This also installed the project-local Tauri CLI through the scaffolded `package.json`:
     - `@tauri-apps/cli`

3. Tauri app scaffold inside `wizzle-agent`
   - Scaffold source:
     - `npx create-tauri-app@latest ... --manager npm --template react-ts --tauri-version 2 --yes`
   - The scaffold was merged into the existing `wizzle-agent` folder so the reference files remained in place.

4. Generated Tauri app icons from the existing Wizzle logo
   - Generated with:
     - `npm exec tauri icon ./references/logo/wizzle-logo.png`

### Installed locations

- `~/.cargo`
- `~/.rustup`
- `/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/node_modules`
- `/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/package-lock.json`
- `/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/src-tauri/icons/*`

`rustup` also adds Cargo to your shell environment through:

- `~/.cargo/env`

Depending on your shell setup, you may also have a line in a shell startup file such as:

- `~/.zshrc`
- `~/.profile`
- `~/.bash_profile`

That line usually looks like:

```sh
. "$HOME/.cargo/env"
```

### Not installed by this step

- Xcode and Apple developer tools were already present
- Node.js and npm were already present
- No global Tauri CLI was installed
- No additional global frontend packages were installed

### Remove Rust and Cargo

Run:

```sh
rustup self uninstall -y
```

If `rustup` is not on your `PATH`, run:

```sh
source "$HOME/.cargo/env"
rustup self uninstall -y
```

### Manual cleanup if anything remains

Remove leftover directories if they still exist after uninstall:

```sh
rm -rf "$HOME/.cargo" "$HOME/.rustup"
```

Then remove any shell startup line that loads Cargo, for example:

```sh
. "$HOME/.cargo/env"
```

### Remove local frontend dependencies

From the repo root or from `wizzle-agent`, remove installed npm packages with:

```sh
rm -rf /Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/node_modules
rm -f /Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/package-lock.json
```

If you also want to remove the dependency declarations, edit:

- `/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/package.json`

and remove:

- `@tailwindcss/vite`
- `@tauri-apps/api`
- `@tauri-apps/plugin-opener`
- `lucide-react`
- `react`
- `react-dom`
- `react-markdown`
- `react-router-dom`
- `tailwindcss`
- `zustand`
- `@tauri-apps/cli`
- `@types/react`
- `@types/react-dom`
- `@vitejs/plugin-react`
- `typescript`
- `vite`

### Remove generated Tauri icons

If you want to remove the generated Wizzle icon assets and go back to a fresh scaffold state, delete:

```sh
rm -rf /Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/src-tauri/icons
```

You can regenerate them later with:

```sh
cd /Users/mrdev.288/StudioProjects/wizzle/wizzle-agent
npm exec tauri icon ./references/logo/wizzle-logo.png
```

### Remove the scaffolded frontend app

If you want to fully remove the phase 1 frontend scaffold and keep only the original docs/reference assets, delete the scaffold-created app files inside `wizzle-agent` and keep:

- `/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/architecture.md`
- `/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/references`

### Notes

The Tauri CLI is installed locally in the project, not globally, which is the recommended cleanup-friendly setup for this repo.
