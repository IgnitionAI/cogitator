/**
 * Génome d'avatar : tout ce qui distingue la tête de machine d'un agent, déduit de l'agent lui-même.
 * Pur et déterministe (pas de three.js ici) : le même agent donne toujours la même tête.
 */

export type AvatarType = "novice" | "artificier" | "archiviste" | "logisticien" | "sentinelle" | "oracle" | "intendant";

export interface AvatarGenome {
  type: AvatarType;
  seed: number;
  /** Teinte des optiques, 0..1. */
  hue: number;
  /** Dents des engrenages d'oreille. */
  teeth: number;
  /** Usure du métal, 0..1. */
  wear: number;
  /** Un voyant sur la crête par compétence (plafonné). */
  leds: number;
  /** Une antenne par sous-agent (plafonné). */
  antennas: number;
  /** Couleur du métal des finitions, selon le fournisseur. */
  metal: number;
}

export interface AvatarSource {
  id: string;
  name: string;
  description?: string | null;
  provider?: string | null;
  skills?: string[] | null;
  subagents?: unknown[] | null;
}

export const AVATAR_TYPES: AvatarType[] = ["novice", "artificier", "archiviste", "logisticien", "sentinelle", "oracle", "intendant"];

const METALS: Array<[RegExp, number]> = [
  [/anthropic|claude/i, 0xc8794a], // cuivre
  [/openai|gpt|codex/i, 0xd8ac4c], // or
  [/google|gemini/i, 0x7fb0a8], // vert-de-gris
  [/kimi|moonshot/i, 0x9aa3b4], // acier
];
const DEFAULT_METAL = 0xb59a5a; // laiton

// Ordre = priorité : « QA & Recette — Jeux 3D » est une Sentinelle, pas un Oracle.
const RULES: Array<[RegExp, AvatarType]> = [
  [/\bqa\b|recette|\btests?\b|testeur|tester|sécu|secu|security|audit/i, "sentinelle"],
  [/majordome|butler|assistant|secrétaire|concierge|intendant/i, "intendant"],
  [/three|\b3d\b|design|créa|crea|artist|graphi|ux\b|\bui\b/i, "oracle"],
  [/dévelop|develop|\bdev\b|code|codeur|coder|ingénieur|engineer|programm|gameplay/i, "artificier"],
  [/chef|projet|project|manager|architecte|architect|planif|plann|\bops\b|devops|coordin/i, "logisticien"],
  [/expert|relect|review|recherche|research|doc|analy|archiv|savant|\brl\b/i, "archiviste"],
];

export function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 : petit générateur pseudo-aléatoire reproductible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Type deviné d'après le nom, puis la description et les compétences. */
export function avatarType(source: Pick<AvatarSource, "name" | "description" | "skills">): AvatarType {
  for (const [re, type] of RULES) if (re.test(source.name)) return type;
  const rest = [source.description ?? "", ...(source.skills ?? [])].join(" ");
  for (const [re, type] of RULES) if (re.test(rest)) return type;
  return "novice";
}

export function providerMetal(provider: string | null | undefined): number {
  for (const [re, color] of METALS) if (provider && re.test(provider)) return color;
  return DEFAULT_METAL;
}

export function agentGenome(source: AvatarSource): AvatarGenome {
  const seed = hashString(source.id);
  const random = seededRandom(seed);
  return {
    type: avatarType(source),
    seed,
    hue: random(),
    teeth: 8 + Math.floor(random() * 4),
    wear: random(),
    leds: Math.min(6, source.skills?.length ?? 0),
    antennas: Math.min(3, source.subagents?.length ?? 0),
    metal: providerMetal(source.provider),
  };
}

/** Clé de cache : deux génomes égaux donnent la même vignette. */
export function genomeKey(genome: AvatarGenome): string {
  return [genome.type, genome.seed, genome.leds, genome.antennas, genome.metal].join(":");
}
