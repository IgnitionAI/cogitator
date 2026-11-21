/** `cogitator mcp …` : gestion des jetons du serveur MCP HTTP (hors ligne, sans serveur). */
import { createMcpToken, listMcpTokens, mcpTokenPath, revokeMcpToken } from "./mcp-tokens.js";
import { listOAuthGrants, revokeOAuthGrant } from "./mcp-oauth.js";
import type { McpScope } from "./mcp-tools.js";

export const MCP_USAGE = "Usage: cogitator mcp token create <name> [--scope read|full] | cogitator mcp token list | cogitator mcp token revoke <id|name>";

export function mcpCommand(home: string, port: number, args: string[], log: (line: string) => void = console.log): void {
  const [group, action, ...rest] = args;
  if (group !== "token") throw new Error(MCP_USAGE);
  if (action === "create") {
    let name: string | undefined;
    let scope: McpScope = "full";
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--scope") {
        const value = rest[++i];
        if (value !== "read" && value !== "full") throw new Error("--scope attend read ou full");
        scope = value;
      } else if (arg.startsWith("--scope=")) {
        const value = arg.slice("--scope=".length);
        if (value !== "read" && value !== "full") throw new Error("--scope attend read ou full");
        scope = value;
      } else if (!name && !arg.startsWith("--")) name = arg;
      else throw new Error(MCP_USAGE);
    }
    if (!name) throw new Error(MCP_USAGE);
    const { token, info } = createMcpToken(home, { name, scope });
    log(`Jeton MCP créé : ${info.name} (id ${info.id}, scope ${info.scope})`);
    log("");
    log(`  ${token}`);
    log("");
    log("Copiez-le maintenant : il ne sera plus affiché.");
    log(`Endpoint : http://127.0.0.1:${port}/mcp (ou https://<votre-origine>/mcp derrière le proxy HTTPS)`);
    log("En-tête  : Authorization: Bearer <jeton>");
    return;
  }
  if (action === "list" && rest.length === 0) {
    const tokens = listMcpTokens(home);
    const grants = listOAuthGrants(home);
    if (!tokens.length && !grants.length) { log(`Aucun jeton MCP (${mcpTokenPath(home)}).`); return; }
    for (const t of tokens) log(`${t.id}  ${t.scope.padEnd(4)}  ${t.created_at}  ${t.name}`);
    for (const g of grants) log(`${g.id}  ${g.scope.padEnd(4)}  ${g.created_at}  ${g.client_name} (OAuth, client ${g.client_id})`);
    return;
  }
  if (action === "revoke" && rest.length === 1) {
    if (!revokeMcpToken(home, rest[0]!) && !revokeOAuthGrant(home, rest[0]!)) throw new Error(`Jeton introuvable : ${rest[0]}`);
    log(`Jeton révoqué : ${rest[0]} (sessions ouvertes fermées à la prochaine requête).`);
    return;
  }
  throw new Error(MCP_USAGE);
}
