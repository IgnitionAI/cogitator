import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import type * as PiAi from "@earendil-works/pi-ai";
import type * as PiAiProviders from "@earendil-works/pi-ai/providers/all";

/**
 * Les packages pi viennent de l'installation hôte (le `pi` du PATH), jamais d'une copie
 * figée : une copie décalée fait diverger le catalogue providers, les logins et les
 * payloads de raisonnement de ce que le binaire exécute réellement.
 * Repli sur les copies locales uniquement en dev/tests (pas de `pi` sur le PATH).
 */
function manifestName(dir: string): string | undefined {
  const file = join(dir, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).name : undefined;
}

function findPackageUp(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (manifestName(dir) === name) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** Dossier du package `name` selon la résolution node depuis `from`. */
export function findPackageFrom(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

function hostBase(): string | null {
  try {
    const bins = execFileSync(process.platform === "win32" ? "where" : "which", process.platform === "win32" ? ["pi"] : ["-a", "pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").map((line) => line.trim());
    // Un pi sous node_modules/.bin est le devDependency d'un projet, pas l'installation de l'utilisateur.
    const bin = bins.find((path) => path && !/node_modules[\\/]\.bin[\\/]/.test(path));
    return bin ? findPackageUp("@earendil-works/pi-coding-agent", dirname(realpathSync(bin))) : null;
  } catch {
    return null;
  }
}

/** Racine `@earendil-works/pi-coding-agent` du `pi` hôte, ou null si aucun binaire résolvable. */
export const hostPiPackage = hostBase();

const bases = [hostPiPackage, findPackageUp("@ignitionai/cogitator", dirname(fileURLToPath(import.meta.url)))].filter((base): base is string => base !== null);

function root(pkg: string): string {
  for (const base of bases) {
    const found = findPackageFrom(pkg, base);
    if (found) return found;
  }
  throw new Error(`package pi introuvable: ${pkg}`);
}

export const codingAgentRoot = hostPiPackage ?? root("@earendil-works/pi-coding-agent");
// Ces packages n'exposent qu'une condition "import" : chargement ESM dynamique.
const load = <T>(...segments: string[]): Promise<T> => import(pathToFileURL(join(...segments)).href) as Promise<T>;

/** Catalogue `pi-ai` résolu depuis le même arbre que le binaire (pas un voisin hoisté supposé). */
export const piAiRoot = findPackageFrom("@earendil-works/pi-ai", codingAgentRoot) ?? root("@earendil-works/pi-ai");

export const piCodingAgent = await load<typeof CodingAgent>(codingAgentRoot, "dist/index.js");
export const piAi = await load<typeof PiAi>(piAiRoot, "dist/index.js");
export const piAiProviders = await load<typeof PiAiProviders>(piAiRoot, "dist/providers/all.js");

/** Entrée CLI exécutée en mode rpc (celle de l'hôte quand elle existe). */
export const piCliPath = join(codingAgentRoot, "dist/cli.js");
