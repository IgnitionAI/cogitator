/**
 * Jetons d'accès du serveur MCP HTTP (`/mcp`).
 *
 * Un jeton est un secret aléatoire de 256 bits, montré une seule fois à la création.
 * Seul son SHA-256 est stocké (`<home>/mcp-tokens.json`, mode 0600). Le fichier est
 * relu dès qu'il change : une révocation par la CLI prend effet sur le serveur en cours,
 * y compris pour les sessions MCP déjà ouvertes (vérification à chaque requête et appel).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, readJson } from "./json-files.js";
import { MCP_SCOPES, type McpScope } from "./mcp-tools.js";

export const MCP_TOKEN_PREFIX = "cgt_";
const TOKEN_FILE = "mcp-tokens.json";
const NAME_MAX = 64;

export interface McpTokenRecord {
  id: string;
  name: string;
  scope: McpScope;
  /** SHA-256 hexadécimal du jeton complet. */
  hash: string;
  created_at: string;
}

export type McpTokenInfo = Omit<McpTokenRecord, "hash">;

interface TokenFile { version: 1; tokens: McpTokenRecord[] }

export function mcpTokenPath(home: string): string {
  return join(home, TOKEN_FILE);
}

const digest = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

function readFile(home: string): TokenFile {
  const data = readJson<Partial<TokenFile>>(mcpTokenPath(home), { version: 1, tokens: [] });
  const tokens = Array.isArray(data.tokens) ? data.tokens.filter(isRecord) : [];
  return { version: 1, tokens };
}

function isRecord(value: unknown): value is McpTokenRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.name === "string" && typeof r.hash === "string"
    && /^[0-9a-f]{64}$/.test(r.hash) && MCP_SCOPES.includes(r.scope as McpScope) && typeof r.created_at === "string";
}

function writeFile(home: string, file: TokenFile): void {
  mkdirSync(home, { recursive: true });
  atomicWriteJson(mcpTokenPath(home), file, 0o600);
  chmodSync(mcpTokenPath(home), 0o600);
}

const info = ({ hash: _hash, ...rest }: McpTokenRecord): McpTokenInfo => rest;

export function createMcpToken(home: string, input: { name: string; scope?: McpScope }): { token: string; info: McpTokenInfo } {
  const name = input.name.trim();
  if (!name || name.length > NAME_MAX) throw new Error(`Nom de jeton requis (1-${NAME_MAX} caractères)`);
  const scope = input.scope ?? "full";
  if (!MCP_SCOPES.includes(scope)) throw new Error(`Scope invalide : ${scope} (read | full)`);
  const token = MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const record: McpTokenRecord = { id: randomUUID().slice(0, 8), name, scope, hash: digest(token), created_at: new Date().toISOString() };
  const file = readFile(home);
  file.tokens.push(record);
  writeFile(home, file);
  return { token, info: info(record) };
}

export function listMcpTokens(home: string): McpTokenInfo[] {
  return readFile(home).tokens.map(info);
}

export function revokeMcpToken(home: string, idOrName: string): boolean {
  const file = readFile(home);
  const kept = file.tokens.filter((t) => t.id !== idOrName && t.name !== idOrName);
  if (kept.length === file.tokens.length) return false;
  writeFile(home, { version: 1, tokens: kept });
  return true;
}

/** Vérificateur avec cache invalidé sur mtime/taille du fichier. */
export class McpTokenVerifier {
  private cache: { key: string; tokens: McpTokenRecord[] } | undefined;
  constructor(private readonly home: string) {}

  private tokens(): McpTokenRecord[] {
    const path = mcpTokenPath(this.home);
    if (!existsSync(path)) return [];
    const s = statSync(path);
    const key = `${s.mtimeMs}:${s.size}:${s.ino}`;
    if (this.cache?.key !== key) this.cache = { key, tokens: readFile(this.home).tokens };
    return this.cache.tokens;
  }

  /** Jeton présenté → enregistrement, ou undefined (absent, inconnu, révoqué). */
  verify(token: string | undefined): McpTokenInfo | undefined {
    if (!token || !token.startsWith(MCP_TOKEN_PREFIX) || token.length > 128) return undefined;
    const presented = Buffer.from(digest(token), "hex");
    let found: McpTokenRecord | undefined;
    for (const record of this.tokens()) {
      if (timingSafeEqual(presented, Buffer.from(record.hash, "hex"))) found = record;
    }
    return found ? info(found) : undefined;
  }

  /** Le jeton `id` est-il toujours valide avec ce scope ? (révocation en cours de session) */
  stillValid(id: string, scope: McpScope): boolean {
    return this.tokens().some((t) => t.id === id && t.scope === scope);
  }
}

/** Extrait le jeton d'un en-tête `Authorization: Bearer …`. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}
