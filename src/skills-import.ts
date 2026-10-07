import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface ImportResult {
  imported: string[];
  skipped: string[];
  error?: string;
}

/** Bornes de l'exploration et des transferts (une source hostile ne doit pas saturer le disque). */
const SCAN_MAX_DEPTH = 2;
const SCAN_MAX_SKILLS = 50;
const ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;
const CLI_MAX_BUFFER = 5 * 1024 * 1024;
const CLI_TIMEOUT_MS = 180_000;
const CLI_OUTPUT_TAIL_LINES = 3;

/** Nom de dossier sûr pour un skill (kebab-case, pas de traversal). */
export function sanitizeSkillName(name: string): string {
  const clean = basename(name).replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "skill";
}

/**
 * Trouve les dossiers contenant un SKILL.md sous root (profondeur ≤ 2,
 * node_modules/.git/cachés exclus). Les sous-dossiers d'un dossier-skill ne sont pas remontés.
 */
export function scanSkillDirs(root: string, depth = 0, found: string[] = []): string[] {
  if (depth > SCAN_MAX_DEPTH || found.length > SCAN_MAX_SKILLS) return found;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    found.push(root);
    return found; // c'est un skill : ne pas descendre dedans
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    scanSkillDirs(join(root, e.name), depth + 1, found);
  }
  return found;
}

/** Copie les skills trouvés sous srcDir vers destRoot (~/.agents/skills). */
export function importFromDir(srcDir: string, destRoot: string, overwrite = false): ImportResult {
  const result: ImportResult = { imported: [], skipped: [] };
  const skills = scanSkillDirs(srcDir);
  mkdirSync(destRoot, { recursive: true });
  for (const dir of skills) {
    const name = sanitizeSkillName(basename(dir));
    const target = join(destRoot, name);
    if (existsSync(target) && !overwrite) {
      result.skipped.push(name);
      continue;
    }
    rmSync(target, { recursive: true, force: true });
    cpSync(dir, target, { recursive: true });
    result.imported.push(name);
  }
  if (skills.length === 0) result.error = `aucun SKILL.md trouvé sous ${srcDir}`;
  return result;
}

/** Normalise une URL GitHub (https://github.com/o/r, o/r, git@…:o/r.git) → { owner, repo }. */
export function parseGitHubRepo(source: string): { owner: string; repo: string } | null {
  const s = source.trim().replace(/\.git$/, "").replace(/^git@github\.com:/, "");
  const m = s.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\/.*)?$/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

/**
 * Importe les skills d'un repo GitHub : tarball (branche main, repli master) →
 * extraction via le `tar` système → copie des dossiers SKILL.md.
 * ponytail: extraction déléguée au tar système (macOS/Linux) ; Windows nécessiterait une implémentation native ou la dép `tar`.
 */
export async function importFromGitHub(source: string, destRoot: string, overwrite = false): Promise<ImportResult> {
  const repo = parseGitHubRepo(source);
  if (!repo) return { imported: [], skipped: [], error: `source GitHub invalide: ${source}` };

  const tmp = mkdtempSync(join(tmpdir(), "cog-skills-"));
  try {
    let archive: Buffer | null = null;
    for (const branch of ["main", "master"]) {
      const url = `https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz/refs/heads/${branch}`;
      const res = await fetch(url);
      if (res.ok) {
        archive = Buffer.from(await res.arrayBuffer());
        break;
      }
    }
    if (!archive) return { imported: [], skipped: [], error: `repo introuvable ou privé: ${repo.owner}/${repo.repo}` };
    if (archive.length > ARCHIVE_MAX_BYTES) return { imported: [], skipped: [], error: "tarball > 20 Mo — refusé" };

    const tgz = join(tmp, "repo.tar.gz");
    writeFileSync(tgz, archive);
    const extractDir = join(tmp, "extract");
    mkdirSync(extractDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile("tar", ["-xzf", tgz, "-C", extractDir], (err) => (err ? reject(err) : resolve()));
    });
    const roots = readdirSync(extractDir).filter((e) => statSync(join(extractDir, e)).isDirectory());
    if (roots.length === 0) return { imported: [], skipped: [], error: "tarball vide" };
    return importFromDir(join(extractDir, roots[0]!), destRoot, overwrite);
  } catch (err) {
    return { imported: [], skipped: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Point d'entrée unique : URL GitHub, chemin local, ou commande npx/npm. */
export function importSkills(source: string, destRoot: string, overwrite = false): Promise<ImportResult> {
  if (/^npx\s|^npm\s/.test(source.trim())) {
    return runSkillCommand(source.trim(), [destRoot]);
  }
  if (/^(https?:\/\/github\.com\/|git@github\.com:|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?$)/.test(source.trim()) && !existsSync(source)) {
    return importFromGitHub(source, destRoot, overwrite);
  }
  if (existsSync(source) && statSync(source).isDirectory()) {
    return Promise.resolve(importFromDir(source, destRoot, overwrite));
  }
  return Promise.resolve({ imported: [], skipped: [], error: `source non reconnue: ${source}` });
}

/**
 * Exécute un CLI d'installation de skills (npx/npm) et rapporte les skills apparus.
 * Sécurité : npx/npm uniquement (pas de shell), timeout 3 min, args par découpage simple
 * (pas de quotes — limitation assumée, ponytail: découper avec un vrai shell-quote si besoin).
 */
export async function runSkillCommand(cmd: string, destRoots: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<ImportResult> {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const bin = tokens[0];
  if (bin !== "npx" && bin !== "npm") {
    return { imported: [], skipped: [], error: "seuls npx et npm sont autorisés comme commande d'import" };
  }
  const snapshot = new Set<string>();
  for (const root of destRoots) {
    for (const dir of scanSkillDirs(root)) snapshot.add(sanitizeSkillName(basename(dir)));
  }

  try {
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
      // certains CLI renvoient un code non nul tout en ayant installé : on garde la sortie
      execFile(bin, tokens.slice(1), { timeout: timeoutMs, maxBuffer: CLI_MAX_BUFFER }, (_err, out, serr) => {
        resolve({ stdout: String(out), stderr: String(serr) });
      });
    });
    const imported: string[] = [];
    for (const root of destRoots) {
      for (const dir of scanSkillDirs(root)) {
        const name = sanitizeSkillName(basename(dir));
        if (!snapshot.has(name)) imported.push(name);
      }
    }
    const result: ImportResult = { imported: [...new Set(imported)], skipped: [] };
    if (result.imported.length === 0) {
      const tail = (stderr || stdout).trim().split("\n").slice(-CLI_OUTPUT_TAIL_LINES).join(" | ");
      result.error = `commande exécutée mais aucun skill nouveau détecté${tail ? ` — sortie: ${tail}` : ""}`;
    }
    return result;
  } catch (err) {
    return { imported: [], skipped: [], error: err instanceof Error ? err.message : String(err) };
  }
}
