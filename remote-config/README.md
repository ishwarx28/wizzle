# Wizzle Remote Configuration

Public runtime configuration for Wizzle. The desktop app loads this manifest:

```text
https://raw.githubusercontent.com/ishwarx28/wizzle/main/remote-config/app-config.yaml
```

## Contents

- `app-config.yaml`: developer metadata, update state, and checksummed child-resource URLs
- `prompts/*.txt`: system prompts used by agent workflows
- `providers/*.yaml`: managed provider transports, models, capabilities, and reasoning rules
- `generate-config.mjs`: regenerates catalogs and checksums using Models.dev metadata
- `THIRD_PARTY_NOTICES.md`: upstream attribution

`update.enabled` is currently `false` because builds are unsigned. Platform URLs use the stable installer assets from the rolling `main-build` release; enable in-app updates only after signed Tauri updater artifacts and a public verification key are configured.

## Updating

Run the generator from this directory with Node.js 18 or newer:

```bash
node generate-config.mjs
```

Review all generated prompt, provider, endpoint, authentication, and checksum changes before committing. Never add API keys, tokens, private endpoints, or user data.

This directory is part of the main Wizzle repository and is covered by its [MIT license](../LICENSE).
