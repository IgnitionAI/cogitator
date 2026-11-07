import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Paths } from "./paths.js";

export const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export interface PackageCard { name: string; description: string; types: string[] }
export function parseCatalog(html: string): { packages: PackageCard[]; hasNext: boolean } {
  const text = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&(?:amp|quot|lt|gt|#39|apos);/g, e => ({ "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&#39;": "'", "&apos;": "'" })[e]!);
  const packages: PackageCard[] = [];
  for (const match of html.matchAll(/<article\b[^>]*data-package-name="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)) {
    const name = text(match[1]!);
    if (!packageName.test(name)) continue;
    packages.push({ name, description: text(match[2]!.match(/<p class="packages-desc">([\s\S]*?)<\/p>/)?.[1] ?? ""), types: [...match[2]!.matchAll(/data-type="([a-z]+)"/g)].map(m => m[1]!) });
  }
  if (!html.includes("packages-action-bar")) throw new Error("Catalogue pi indisponible : format inattendu.");
  return { packages, hasNext: /(?:aria-label="Next|>Next|>Suivant)/i.test(html) };
}
async function fetchText(url: string): Promise<string> {
  const origin = new URL(url).origin;
  let res: Response | undefined;
  const signal = AbortSignal.timeout(15_000);
  for (let redirect = 0; redirect < 4; redirect++) {
    res = await fetch(url, { signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    const location = res.headers.get("location");
    await res.body?.cancel();
    if (!location) throw new Error("Redirection du catalogue invalide.");
    const target = new URL(location, url);
    if (target.origin !== origin) throw new Error("Redirection externe du catalogue refusée.");
    url = target.href;
  }
  if (!res) throw new Error("Catalogue indisponible.");
  if (!res.ok) throw new Error(`Catalogue indisponible (HTTP ${res.status}).`);
  const body = await res.text();
  if (body.length > 3_000_000) throw new Error("Réponse du catalogue trop volumineuse.");
  return body;
}
export async function catalog(query: string, type: string, page: number) {
  const url = new URL("https://pi.dev/packages");
  if (query) url.searchParams.set("name", query.slice(0, 100));
  if (["extension", "skill", "theme", "prompt"].includes(type)) url.searchParams.set("type", type);
  if (page > 1) url.searchParams.set("page", String(page));
  const html = await fetchText(url.href);
  const result = parseCatalog(html);
  // Pagination links retain the active search and filters.
  result.hasNext = [...html.matchAll(/href="([^"#]+)"/g)].some(m => {
    try { const link = new URL(m[1]!.replaceAll("&amp;", "&"), url); return link.pathname === "/packages" && Number(link.searchParams.get("page")) === page + 1; } catch { return false; }
  });
  return result;
}
export function installedPackages(paths: Paths) {
  let settings: { packages?: Array<string | { source: string }> };
  try { settings = JSON.parse(readFileSync(join(paths.piAgentDir, "settings.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return (settings.packages ?? []).map(entry => {
    const source = typeof entry === "string" ? entry : entry.source;
    const match = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.+))?$/.exec(source);
    return { source, name: match?.[1] ?? source, version: match?.[2] ?? "", removable: !!match && packageName.test(match[1]!) };
  });
}
export interface PackageOperation { name: string; action: "install" | "remove"; status: "running" | "done" | "error"; error?: string; deferred?: number }
export class PackageManager {
  operation: PackageOperation | null = null;
  constructor(private paths: Paths, private refresh: () => Promise<number>, private run = runPi) {}
  start(name: string, action: "install" | "remove") {
    if (!packageName.test(name) || name.length > 214) throw new Error("Nom de package npm invalide.");
    if (this.operation?.status === "running") throw new Error("Une installation est déjà en cours.");
    const operation: PackageOperation = { name, action, status: "running" };
    this.operation = operation;
    void this.perform(operation);
    return operation;
  }
  private async perform(operation: PackageOperation) {
    try {
      let source: string;
      if (operation.action === "remove") {
        const installed = installedPackages(this.paths).find(p => p.name === operation.name && p.removable);
        if (!installed) throw new Error("Ce package n’est pas installé dans ce profil.");
        source = installed.source;
      } else {
        const meta = JSON.parse(await fetchText(`https://registry.npmjs.org/${encodeURIComponent(operation.name)}/latest`));
        if (meta.name !== operation.name || !meta.keywords?.includes("pi-package") || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[\w.-]+)?$/.test(meta.version)) throw new Error("Ce package n’est pas un package pi valide.");
        source = `npm:${operation.name}@${meta.version}`;
      }
      await this.run(operation.action, source, this.paths);
      operation.deferred = await this.refresh();
      operation.status = "done";
    } catch (error) { operation.status = "error"; operation.error = error instanceof Error ? error.message : "Installation échouée."; }
  }
}
function runPi(action: string, source: string, paths: Paths): Promise<void> {
  return new Promise((resolve, reject) => {
    // Arguments, never shell text. Same executable environment and profile as chat RPC.
    const child = spawn("pi", [action, source], { cwd: paths.home, env: { ...process.env, PI_CODING_AGENT_DIR: paths.piAgentDir }, stdio: "ignore", detached: process.platform !== "win32" });
    const timer = setTimeout(() => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ } }, 180_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Impossible de démarrer pi. Vérifiez son installation sur ce serveur.")); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("La commande pi a échoué ou dépassé trois minutes. Vérifiez le réseau et la compatibilité du package.")); });
  });
}
