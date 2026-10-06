import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMcpEnv, MCP_ENV_VAR } from "../src/mcp-env.js";

// I4 : l'entry de l'extension ne démarre RIEN au load — uniquement la commande et
// l'enregistrement MCP (qui ne fait que déclarer des serveurs, le builtin connecte).

const HOST = "127.0.0.1";
const PORT = Number(process.env.COGITATOR_PORT ?? 5320);
const BASE = `http://${HOST}:${PORT}`;

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/health`);
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

export default function (pi: ExtensionAPI) {
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
    description: "Ouvrir le panneau de contrôle Cogitator (démarre le serveur si besoin)",
    handler: async (_args, ctx) => {
      if (!(await isUp())) {
        const here = dirname(fileURLToPath(import.meta.url)); // dist/extensions
        const entry = join(here, "..", "src", "cli.js");
        spawn(process.execPath, [entry], { detached: true, stdio: "ignore" }).unref();
        for (let i = 0; i < 50; i++) {
          if (await isUp()) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      openBrowser(BASE);
      ctx.ui.notify(`Cogitator — ${BASE}`, "info");
    },
  });
}
