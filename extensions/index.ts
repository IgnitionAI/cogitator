import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { getPaths } from "../src/paths.js";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL } from "../src/config.js";
import { decodeMcpEnv, MCP_ENV_VAR } from "../src/mcp-env.js";

// I4 : l'entry de l'extension ne démarre RIEN au load — uniquement la commande et
// l'enregistrement MCP (qui ne fait que déclarer des serveurs, le builtin connecte).

/** Attente du démarrage du serveur détaché : ~5 s au total. */
const STARTUP_ATTEMPTS = 50;
const STARTUP_POLL_MS = 100;

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/status`);
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

async function postTeamSend(payload: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/team/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json() as { error?: string };
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
  return JSON.stringify(data);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "team_send",
    label: "Team send",
    description: "Envoie un message durable à une autre conversation Cogitator (file lane/queue_item, limite de sauts).",
    parameters: Type.Object({
      conversation_id: Type.String({ description: "Conversation destinataire" }),
      body: Type.String(),
      idempotency_key: Type.Optional(Type.String()),
      hop: Type.Optional(Type.Number()),
      chain_id: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const text = await postTeamSend({
        conversation_id: params.conversation_id,
        body: params.body,
        from_conversation_id: process.env.COGITATOR_CONVERSATION_ID,
        idempotency_key: params.idempotency_key,
        hop: params.hop,
        chain_id: params.chain_id,
      });
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // ADR-002 : les serveurs MCP du preset voyagent via env (COGITATOR_MCP) et sont
  // enregistrés ici ; le support MCP builtin de pi les connecte au démarrage de session.
  pi.on("session_start", () => {
    const registrations = decodeMcpEnv(process.env[MCP_ENV_VAR]);
    if (!registrations) return;
    for (const { name, config } of registrations) {
      try {
        // shape mcpServers validée à l'encodage ; le type exact de pi est plus étroit
        pi.registerMcpServer(name, config as Parameters<typeof pi.registerMcpServer>[1]);
      } catch (err) {
        console.warn(`[cogitator] registerMcpServer ${name}:`, err instanceof Error ? err.message : err);
      }
    }
  });

  pi.registerCommand("cogitator", {
    description: "Start the local Cogitator web panel if needed, then open it in the browser",
    handler: async (_args, ctx) => {
      if (!(await isUp())) {
        const here = dirname(fileURLToPath(import.meta.url)); // dist/extensions
        const entry = join(here, "..", "src", "cli.js");
        spawn(process.execPath, [entry], { detached: true, stdio: "ignore" }).unref();
        for (let i = 0; i < STARTUP_ATTEMPTS; i++) {
          if (await isUp()) break;
          await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
        }
      }
      if (!(await isUp())) {
        ctx.ui.notify("Cogitator unavailable: check the server/auth state and stop incompatible previous instances.", "error");
        return;
      }
      let browserUrl = BASE_URL;
      if (process.env.COGITATOR_URL === undefined) {
        try {
          const config: unknown = JSON.parse(readFileSync(join(getPaths().home, "auth", "config.json"), "utf8"));
          if (config && typeof config === "object" && "origin" in config && typeof config.origin === "string") {
            const url = new URL(config.origin);
            if (url.protocol === "https:" && url.origin === config.origin) browserUrl = url.origin;
          }
        } catch { /* Existing local mode has no auth configuration. */ }
      }
      openBrowser(browserUrl);
      ctx.ui.notify(`Cogitator — ${browserUrl}`, "info");
    },
  });
}
