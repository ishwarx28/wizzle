import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "./app.js";
import { HttpError } from "./errors.js";
import { createAppConfig } from "./model-registry.js";

function createTestApp(overrides?: {
  verifyIdToken?: (token: string) => Promise<{ uid: string }>;
  callUpstream?: (request: { path: string; body: Record<string, unknown> }) => Promise<Response>;
}) {
  return createApp({
    config: createAppConfig({
      wizzle1ThinkingUpstreamModel: "deepseek-v4-flash-free"
    }),
    verifyIdToken: overrides?.verifyIdToken ?? (async () => ({ uid: "user_123" })),
    callUpstream: async (request) =>
      overrides?.callUpstream?.(request) ??
      new Response(JSON.stringify({ id: "chatcmpl_1", model: request.body.model }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }),
    logger: () => {}
  });
}

function createRequest(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

test("health is public", async () => {
  const response = await createTestApp().fetch(createRequest("/health"));

  assert.equal(response.status, 200);
});

test("models require auth", async () => {
  const response = await createTestApp().fetch(createRequest("/v1/models"));
  const json = await response.json();

  assert.equal(response.status, 401);
  assert.equal(json.error.code, "invalid_auth");
});

test("models returns wizzle-owned model ids", async () => {
  const response = await createTestApp().fetch(
    createRequest("/v1/models", {
      headers: {
        authorization: "Bearer token"
      }
    })
  );
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    json.data.map((item: { id: string }) => item.id),
    ["wizzle-1-thinking"]
  );
});

test("chat rejects missing project header", async () => {
  const response = await createTestApp().fetch(
    createRequest("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        "x-wizzle-chat-id": "chat_1",
        "x-wizzle-reasoning-level": "balanced"
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }]
      })
    })
  );
  const json = await response.json();

  assert.equal(response.status, 400);
  assert.equal(json.error.code, "invalid_headers");
});

test("chat rejects missing reasoning header", async () => {
  const response = await createTestApp().fetch(
    createRequest("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        "x-wizzle-project-id": "project_1",
        "x-wizzle-chat-id": "chat_1"
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }]
      })
    })
  );
  const json = await response.json();

  assert.equal(response.status, 400);
  assert.equal(json.error.code, "invalid_headers");
});

test("chat rejects unsupported models", async () => {
  const response = await createTestApp().fetch(
    createRequest("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        "x-wizzle-project-id": "project_1",
        "x-wizzle-chat-id": "chat_1",
        "x-wizzle-reasoning-level": "balanced"
      },
      body: JSON.stringify({
        model: "bad-model",
        messages: [{ role: "user", content: "hi" }]
      })
    })
  );
  const json = await response.json();

  assert.equal(response.status, 400);
  assert.equal(json.error.code, "invalid_model");
});

test("chat injects default model and forwards request", async () => {
  let seenPath = "";
  let seenBody: Record<string, unknown> | undefined;

  const response = await createTestApp({
    callUpstream: async (request) => {
      seenPath = request.path;
      seenBody = request.body;
      return new Response(JSON.stringify({ ok: true, model: request.body.model }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }
  }).fetch(
    createRequest("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        "x-wizzle-project-id": "project_1",
        "x-wizzle-chat-id": "chat_1",
        "x-wizzle-reasoning-level": "balanced"
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }]
      })
    })
  );
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(seenPath, "/v1/chat/completions");
  assert.equal(seenBody?.model, "deepseek-v4-flash-free");
  assert.deepEqual(seenBody?.reasoning, { effort: "medium" });
  assert.equal(json.model, "deepseek-v4-flash-free");
});

test("chat maps max reasoning to max effort", async () => {
  let seenReasoning: unknown;

  await createTestApp({
    callUpstream: async (request) => {
      seenReasoning = request.body.reasoning;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }
  }).fetch(
    createRequest("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        "x-wizzle-project-id": "project_1",
        "x-wizzle-chat-id": "chat_1",
        "x-wizzle-reasoning-level": "max"
      },
      body: JSON.stringify({
        model: "wizzle-1-thinking",
        messages: [{ role: "user", content: "hi" }]
      })
    })
  );

  assert.deepEqual(seenReasoning, { effort: "max" });
});

test("chat maps invalid upstream json to 502", async () => {
  const response = await createTestApp({
    callUpstream: async () =>
      new Response("not-json", {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
  }).fetch(
    createRequest("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        "x-wizzle-project-id": "project_1",
        "x-wizzle-chat-id": "chat_1",
        "x-wizzle-reasoning-level": "balanced"
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }]
      })
    })
  );
  const json = await response.json();

  assert.equal(response.status, 502);
  assert.equal(json.error.code, "invalid_upstream_response");
});

test("auth verifier errors are returned safely", async () => {
  const response = await createTestApp({
    verifyIdToken: async () => {
      throw new HttpError(401, "invalid_auth", "Authentication failed");
    }
  }).fetch(
    createRequest("/v1/models", {
      headers: {
        authorization: "Bearer bad-token"
      }
    })
  );
  const json = await response.json();

  assert.equal(response.status, 401);
  assert.equal(json.error.code, "invalid_auth");
});
