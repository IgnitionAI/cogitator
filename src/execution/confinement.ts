/**
 * Confinement de chemins pour l'exécution distante (Plan 0002 §4, phase P2).
 *
 * Résolution realpath avec rejet des échappées par symlink sur lectures,
 * écritures, imports et enrôlement de workspaces. Le montage conteneur reste
 * la containment primaire (ADR-008 D5) ; ces vérifications sont la défense en
 * profondeur — un TOCTOU entre la vérification et l'ouverture côté hôte reste
 * possible, d'où l'obligation du worker rootless en conteneur pour les missions
 * distantes.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { authenticationRequired } from "../config.js";

export type ConfinedResult = { path: string } | { error: string };

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * Résout `requested` de façon canonique et garantit qu'il reste sous la racine
 * réelle (après résolution des symlinks). Un symlink intermédiaire pointant
 * hors de la racine est rejeté, y compris pour un fichier qui n'existe pas
 * encore (écriture) : on canonicalise le plus long préfixe existant puis on
 * résout le reste lexicalement.
 */
export function resolveConfined(rootDir: string, requested: string): ConfinedResult {
  let root: string;
  try {
    root = realpathSync(resolve(rootDir));
  } catch {
    return { error: `racine illisible: ${rootDir}` };
  }
  const target = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  let existing = target;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return { error: "chemin hors du workspace" };
    tail.unshift(basename(existing));
    existing = parent;
  }
  let base: string;
  try {
    base = realpathSync(existing);
  } catch {
    return { error: "chemin hors du workspace" };
  }
  const path = join(base, ...tail);
  if (!isInside(path, root)) return { error: "chemin hors du workspace" };
  return { path };
}

// ---------- Enrôlement de workspaces ----------

export interface EnrollmentPolicy {
  /** true = mode distant (authentification requise) : enrôlement restreint aux racines enrôlées. */
  remote: boolean;
  /** Racines enrôlées (dossiers jetables enregistrés) dans lesquelles seuls les workspaces distants vivent. */
  enrolledRoots: string[];
}

export type EnrollmentResult = { dir: string } | { error: string };

function enrolledDir(policy: EnrollmentPolicy, requested: string): EnrollmentResult {
  const target = resolve(requested);
  // Casse /var → /private/var (macOS) et liens au-dessus de la racine : comparer
  // les formes canoniques des deux côtés, tout en détectant les symlinks sortants.
  let canonical: string | null = null;
  try {
    canonical = realpathSync(target);
  } catch {
    /* dossier inexistant : refusé par l'appelant avant l'enrôlement */
  }
  for (const enrolled of policy.enrolledRoots) {
    let root: string;
    try {
      root = realpathSync(resolve(enrolled));
    } catch {
      continue; // racine enrôlée absente : on essaye les autres
    }
    const lexInside = isInside(target, resolve(enrolled));
    const canonInside = canonical !== null && isInside(canonical, root);
    if (!lexInside && !canonInside) continue;
    if (!canonInside) return { error: "enrôlement refusé: symlink hors de la racine enrôlée" };
    const confined = resolveConfined(root, target);
    if ("error" in confined) return { error: "enrôlement refusé: symlink hors de la racine enrôlée" };
    return { dir: confined.path };
  }
  return { error: "enrôlement de dossier arbitraire désactivé en mode distant (hors racines enrôlées)" };
}

/**
 * Enrôlement d'un dossier de travail. Mode distant : seuls les dossiers sous
 * une racine enrôlée sont acceptés et un symlink qui déplace le dossier hors
 * de sa racine est rejeté (Plan 0002 §4 : l'enrôlement ne rend pas le dossier
 * original jetable). Mode local : comportement historique (canonicalisation).
 */
export function enrollWorkspaceDir(policy: EnrollmentPolicy, requested: string): EnrollmentResult {
  if (policy.remote) return enrolledDir(policy, requested);
  try {
    return { dir: realpathSync(requested) };
  } catch {
    return { error: `dossier illisible: ${requested}` };
  }
}

/** Politique d'enrôlement depuis l'environnement (mode distant = authentification requise, fail-closed). */
export function enrollmentPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): EnrollmentPolicy {
  return {
    remote: authenticationRequired(env),
    enrolledRoots: (env.COGITATOR_ENROLLED_ROOTS ?? "").split(":").map((p) => p.trim()).filter(Boolean),
  };
}
