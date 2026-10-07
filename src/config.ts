/** Config partagée par les trois points d'entrée (serveur, extension pi, serveur MCP). */

export const HOST = "127.0.0.1";

const DEFAULT_PORT = 5320;

/** Port d'écoute du serveur HTTP (COGITATOR_PORT pour changer). */
export const PORT = Number(process.env.COGITATOR_PORT ?? DEFAULT_PORT);

/** URL de base du serveur local — COGITATOR_URL l'emporte (ex. autre port/hôte). */
export const BASE_URL = process.env.COGITATOR_URL ?? `http://${HOST}:${PORT}`;
