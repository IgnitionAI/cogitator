import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Config figée de spawn (snapshot d'un preset ou choix ad hoc) — O6 du contrat. */
export interface SpawnConfig {
  provider: string;
  model: string;
  thinking?: string | null;
  systemPrompt?: string;
  skills?: string[];
  tools?: string[] | null;
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
  if (c.systemPrompt) {
    const file = join(tmpDir, `${convId}.prompt.md`);
    writeFileSync(file, c.systemPrompt);
    args.push("--append-system-prompt", file);
  }
  if (c.skills?.length) {
    args.push("--no-skills"); // O5 : skills exactes, jamais de fusion avec la découverte globale
    for (const skill of c.skills) args.push("--skill", skill);
  }
  if (c.tools?.length) args.push("--tools", c.tools.join(","));
  return args;
}
