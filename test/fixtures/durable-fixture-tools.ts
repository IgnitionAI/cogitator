/**
 * Extension d'outils de mission pour les fixtures contrôlées du ticket #15
 * (aucun appel modèle réel : faux provider ; données temporaires ; crashes
 * subprocess explicites). Profil délibérément étroit, calqué sur le spike P0 :
 * un fichier, des bytes exacts, un worker supervisé.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createEditTool } from "@earendil-works/pi-durable/tools";
import { WorkerRecords } from "../../src/durable/workers.js";

export const FIXTURE_EXTENSION_NAME = "cogitator-fixture-v1";

const never = () => new Promise<never>(() => {});

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      readFileSync(path);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`fixture en attente: ${path}`);
      await delay(50);
    }
  }
}

export interface FixtureMissionToolsOptions {
  /** Dossier de scope temporaire (socket, marqueurs, workspace). */
  scope: string;
  /** true = l'outil atteint un point de crash et attend le SIGKILL. */
  crash: boolean;
}

/** Extension fixture : edit réconcilié + worker détaché supervisé. */
export function makeFixtureExtension(opts: FixtureMissionToolsOptions) {
  const edit = createEditTool();
  const workspace = join(opts.scope, "workspace");
  const socketPath = join(opts.scope, "w.sock");
  const workerScript = join(new URL(".", import.meta.url).pathname, "durable-worker.mjs");

  const fixtureEdit = defineTool({
    name: "fixture_edit",
    description: "Reconcile one fixture edit (ticket #15 test profile)",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api, context) {
      const intent = await api.memo("edit", { before: "before\n", after: "after\n" }, context);
      const current = await import("node:fs/promises").then((fs) => fs.readFile(join(workspace, "fixture.txt"), "utf8"));
      assert(current === intent.before || current === intent.after, "Conflicting file content requires attention");
      if (current === intent.before) {
        const result = await edit.execute(
          { path: "fixture.txt", edits: [{ oldText: intent.before, newText: intent.after }] },
          api,
          context,
        );
        assert(!result.isError);
      }
      if (opts.crash) {
        // Bytes écrits, résultat outil non commité : le point de crash du scénario mid-tool.
        await api.details({ point: "edit-written-before-receipt" }, context);
        process.send?.({ point: "edit-written-before-receipt" });
        await never();
      }
      return { content: [{ type: "text", text: "edit reconciled" }] };
    },
  });

  const fixtureWorker = defineTool({
    name: "fixture_worker",
    description: "Dispatch one detached fixture worker (ticket #15 test profile)",
    parameters: Type.Object({}),
    replay: "unsafe",
    async execute(_args, api, context) {
      const id = randomUUID();
      // Identité persistée AVANT dispatch (Plan 0002 §5.7).
      await api.commit(async (tx) => {
        const doc = await tx.doc(WorkerRecords, api.conversationId);
        doc.workers.push({ id, pid: 0, command: "fixture-worker", dispatchedAt: Date.now() });
      }, context);
      const child = spawn(process.execPath, [workerScript, socketPath, opts.scope], {
        detached: true,
        stdio: "ignore",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      child.unref();
      await waitForFile(join(opts.scope, "worker.ready"), 5_000);
      const pid = Number(readFileSync(join(opts.scope, "worker.ready"), "utf8"));
      await api.commit(async (tx) => {
        const doc = await tx.doc(WorkerRecords, api.conversationId);
        const record = doc.workers.find((w) => w.id === id);
        if (record) record.pid = pid;
      }, context);
      await api.details({ point: "worker-running", workerId: id, pid }, context);
      process.send?.({ point: "worker-running", workerId: id, pid });
      if (opts.crash) await never();
      // Chemin non-interrompu : observation/arrêt propre (non exercé par les scénarios).
      return { content: [{ type: "text", text: "worker dispatched" }] };
    },
  });

  return defineExtension({ name: FIXTURE_EXTENSION_NAME, tools: [fixtureEdit, fixtureWorker] });
}
