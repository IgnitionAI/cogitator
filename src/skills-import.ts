import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface ImportResult {
  imported: string[];
  skipped: string[];
  error?: string;
}

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
  if (depth > 2 || found.length > 50) return found;
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
    if (archive.length > 20 * 1024 * 1024) return { imported: [], skipped: [], error: "tarball > 20 Mo — refusé" };

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

/** Point d'entrée unique : URL GitHub ou chemin local. */
export function importSkills(source: string, destRoot: string, overwrite = false): Promise<ImportResult> {
  if (/^(https?:\/\/github\.com\/|git@github\.com:|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?$)/.test(source.trim()) && !existsSync(source)) {
    return importFromGitHub(source, destRoot, overwrite);
  }
  if (existsSync(source) && statSync(source).isDirectory()) {
    return Promise.resolve(importFromDir(source, destRoot, overwrite));
  }
  return Promise.resolve({ imported: [], skipped: [], error: `source non reconnue: ${source}` });
}

/** Vérif qu'un SKILL.md a un frontmatter minimal (name + description) — signalé, pas bloquant. */
export function skillWarnings(dir: string): string[] {
  const warnings: string[] = [];
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return [`SKILL.md manquant: ${dir}`];
  const text = readFileSync(file, "utf8");
  if (!/^name:\s*\S+/m.test(text)) warnings.push(`${basename(dir)}: frontmatter sans name`);
  const desc = /^description:\s*(.+)$/m.exec(text)?.[1] ?? "";
  if (!desc) warnings.push(`${basename(dir)}: frontmatter sans description`);
  else if (desc.length > 1024) warnings.push(`${basename(dir)}: description > 1024 caractères`);
  return warnings;
}
