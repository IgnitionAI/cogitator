import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isInside } from "./execution/confinement.js";
import { parseGitHubRepo } from "./skills-import.js";

// shortcut: clone borné à 25 s pour finir sous le requestTimeout 30 s du serveur en
// mode auth ; à revoir si l'import de gros dépôts devient un cas d'usage supporté
// (tâche asynchrone hors requête) ou si le requestTimeout augmente.
const CLONE_TIMEOUT_MS = 25_000;

/** true si l'URL embarque des identifiants (`user:token@` sur tout schéma, `token@` sur
 *  https, utilisateur scp-like autre que `git` — ex. `ghp_…@hôte:o/r`, R3) — git les écrirait
 *  en clair dans `.git/config` du clone ; D1 veut les identifiants du poste, jamais dans
 *  l'URL. `git@hote:o/r` (scp-like) et `ssh://git@hote/…` restent légitimes : utilisateur
 *  ssh standard, sans mot de passe (L3). */
export function hasGitCredentials(source: string): boolean {
  const s = source.trim();
  return /^[^/:]+:\/\/[^/@\s]+:[^@\s]+@/.test(s) || /^https?:\/\/[^/@\s]+@/.test(s) || /^(?!git@)[^/@\s:]+@[^/@\s]+:/.test(s);
}

function isValidGitSource(source: string): boolean {
  return Boolean(source) && !source.startsWith("-") && !/^(ext::|file:)/.test(source) && !hasGitCredentials(source);
}

/** Masque les identifiants embarqués dans une URL : `user:token@`, `token@` (PAT en nom
 *  d'utilisateur) et l'utilisateur scp-like autre que `git` (`ghp_…@hôte:` — R3). */
function redactCredentials(url: string): string {
  return url
    .replace(/(\/\/)([^/@\s]*):[^@\s]+@/g, "$1$2:***@")
    .replace(/(\/\/)([^/@\s:]+)@/g, "$1***@")
    .replace(/\b(?!git@)[^/@\s:]+@/g, "***@");
}

/** Détail d'échec affichable : identifiants masqués, queue conservée (300 car max). */
export function gitErrorDetail(stderr: string): string {
  return redactCredentials(stderr.trim()).slice(-300);
}

/**
 * R1 : le raccourci nu `owner/repo` (D3) ne vaut que pour exactement 2 segments ;
 * `gitlab.com/o/r` serait sinon lu { owner: "gitlab.com", repo: "o" } → clone vers
 * github.com faux et fausse équivalence entre `gitlab.com/o/r1` et `/r2`. parseGitHubRepo
 * est partagé avec l'import de skills : la borne vit ici, côté git-import uniquement.
 */
function parseGitHubSource(source: string): { owner: string; repo: string } | null {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) return parseGitHubRepo(source);
  if (/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/.test(source)) return parseGitHubRepo(source);
  return null;
}

/** Un segment de chemin `.` ou `..` n'apparaît nulle part dans la source (S4). */
function hasDotSegments(source: string): boolean {
  return source.split(/[/:]/).some((segment) => segment === "." || segment === "..");
}

/**
 * Normalise une source git clonable (D3) : `owner/repo` → `https://github.com/owner/repo` ;
 * https, git@, ssh:// et chemins locaux conservés tels quels. Rejette les segments
 * `.`/`..` (traversée), le backslash, le préfixe `-`, les transports `ext::`/`file://`
 * et les identifiants embarqués dans l'URL (L3).
 */
export function normalizeGitUrl(url: string): string | null {
  const source = url.trim();
  if (!isValidGitSource(source) || source.includes("\\") || hasDotSegments(source)) return null;
  // https/git@/ssh:// et chemins locaux : conservés tels quels (identifiants ssh du poste).
  if (/^(?:https?:\/\/|git@|ssh:\/\/)/.test(source) || existsSync(source)) return source;
  const repo = parseGitHubSource(source);
  return repo ? `https://github.com/${repo.owner}/${repo.repo}` : source;
}

/** Dernier segment d'une source non GitHub ; vide si le segment serait dangereux (S4). */
function slugFor(source: string): string {
  const slug = source.replace(/\/+$/, "").split(/[/:]/).pop()?.replace(/\.git$/, "") ?? "";
  return slug === "." || slug === ".." || slug.includes("..") || slug.includes("\\") ? "" : slug;
}

/**
 * Destination de clone stable : `<root>/<owner>/<repo>` (GitHub) ou `<root>/<slug>`
 * (sinon). Renvoie aussi la source normalisée à cloner. Rejette explicitement les
 * segments `.`/`..` : seul relative() ne suffit pas, join() les ferait s'annuler
 * et ramènerait la destination dans la racine (S4).
 */
