/** Entrée MCP au format mcpServers (mcp.json / registerMcpServer). */
export interface McpServerEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** Nom de la variable d'environnement qui transporte les serveurs MCP d'un preset vers la session pi. */
export const MCP_ENV_VAR = "COGITATOR_MCP";

/** Sérialise les entrées pour l'env (seules les entrées valides passent : name + command|url). */
export function encodeMcpEnv(entries: McpServerEntry[]): string | undefined {
  const valid = entries.filter((e) => e.name && (e.command || e.url));
  return valid.length ? JSON.stringify(valid) : undefined;
}

export interface McpRegistration {
  name: string;
  config: Omit<McpServerEntry, "name">;
}

/** Parse l'env côté extension ; null si absent/invalide. */
export function decodeMcpEnv(raw: string | undefined): McpRegistration[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: McpRegistration[] = [];
  for (const item of parsed as McpServerEntry[]) {
    if (!item || typeof item !== "object" || !item.name || (!item.command && !item.url)) continue;
    const { name, ...config } = item;
    out.push({ name, config });
  }
  return out;
}
