/** Config partagée par les trois points d'entrée (serveur, extension pi, serveur MCP). */

export const HOST = "127.0.0.1";

const DEFAULT_PORT = 5320;

/** Port d'écoute du serveur HTTP (COGITATOR_PORT pour changer). */
export const PORT = Number(process.env.COGITATOR_PORT ?? DEFAULT_PORT);

/** URL de base du serveur local — COGITATOR_URL l'emporte (ex. autre port/hôte). */
export const BASE_URL = process.env.COGITATOR_URL ?? `http://${HOST}:${PORT}`;

/** Only explicit 0/1 are supported; a typo must never silently select local mode. */
export function authenticationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.COGITATOR_AUTH_REQUIRED;
  if (value !== undefined && value !== "0" && value !== "1") throw new Error("COGITATOR_AUTH_REQUIRED must be unset, 0, or 1.");
  return value === "1";
}

const DEFAULT_REAP_INTERVAL_MS = 15_000;

/** Intervalle du reap d'orphelins (ms). `COGITATOR_REAP_INTERVAL_MS=0` désactive. Défaut 15 s. */
export function reapIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COGITATOR_REAP_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_REAP_INTERVAL_MS;
  if (!/^\d+$/.test(raw)) return DEFAULT_REAP_INTERVAL_MS;
  return Number(raw);
}
