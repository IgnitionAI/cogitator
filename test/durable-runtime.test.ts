/**
 * Intégration serveur du seam durable (ticket #15) : création d'une
 * conversation à runtime durable via le point de composition, requestId borné
 * stable accusé après acceptation durable, POST dupliqué jamais dupliqué,
 * admission fail closed, sessions classic inchangées. Aucun appel modèle réel
 * (faux provider injecté) et aucun spawn classic (le pool lèverait).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openDb } from "../src/db.js";
import { getConversation } from "../src/conversations.js";
import { getPaths } from "../src/paths.js";
import { PiPool, type PiClientLike } from "../src/pool.js";
import { createApp } from "../src/server.js";
import { DurableRuntimeManager } from "../src/durable/manager.js";
import { durableToolchainRegistry } from "../src/durable/compatibility.js";

class RecordingClient implements PiClientLike {
  static prompted: Array<{ convId: string; text: string }> = [];
  constructor(private opts: { cwd: string; args: string[] }) {}
  async start() {}
  async stop() {}
  onEvent() {
    return () => {};
  }
  async getState() {
    return { sessionFile: "/tmp/fake.jsonl", isStreaming: false };
  }
  async prompt(message: string) {
    RecordingClient.prompted.push({ convId: this.opts.args.join(" "), text: message });
    return {};
  }
  async abort() {}
  async setModel() {
    return {};
  }
}

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cog-durable-api-"));
  const paths = getPaths({
    COGITATOR_HOME: home,
    COGITATOR_PI_AGENT_DIR: join(home, "pi"),
    COGITATOR_AGENTS_DIR: join(home, "agents"),
    COGITATOR_SKILLS_DIRS: join(home, "skills"),
  });
  const { db, version } = openDb(paths.db);
  // Le pool enregistre tout spawn classic : les conversations durable ne doivent
  // jamais créer de processus pi (pas de processus non gérés), les classic si.
  const pool = new PiPool({
    factory: (opts) => new RecordingClient(opts),
  });
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("premier"), fauxAssistantMessage("deuxième")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const durable = new DurableRuntimeManager({
    paths,
    toolchain: durableToolchainRegistry({}),
    modelsFactory: () => models,
  });
  const app = createApp({ db, dbPath: paths.db, dbVersion: version, paths, pool, events: new EventEmitter(), durable });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const port = (server.address() as AddressInfo).port;

  function call(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path, method, headers: body !== undefined ? { "content-type": "application/json" } : {} },
        (res) => {
          let text = "";
          res.on("data", (c) => {
            text += String(c);
          });
          res.on("end", () => {
            let data: Record<string, unknown> = {};
            try {
              data = JSON.parse(text) as Record<string, unknown>;
            } catch {}
            resolve({ status: res.statusCode!, data });
          });
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  return {
    home, db, paths, durable, faux, port, call,
    async close() {
      server.close();
      await durable.dispose();
      db.close();
      await new Promise((r) => setTimeout(r, 50));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("conversation durable : création, requestId accusé après acceptation, POST dupliqué sans duplication", { timeout: 30_000 }, async () => {
  const fx = await fixture();
  try {
    const created = await fx.call("/api/conversations", "POST", { runtime: "durable", provider: "faux", model: "faux-1" });
    assert.equal(created.status, 201);
    const conv = (created.data.conversation as { id: string; runtime_kind: string });
    assert.equal(conv.runtime_kind, "durable");

    const first = await fx.call(`/api/conversations/${conv.id}/messages`, "POST", { text: "bonjour", requestId: "req-1" });
    assert.equal(first.status, 200);
    const accepted1 = (first.data as { ok: boolean; accepted: { requestId: string; submissionId: number; duplicate: boolean } }).accepted;
    assert.equal(accepted1.requestId, "req-1");
    assert.equal(accepted1.duplicate, false);
    assert.equal(typeof accepted1.submissionId, "number");

    // POST dupliqué : même identité acceptée, aucun travail dupliqué.
    const again = await fx.call(`/api/conversations/${conv.id}/messages`, "POST", { text: "bonjour", requestId: "req-1" });
    assert.equal(again.status, 200);
    const acceptedAgain = (again.data as { accepted: { submissionId: number; duplicate: boolean } }).accepted;
    assert.equal(acceptedAgain.submissionId, accepted1.submissionId);
    assert.equal(acceptedAgain.duplicate, true);

    const second = await fx.call(`/api/conversations/${conv.id}/messages`, "POST", { text: "suite", requestId: "req-2" });
    assert.equal(second.status, 200);
    const accepted2 = (second.data as { accepted: { submissionId: number } }).accepted;
    assert.notEqual(accepted2.submissionId, accepted1.submissionId);

    const runtime = await fx.durable.get(getConversation(fx.db, conv.id)!);
    await runtime.waitForIdle();
    const entries = await runtime.transcript();
    // Deux entrées utilisateur pour deux requestId distincts — jamais trois.
    assert.equal(entries.filter((e) => e.kind === "pi.user").length, 2);
    assert.equal(fx.faux.state.callCount, 2, "un appel par soumission acceptée, aucune duplication");
    // Aucun spawn classic pour la mission durable : le pool n'a enregistré aucun prompt.
    assert.equal(RecordingClient.prompted.length, 0, "aucun processus pi pour une conversation durable");

    // État exposé : runtime durable, sans session pi.
    const detail = await fx.call(`/api/conversations/${conv.id}`);
    assert.equal((detail.data as { runtime: string }).runtime, "durable");
  } finally {
    await fx.close();
  }
});

test("conversation durable : requestId absent → 400, requestId invalide → 400", async () => {
  const fx = await fixture();
  try {
    const created = await fx.call("/api/conversations", "POST", { runtime: "durable", provider: "faux", model: "faux-1" });
    const conv = created.data.conversation as { id: string };
    const missing = await fx.call(`/api/conversations/${conv.id}/messages`, "POST", { text: "sans id" });
    assert.equal(missing.status, 400);
    const invalid = await fx.call(`/api/conversations/${conv.id}/messages`, "POST", { text: "x", requestId: "!!!" });
    assert.equal(invalid.status, 400);
    const tooLong = await fx.call(`/api/conversations/${conv.id}/messages`, "POST", { text: "x", requestId: "a".repeat(129) });
    assert.equal(tooLong.status, 400);
  } finally {
    await fx.close();
  }
});

test("admission durable fail closed : MCP non classé → 403 et aucun stockage créé", async () => {
  const fx = await fixture();
  try {
    const res = await fx.call("/api/conversations", "POST", {
      runtime: "durable",
      provider: "faux",
      model: "faux-1",
      mcp_servers: [{ name: "evil-mcp", command: "evil" }],
    });
    assert.equal(res.status, 403);
    assert.match(String((res.data as { error: string }).error), /fail closed/);
    assert.equal(fx.faux.state.callCount, 0);
    // Aucun travail caché : la conversation n'existe pas.
    const list = await fx.call("/api/conversations");
    assert.equal((list.data.conversations as unknown[]).length, 0);
  } finally {
    await fx.close();
  }
});

test("sessions classic inchangées : runtime_kind classic, pas de requestId requis, ack historique", { timeout: 30_000 }, async () => {
  const fx = await fixture();
  try {
    const created = await fx.call("/api/conversations", "POST", { provider: "faux", model: "faux-1" });
    assert.equal(created.status, 201);
    const conv = created.data.conversation as { id: string; runtime_kind: string };
    assert.equal(conv.runtime_kind, "classic");

    const sent = await fx.call(`/api/conversations/${conv.id}/messages`, "POST", { text: "salut classic" });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.data, { ok: true });
    const detail = await fx.call(`/api/conversations/${conv.id}`);
    assert.equal((detail.data as { runtime: string }).runtime, "classic");
  } finally {
    await fx.close();
  }
});
