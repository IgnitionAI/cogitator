/**
 * Matrice SIGKILL du ticket #15 à travers la runtime de mission PRODUCTION
 * (src/durable/mission-runtime) : génération interrompue, outil interrompu
 * (réconciliation d'édition), outil worker (orphelin vivant classé, arrêté,
 * aucune fuite). Faux provider uniquement, données temporaires, SIGKILL réels.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DRIVER = join(import.meta.dirname, "fixtures", "durable-driver.ts");
const SIGKILL_SCENARIOS = ["generation", "edit", "worker"] as const;

function runPhase(scope: string, phase: "seed" | "reopen", scenario: string, witness: string, timeoutMs = 45_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = fork(DRIVER, ["drive", scope, `${phase}:${scenario}`, witness], {
      execArgv: ["--import", "tsx"],
      // Environnement minimal et temporaire : aucune donnée réelle n'est lue.
      env: { PATH: process.env.PATH ?? "", HOME: scope, TMPDIR: scope },
      silent: true,
    });
    let stderr = "";
    let result: unknown;
    let failure: Error | undefined;
    const timeout = setTimeout(() => {
      failure = new Error(`timeout ${phase}:${scenario}`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      failure = err;
    });
    child.on("message", (message) => {
      result = message;
      if (phase === "seed") child.kill("SIGKILL"); // crash réel au point de contrôle
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (phase === "seed" ? signal !== "SIGKILL" : code !== 0)
        reject(new Error(`${phase}:${scenario} exit ${code}/${signal}: ${stderr}`));
      else resolve(result);
    });
  });
}

async function stopLeftoverWorker(scope: string): Promise<void> {
  // Nettoyage conservateur : si un seed a échoué avant le kill, tenter l'arrêt.
  const { createConnection } = await import("node:net");
  if (!existsSync(join(scope, "worker.ready")) || existsSync(join(scope, "worker.exited"))) return;
  await new Promise<void>((resolve) => {
    const socket = createConnection(join(scope, "w.sock"));
    socket.setTimeout(1_000, () => socket.destroy());
    socket.on("connect", () => socket.end("stop"));
    socket.on("error", () => {});
    socket.on("close", () => resolve());
    socket.resume();
  });
  const deadline = Date.now() + 5_000;
  while (!existsSync(join(scope, "worker.exited")) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

for (const scenario of SIGKILL_SCENARIOS) {
  test(`SIGKILL mid-${scenario === "generation" ? "generation" : "tool"} / reopen : reprise depuis checkpoints`, { timeout: 120_000 }, async () => {
    const scope = mkdtempSync(join(tmpdir(), `cog-durable-${scenario}-`));
    try {
      const boundary = await runPhase(scope, "seed", scenario, "{}");
      if (scenario === "generation") {
        assert(boundary && typeof boundary === "object" && "submissionId" in boundary, "point de contrôle atteint");
      } else {
        assert(boundary && typeof boundary === "object" && "point" in boundary, "point de contrôle outil atteint");
      }
      const recovered = await runPhase(scope, "reopen", scenario, JSON.stringify(boundary));
      assert(recovered && typeof recovered === "object" && "recovered" in recovered, `reprise prouvée: ${JSON.stringify(recovered)}`);
      assert.equal((recovered as { recovered: string }).recovered, scenario);
      if (scenario === "worker") {
        // Pas de fuite : marqueur de sortie écrit par l'orphelin arrêté.
        assert.equal(readFileSync(join(scope, "worker.exited"), "utf8"), "exited");
      }
    } finally {
      await stopLeftoverWorker(scope);
      rmSync(scope, { recursive: true, force: true });
      assert(!existsSync(scope));
    }
  });
}
