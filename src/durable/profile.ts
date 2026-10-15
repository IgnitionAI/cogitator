/**
 * Profil de mission figé (Plan 0002 §5 « Mission » + O6) — versions gelées à
 * l'acceptation et vérifiées à chaque ouverture (preflight fail-closed).
 *
 * Durable possède la vérité de mission (D4) : le profil gelé vit dans le
 * stockage Durable de la conversation, jamais dans le catalogue. Toute
 * divergence SDK/preset/toolchain entre la création et une reprise rejette
 * l'ouverture au lieu de changer les capacités d'une mission en vol.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { defineDoc } from "@earendil-works/pi-durable";

/** Version pinnée du SDK Durable (Plan 0002 §10, spike P0). */
export const DURABLE_SDK_PIN = "1.1.0";

const require = createRequire(import.meta.url);

/** Version réellement installée du SDK (sous-chemin package.json exporté par le paquet). */
export function installedDurableSdkVersion(): string {
  const pkg = require("@earendil-works/pi-durable/package.json") as { version?: string };
  return pkg.version ?? "unknown";
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Capacités classées de la toolchain, gelées par mission (snapshot du registre P2). */
export type FrozenToolchain = {
  /** Commandes approuvées (sorted). */
  commands: string[];
  /** Serveurs MCP approuvés (sorted). */
  mcpServers: string[];
  /** Extensions Durable installées (sorted). */
  extensions: string[];
};

/** Versions gelées à l'acceptation de la mission. */
export type MissionVersions = {
  /** Pin du SDK Durable. */
  sdk: string;
  /** Digest SHA-256 du snapshot spawn figé à la création (O6). */
  presetDigest: string;
  toolchain: FrozenToolchain;
};

export type MissionProfileDoc = MissionVersions & { createdAt: number };

export const MissionProfile = defineDoc<MissionProfileDoc>({
  kind: "cogitator.mission-profile",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    sdk: "",
    presetDigest: "",
    toolchain: { commands: [], mcpServers: [], extensions: [] },
    createdAt: 0,
  }),
});

export class MissionProfileFrozenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionProfileFrozenError";
  }
}

export function freezeMissionProfile(presetDigest: string, toolchain: FrozenToolchain): MissionVersions {
  if (installedDurableSdkVersion() !== DURABLE_SDK_PIN) {
    // Fail closed : on n'exécute pas une mission sur un SDK non pinné.
    throw new MissionProfileFrozenError(
      `SDK Durable ${installedDurableSdkVersion()} ≠ pin ${DURABLE_SDK_PIN} : admission durable refusée`,
    );
  }
  return { sdk: DURABLE_SDK_PIN, presetDigest, toolchain };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** Compare le profil gelé (stockage Durable) aux versions installées. Toute divergence rejette. */
export function assertProfileFrozen(
  stored: MissionProfileDoc | undefined,
  expected: MissionVersions,
  installedExtensions: readonly string[],
): void {
  if (!stored || stored.createdAt === 0) {
    throw new MissionProfileFrozenError("mission durable sans profil gelé : refus d'ouverture (fail closed)");
  }
  if (stored.sdk !== expected.sdk) {
    throw new MissionProfileFrozenError(`SDK Durable figé ${stored.sdk} ≠ installé ${expected.sdk}`);
  }
  if (stored.presetDigest !== expected.presetDigest) {
    throw new MissionProfileFrozenError("snapshot preset figé divergent : la mission ne change pas de capacités en vol (O6)");
  }
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && sorted(a).every((v, i) => v === sorted(b)[i]);
  if (!same(stored.toolchain.commands, expected.toolchain.commands)) {
    throw new MissionProfileFrozenError("toolchain (commandes) divergente du gel de mission");
  }
  if (!same(stored.toolchain.mcpServers, expected.toolchain.mcpServers)) {
    throw new MissionProfileFrozenError("toolchain (MCP) divergente du gel de mission");
  }
  if (!same(stored.toolchain.extensions, expected.toolchain.extensions)) {
    throw new MissionProfileFrozenError("extensions durables divergentes du gel de mission");
  }
  for (const ext of stored.toolchain.extensions) {
    if (!installedExtensions.includes(ext)) {
      throw new MissionProfileFrozenError(`extension durable absente de l'installation: ${ext}`);
    }
  }
}
