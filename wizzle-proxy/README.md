# Wizzle Proxy

`wizzle-proxy` is the stateless OpenAI-compatible backend for Wizzle.

## Responsibilities

- Verify authenticated requests
- Expose OpenAI-style `/v1` routes
- Publish Wizzle-owned model ids
- Map public Wizzle requests to upstream provider requests
- Keep provider-specific model ids and reasoning settings internal

## Current Routes

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

Protected `/v1` routes require auth, and chat requests must include:

- `X-Wizzle-Reasoning-Level: balanced|max`

## Environment

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Current variables:

- `PORT`
- `FIREBASE_SERVICE_ACCOUNT_PATH`
- `UPSTREAM_BASE_URL`
- `UPSTREAM_API_KEY`
- `WIZZLE_1_THINKING_UPSTREAM_MODEL`

## Scripts

Run commands from `/Users/mrdev.288/StudioProjects/wizzle/wizzle-proxy`.

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

Typecheck:

```bash
npm run check
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm run test
```

Start the compiled server:

```bash
npm run start
```

## Notes

- The proxy is stateless and should not store chats, files, or project data.
- It should return stable client-safe errors instead of leaking raw upstream failures.
- Public model ids belong to Wizzle, not the upstream provider.

## License

This project is proprietary. See [LICENSE.txt](../LICENSE.txt).
