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
cp .env.example .env
npm run tauri dev
```

Production frontend build:

```bash
npm run build
```

## Firebase Setup

Copy the example env file and fill in your Firebase web app values:

```bash
cp .env.example .env
```

Required values:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`

Optional but recommended:

- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_WIZZLE_PROXY_BASE_URL`

Required for Google sign-in from the desktop app:

- `VITE_GOOGLE_OAUTH_CLIENT_ID`
- `VITE_GOOGLE_OAUTH_CLIENT_SECRET`

## Google Desktop OAuth Setup

Wizzle uses the system browser for Google sign-in, then returns to the app through a temporary loopback callback such as `http://127.0.0.1:<port>/google/callback`.

Create a Google OAuth client for a desktop app, then set the client id and client secret in `/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/.env`:

```bash
VITE_GOOGLE_OAUTH_CLIENT_ID=your-google-desktop-oauth-client-id.apps.googleusercontent.com
VITE_GOOGLE_OAUTH_CLIENT_SECRET=your-google-desktop-oauth-client-secret
```

Notes:

- This client id is separate from the Firebase web app config.
- For this Google desktop OAuth client, Wizzle also sends the client secret during the token exchange.
- Google sign-in works from the Tauri desktop app, not from plain `npm run dev` in a browser tab.
- The app starts a short-lived localhost listener only for the Google OAuth callback.

Auth behavior in MVP:

- Email + password signs in if the account exists
- If the email does not exist yet, the app creates the account automatically
- New email/password accounts get their display name from the part before `@`
- Google sign-in keeps the Google name and profile photo
- Email/password accounts must verify email before entering the app

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

CI builds are also configured in `/Users/mrdev.288/StudioProjects/wizzle/.github/workflows/build-desktop-packages.yml` and run on every push to `main`, publishing `dmg`, `exe`, and `deb` assets to the rolling GitHub prerelease tag `main-build`.

## Notes

- The desktop app owns local state and local tool execution.
- MVP permission modes are `ask` and `full-access`.
- `full-access` must stay limited to the selected project root.

## License

This project is proprietary. See [LICENSE.txt](../LICENSE.txt).
