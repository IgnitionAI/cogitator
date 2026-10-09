import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerEntry } from "./mcp-env.js";

/** Config figée de spawn (snapshot d'un preset ou choix ad hoc) — O6 du contrat. */
export interface SpawnConfig {
  provider: string;
  model: string;
  thinking?: string | null;
  systemPrompt?: string;
  /** Contrat UI copié à la création ; absent des anciens snapshots. */
  uiInstructions?: string;
  skills?: string[];
  tools?: string[] | null;
  /** Serveurs MCP du preset — transportés via env et enregistrés par l'extension au session_start (ADR-002) */
  mcpServers?: McpServerEntry[];
}

/** Snapshot d'un preset d'agent (type structurel : pas de dépendance vers agents.js). */
export function spawnConfigFromPreset(preset: {
  provider: string;
  model: string;
  thinking?: string | null;
  system_prompt?: string;
  skills?: string[];
  tools_allowlist?: string[] | null;
  mcp_servers?: McpServerEntry[];
}): SpawnConfig {
  return {
    provider: preset.provider,
    model: preset.model,
    thinking: preset.thinking,
    systemPrompt: preset.system_prompt || undefined,
    skills: preset.skills,
    tools: preset.tools_allowlist,
    mcpServers: preset.mcp_servers,
  };
}

export function modelArg(c: SpawnConfig): string {
  return c.thinking ? `${c.provider}/${c.model}:${c.thinking}` : `${c.provider}/${c.model}`;
}

/**
 * Matérialise un SpawnConfig en flags natifs pi (ADR-001).
 * Effet de bord unique : écrit le fichier du system prompt dans tmpDir.
 */
export function buildArgs(c: SpawnConfig, tmpDir: string, convId: string): string[] {
  mkdirSync(tmpDir, { recursive: true });
  // pi n'accepte pas la forme --flag=valeur : tout passe en deux éléments
  const args = ["--model", modelArg(c)];
  const systemPrompt = [c.systemPrompt, c.uiInstructions].filter(Boolean).join("\n\n");
  if (systemPrompt) {
    const file = join(tmpDir, `${convId}.prompt.md`);
    writeFileSync(file, systemPrompt);
    args.push("--append-system-prompt", file);
  }
  if (c.skills?.length) {
    args.push("--no-skills"); // O5 : skills exactes, jamais de fusion avec la découverte globale
    for (const skill of c.skills) args.push("--skill", skill);
  }
  if (c.tools?.length) args.push("--tools", c.tools.join(","));
  return args;
}
