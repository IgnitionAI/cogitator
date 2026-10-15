/**
 * Egress default-deny et classification des capacités (Plan 0002 §4, P2).
 *
 * Les workers n'atteignent que les destinations approuvées de la toolchain,
 * par un chemin contrôlé (proxy allowlist imposé par env). Les commandes,
 * serveurs MCP et extensions non classifiés sont indisponibles aux missions
 * distantes : tant qu'une capacité n'est pas classée et testée, elle n'existe
 * pas en mode distant.
 */

export interface EgressPolicy {
  /** Destinations exactes approuvées (hostnames, minuscules). Tout le reste est refusé. */
  allowedHosts: readonly string[];
  /** Chemin contrôlé (URL proxy) par lequel transite tout le trafic sortant. */
  proxy: string | null;
}

/** Destinations initiales approuvées pour la toolchain (registre npm + GitHub). */
export const DEFAULT_APPROVED_DESTINATIONS = [
  "registry.npmjs.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
] as const;

export class EgressDeniedError extends Error {}

/** Default-deny : lève une erreur sauf si l'hôte est explicitement approuvé. */
export function assertEgressAllowed(policy: EgressPolicy, host: string): void {
  const clean = host.trim().toLowerCase().replace(/:\d+$/, "");
  if (!policy.allowedHosts.includes(clean)) {
    throw new EgressDeniedError(`egress refusé (default-deny): ${host}`);
  }
}

/**
 * Variables d'environnement imposées au worker : tout le trafic sortant passe
 * par le chemin contrôlé. Aucun contournement NO_PROXY n'est laissé au worker.
 */
export function egressProxyEnv(policy: EgressPolicy): Record<string, string> {
  if (!policy.proxy) throw new Error("egress: chemin contrôlé (proxy allowlist) non configuré");
  return {
    HTTP_PROXY: policy.proxy,
    HTTPS_PROXY: policy.proxy,
    http_proxy: policy.proxy,
    https_proxy: policy.proxy,
    NO_PROXY: "",
    no_proxy: "",
  };
}

// ---------- Classification des capacités ----------

export interface ToolchainRegistry {
  approvedCommands: ReadonlySet<string>;
  approvedMcpServers: ReadonlySet<string>;
  approvedExtensions: ReadonlySet<string>;
}

/** Commandes de la toolchain initialement classées et testées (profil P0). */
export const DEFAULT_APPROVED_COMMANDS = ["node", "npm", "npx", "pnpm", "git", "tsc"] as const;

export function defaultToolchainRegistry(): ToolchainRegistry {
  return {
    approvedCommands: new Set(DEFAULT_APPROVED_COMMANDS),
    approvedMcpServers: new Set<string>(),
    approvedExtensions: new Set<string>(),
  };
}

export class UnclassifiedCapabilityError extends Error {}

function assertClassified(approved: ReadonlySet<string>, kind: string, name: string): void {
  if (!approved.has(name)) {
    throw new UnclassifiedCapabilityError(`${kind} non classé, indisponible en mode distant: ${name}`);
  }
}

/** Commande non classée → indisponible aux missions distantes. */
export function assertCommandApproved(registry: ToolchainRegistry, command: string): void {
  assertClassified(registry.approvedCommands, "commande", command);
}

/** Serveur MCP non classé → indisponible aux missions distantes. */
export function assertMcpServerApproved(registry: ToolchainRegistry, name: string): void {
  assertClassified(registry.approvedMcpServers, "serveur MCP", name);
}

/** Extension non classée → indisponible aux missions distantes. */
export function assertExtensionApproved(registry: ToolchainRegistry, name: string): void {
  assertClassified(registry.approvedExtensions, "extension", name);
}
