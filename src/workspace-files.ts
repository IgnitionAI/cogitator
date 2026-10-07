import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, basename, join, normalize, resolve, sep } from "node:path";

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  children?: TreeNode[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "__pycache__", "coverage", ".turbo"]);
const MAX_DEPTH = 5;
const MAX_NODES = 500;
const MAX_FILE_CHARS = 400_000;

/** Compteur de nœuds partagé par la récursion (l'arborescence est construite en synchrone). */
interface NodeBudget {
  count: number;
}

function buildTree(dir: string, depth: number, budget: NodeBudget): TreeNode[] {
  if (depth > MAX_DEPTH || budget.count > MAX_NODES) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: TreeNode[] = [];
  for (const e of entries) {
    if (budget.count > MAX_NODES) break;
    if (e.name.startsWith(".") && e.name !== ".env.example") continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      budget.count += 1;
      nodes.push({ name: e.name, path, type: "dir", children: buildTree(path, depth + 1, budget) });
    } else if (e.isFile()) {
      budget.count += 1;
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        /* inaccessible */
      }
      nodes.push({ name: e.name, path, type: "file", size });
    }
  }
  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return nodes;
}

/** Arborescence du workspace (read-only, profondeur et volume plafonnés). */
export function workspaceTree(rootDir: string): TreeNode[] {
  return buildTree(rootDir, 0, { count: 0 });
}

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".css", ".scss", ".html", ".xml",
  ".yml", ".yaml", ".toml", ".ini", ".cfg", ".env", ".txt", ".py", ".rs", ".go", ".java", ".c", ".h",
  ".cpp", ".hpp", ".sh", ".bash", ".zsh", ".sql", ".graphql", ".prisma", ".csv", ".svg", ".pyi", ".lock",
]);

export interface FileContent {
  path: string;
  name: string;
  size: number;
  content: string;
  truncated: boolean;
}

/**
 * Lit un fichier du workspace (read-only). Sécurité : le chemin résolu doit rester
 * sous la racine du workspace (anti-traversal), taille plafonnée, extensions binaires refusées.
 */
export function readWorkspaceFile(rootDir: string, requested: string): { file?: FileContent; error?: string } {
  const root = resolve(rootDir);
  const target = resolve(normalize(requested));
  if (target !== root && !target.startsWith(root + sep)) {
    return { error: "chemin hors du workspace" };
  }
  if (!existsSync(target)) return { error: `fichier introuvable: ${requested}` };
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return { error: "fichier illisible" };
  }
  if (stat.isDirectory()) return { error: "c'est un dossier" };
  const ext = extname(target).toLowerCase();
  if (!TEXT_EXT.has(ext)) {
    return { error: `extension non affichable en texte: ${ext || "(aucune)"}` };
  }
  if (stat.size > MAX_FILE_CHARS * 2) {
    return { error: `fichier trop volumineux (${Math.round(stat.size / 1024)} Ko)` };
  }
  let content: string;
  try {
    content = readFileSync(target, "utf8");
  } catch {
    return { error: "lecture impossible (binaire ?)" };
  }
  const truncated = content.length > MAX_FILE_CHARS;
  if (truncated) content = content.slice(0, MAX_FILE_CHARS);
  return { file: { path: target, name: basename(target), size: stat.size, content, truncated } };
}
