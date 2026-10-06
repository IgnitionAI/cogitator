/** Entrée MCP au format mcpServers — type dérivé du schéma zod (source unique de vérité). */
import type { McpServerEntry } from "./schemas.js";
export type { McpServerEntry } from "./schemas.js";

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