export function localDirFor(url: string, root: string): { dest: string; source: string } | { error: string } {
  // L3 : refus dédié (et sans echo de l'URL, qui porterait le secret en clair).
  if (hasGitCredentials(url)) return { error: "identifiants embarqués dans l'URL git refusés — utilise les identifiants git configurés sur ce poste" };
  const source = normalizeGitUrl(url);
  if (!source) return { error: `URL git invalide: ${redactCredentials(url.trim())}` };
  const repo = parseGitHubSource(source);
  const slug = repo ? repo.repo : slugFor(source);
  if (!slug) return { error: `URL git invalide: ${redactCredentials(source)}` };
  // Pas de garde relative() ici : owner/repo viennent de parseGitHubRepo (un segment
  // `[A-Za-z0-9_.-]+`, jamais `.`/`..` — hasDotSegments a filtré en amont) et slug est un
  // segment unique : join(root, …) ne peut pas en sortir (J1).
  const dest = repo ? join(root, repo.owner, slug) : join(root, slug);
  return { dest, source };
}

/** `dir` est-il sous `root` (formes lexicales canoniques) ? Garde B1 avant toute écriture. */
export function isInsideDir(path: string, root: string): boolean {
  return isInside(resolve(path), resolve(root));
}

function isGitWorkTree(dir: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
      resolvePromise(!err && stdout.trim() === "true");
    });
  });
}

/**
 * Forme canonique pour la comparaison littérale hors GitHub : barres obliques finales et
 * `.git` retirés des deux côtés, schéma et hôte en minuscules — sinon `https://gitlab.com/a/b/`
 * est refusée comme « dépôt différent » à destination identique (S4).
 */
function canonicalGitLiteral(source: string): string {
  const s = source.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = s.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]*)(\/.*)?$/i);
  return parts ? parts[1]!.toLowerCase() + (parts[2] ?? "") : s;
}

/**
 * Même source à formes d'URL équivalentes près : `https://github.com/o/r`,
 * `git@github.com:o/r.git` et `…/o/r.git` désignent le même dépôt (comparaison
 * `owner/repo` insensible à la casse quand le parsing réussit des deux côtés) ; sinon
 * comparaison littérale canonique (M2, S4).
 */
function sameGitSource(origin: string, source: string): boolean {
  const a = parseGitHubSource(origin);
  const b = parseGitHubSource(source);
  if (a && b) return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
  return canonicalGitLiteral(origin) === canonicalGitLiteral(source);
}

/** URL d'origine d'un dépôt existant, null si absente ou illisible. */
function originOf(dir: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
      resolvePromise(err ? null : stdout.trim());
    });
  });
}

/**
 * Clone `url` vers `dest` avec les identifiants git ambiants (D1 : dépôt privé si le
 * poste est déjà authentifié ; aucun token stocké, lu ni affiché). GIT_TERMINAL_PROMPT=0 :
 * échec explicite, jamais de prompt bloquant. Un dossier existant et valide est repris
 * (clone orphelin, D4). `created` distingue « dossier créé par ce clone » de « dossier
 * préexistant » pour que l'appelant ne supprime que le premier (S3) ; `cloned` distingue
 * la reprise d'un clone frais.
 */
export async function cloneRepo(url: string, dest: string): Promise<{ dir: string; cloned: boolean; created: boolean } | { error: string }> {
  const source = url.trim();
  if (!isValidGitSource(source)) return { error: `URL git invalide: ${redactCredentials(source)}` };
  const preExisting = existsSync(dest);
  if (preExisting) {
    if (await isGitWorkTree(dest)) {
      // Un dossier existant n'est repris que s'il vient de la même source : sinon deux
      // dépôts de même dernier segment se partageraient la destination (mauvais contenu).
      const origin = await originOf(dest);
      if (origin !== null && sameGitSource(origin, source)) return { dir: dest, cloned: false, created: false };
      return { error: `dépôt différent déjà cloné à cet emplacement: ${dest}` };
    }
  } else {
    mkdirSync(dirname(dest), { recursive: true });
  }
  try {
    await new Promise<void>((resolvePromise, reject) => {
      execFile(
        "git",
        ["clone", "--quiet", "--", source, dest],
        { timeout: CLONE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        (err, _stdout, stderr) => (err ? reject(new Error(gitErrorDetail(stderr) || gitErrorDetail(err.message))) : resolvePromise()),
      );
    });
    return { dir: dest, cloned: true, created: !preExisting };
  } catch (err) {
    // Ne supprime que ce qu'on a créé, et pas si un import concurrent a gagné la course
    // en laissant un dépôt valide à cette destination. Nettoyage best-effort : un rmSync
    // qui lève ne doit pas masquer l'erreur de clone d'origine (S2).
    // shortcut: un crash serveur pendant le clone laisse un dossier partiel (preExisting
    // au réimport → échec répété « clone échoué », aucun recours UI) ; à revoir si un
    // nettoyage de clones orphelins non enrôlés est un jour ajouté (L4).
    if (!preExisting && !(await isGitWorkTree(dest))) {
      try {
        rmSync(dest, { recursive: true, force: true });
      } catch {
        /* dossier résiduel possible, signalé par l'erreur d'origine */
      }
    }
    return { error: `clone échoué: ${err instanceof Error ? err.message : String(err)}` };
  }
}
