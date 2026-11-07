import assert from "node:assert/strict";
import { test } from "node:test";
import { appUpdateStatus } from "../src/app-updates.js";

test("app updates distinguish a published upgrade from an unpublished newer build", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ name: "@ignitionai/cogitator", version: "0.5.2" }));
    assert.equal((await appUpdateStatus("0.5.1")).status, "available");
    assert.equal((await appUpdateStatus("0.5.2")).status, "current");
    assert.equal((await appUpdateStatus("0.6.0")).status, "ahead");
    assert.equal((await appUpdateStatus("0.6.0-dev")).status, "unknown");
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await assert.rejects(appUpdateStatus());
    globalThis.fetch = async () => new Response(JSON.stringify({ name: "other", version: "1.0.0" }));
    await assert.rejects(appUpdateStatus());
  } finally { globalThis.fetch = original; }
});
