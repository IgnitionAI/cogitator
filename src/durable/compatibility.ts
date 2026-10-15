/**
 * Admission durable et matrice de compatibilité (Plan 0002 §4/§6) : tant qu'une
 * commande, un serveur MCP ou une extension n'est pas classé et testé, elle est
 * INDISPONIBLE pour les missions durables. On bloque les presets non supportés
 * au lieu d'élargir silencieusement l'accès (fail closed).
 *
 * La matrice publiée des profils supportés vit dans docs/durable-compatibility.md.
 */

import {
  assertMcpServerApproved,
  assertExtensionApproved,
  DEFAULT_APPROVED_COMMANDS,
  type ToolchainRegistry,
} from "../execution/egress.js";
import type { SpawnConfig } from "../spawn.js";

export class DurableAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableAdmissionError";
  }
}

function envList(env: NodeJS.ProcessEnv, key: string): string[] {
  return (env[key] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Registre toolchain pour les missions durables : défaut P2 (commandes de la
 * toolchain approuvées, aucun MCP ni extension) + approbations explicites par
 * l'environnement d'exploitation. Rien n'est approuvé implicitement.
 */
export function durableToolchainRegistry(env: NodeJS.ProcessEnv = process.env): ToolchainRegistry {
  const commands = new Set<string>(DEFAULT_APPROVED_COMMANDS);
  const mcps = new Set<string>();
  const extensions = new Set<string>();
  for (const name of envList(env, "COGITATOR_DURABLE_APPROVED_COMMANDS")) commands.add(name);
  for (const name of envList(env, "COGITATOR_DURABLE_APPROVED_MCPS")) mcps.add(name);
  for (const name of envList(env, "COGITATOR_DURABLE_APPROVED_EXTENSIONS")) extensions.add(name);
  return { approvedCommands: commands, approvedMcpServers: mcps, approvedExtensions: extensions };
}

/**
 * Gate d'admission d'une mission durable : chaque serveur MCP déclaré dans le
 * snapshot figé doit être classé. Sinon l'admission échoue et aucun travail
 * caché n'est créé. (Les commandes se classent au niveau outil/CI, pas dans le
 * snapshot spawn.)
 */
export function assertDurableAdmission(registry: ToolchainRegistry, spawn: SpawnConfig): void {
  try {
    for (const server of spawn.mcpServers ?? []) assertMcpServerApproved(registry, server.name);
  } catch (err) {
    throw new DurableAdmissionError(
      `admission durable refusée (fail closed): ${err instanceof Error ? err.message : String(err)} — voir docs/durable-compatibility.md`,
    );
  }
}

/** Vérifie une capacité ponctuelle au nom de la runtime durable (extensions gelées). */
export function assertDurableExtension(registry: ToolchainRegistry, name: string): void {
  try {
    assertExtensionApproved(registry, name);
  } catch (err) {
    throw new DurableAdmissionError(err instanceof Error ? err.message : String(err));
  }
}
