import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface FixtureRoots {
  controller: string;
  daemon: string;
}

export function fixtureRootsFromEnv(env: NodeJS.ProcessEnv): FixtureRoots | undefined {
  const controller = env.COGITATOR_TEST_CONTROLLER_ROOT;
  const daemon = env.COGITATOR_TEST_DAEMON_ROOT;
  if (controller === undefined && daemon === undefined) return undefined;
  if (!controller || !daemon || !isAbsolute(controller) || !isAbsolute(daemon)) {
    throw new Error("fixture Docker: deux racines absolues requises (contrôleur et daemon)");
  }
  // Seule la racine contrôleur existe dans cet espace de chemins.
  return { controller: realpathSync(controller), daemon: resolve(daemon) };
}

/** Reçoit la source canonicalisée par l'enrôlement, après validation de la spec. */
export function daemonFixtureSource(canonicalSource: string, roots?: FixtureRoots): string {
  if (!roots) return canonicalSource;
  if (!isAbsolute(canonicalSource)) throw new Error("source fixture non absolue");
  const suffix = relative(roots.controller, canonicalSource);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error("source fixture hors de la racine contrôleur");
  }
  return join(roots.daemon, suffix);
}
