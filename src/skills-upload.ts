import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { checkRequestAuthorization } from "./request-authorization.js";

export interface SkillUploadFile { path: string; content: string }
/** Browser directory uploads contain relative paths, never server paths or archives. */
export function importSkillUpload(input: unknown, dest: string) {
  if (!Array.isArray(input) || !input.length || input.length > 500) throw new Error("Choisis entre 1 et 500 fichiers (6 Mo maximum).");
  let bytes = 0;
  const files = new Map<string, Buffer>();
  for (const item of input as SkillUploadFile[]) {
    if (!item || typeof item.path !== "string" || typeof item.content !== "string") throw new Error("Fichier invalide.");
    const parts = item.path.split("/");
    if (item.path.length > 500 || parts.length > 12 || parts.some(p => !p || p.startsWith(".") || p === "node_modules" || /[\\:\x00-\x1f]/.test(p))) throw new Error("Chemin de fichier refusé.");
    if (files.has(item.path) || item.content.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.content)) throw new Error("Fichier dupliqué ou encodage invalide.");
    const data = Buffer.from(item.content, "base64");
    if (data.toString("base64") !== item.content) throw new Error("Encodage invalide.");
    bytes += data.length;
    if (bytes > 6 * 1024 * 1024) throw new Error("Le dossier dépasse 6 Mo.");
    files.set(item.path, data);
  }
  const roots = [...files.keys()].filter(p => posix.basename(p) === "SKILL.md").map(p => posix.dirname(p));
  if (!roots.length || roots.length > 50) throw new Error("Le dossier doit contenir entre 1 et 50 skills avec un SKILL.md.");
  const names = new Set<string>();
  for (const root of roots) {
    const name = posix.basename(root);
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || names.has(name) || roots.some(r => r !== root && root.startsWith(r + "/"))) throw new Error("Noms de skills en conflit ou dossiers imbriqués.");
    names.add(name);
    const skill = files.get(root + "/SKILL.md")!.toString("utf8");
    if (!/^---\r?\n/.test(skill) || !/^name:\s*\S/m.test(skill) || !/^description:\s*\S/m.test(skill)) throw new Error(`SKILL.md incomplet : ${name}`);
  }
  // Validate everything before writing. Existing skills are preserved, never overwritten.
  checkRequestAuthorization();
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  if (lstatSync(dest).isSymbolicLink()) throw new Error("Destination symbolique refusée.");
  const imported: string[] = [], skipped: string[] = [];
  for (const root of roots) {
    const name = posix.basename(root), target = join(dest, name);
    if (existsSync(target)) { skipped.push(name); continue; }
    const stage = mkdtempSync(join(dest, ".import-"));
    for (const [path, data] of files) {
      if (!path.startsWith(root + "/")) continue;
      const output = join(stage, path.slice(root.length + 1));
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      writeFileSync(output, data, { flag: "wx", mode: 0o600 });
    }
    checkRequestAuthorization();
    if (existsSync(target)) { skipped.push(name); continue; }
    renameSync(stage, target); imported.push(name);
  }
  return { imported, skipped };
}
