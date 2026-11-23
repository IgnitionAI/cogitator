/**
 * Coffre d'identifiants pour les navigateurs partagés.
 *
 * - Chiffré au repos (AES-256-GCM) avec une clé de serveur `vault.key` (0600) ou COGITATOR_VAULT_KEY.
 * - Les agents ne voient JAMAIS un mot de passe : le navigateur partagé remplit lui-même les champs
 *   à partir d'une référence, après avoir vérifié l'agent autorisé et le site de la page.
 * - Seul le propriétaire (interface) peut lire un mot de passe en clair.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Db } from "./db.js";
import { atomicWriteJson, readJson } from "./json-files.js";

export class VaultProblem extends Error {
  constructor(code: string, readonly status = 400) { super(code); }
}

const KEY_FILE = "vault.key";
const STORE_FILE = "vault.json";
const MAX_ENTRIES = 5000;

const httpUrl = z.string().trim().min(1).max(2048).transform((value, ctx) => {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error("scheme");
    return url.href;
  } catch {
    ctx.addIssue({ code: "custom", message: "VAULT_URL_INVALID" });
    return z.NEVER;
  }
});

const access = {
  allAgents: z.boolean().default(false),
  agentIds: z.array(z.string().uuid()).max(200).default([]),
};

export const vaultCreateInput = z.object({
  name: z.string().trim().max(120).optional(),
  url: httpUrl,
  username: z.string().max(500).default(""),
  password: z.string().min(1).max(4096),
  note: z.string().max(4000).optional(),
  source: z.enum(["manual", "chat"]).default("manual"),
  ...access,
}).strict();

export const vaultUpdateInput = z.object({
  name: z.string().trim().max(120).optional(),
  url: httpUrl.optional(),
  username: z.string().max(500).optional(),
  /** Absent : le mot de passe ne change pas. */
  password: z.string().min(1).max(4096).optional(),
  note: z.string().max(4000).optional(),
  allAgents: z.boolean().optional(),
  agentIds: z.array(z.string().uuid()).max(200).optional(),
}).strict();

export const vaultImportInput = z.object({
  csv: z.string().min(1).max(20_000_000),
  overwrite: z.boolean().default(false),
  ...access,
}).strict();

interface StoredEntry {
  id: string;
  name: string;
  url: string;
  host: string;
  username: string;
  password: string;
  note: string | null;
  allAgents: boolean;
  agentIds: string[];
  source: "manual" | "chat" | "import";
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

/** Ce que l'interface et les agents voient d'un identifiant : jamais le mot de passe ni la note. */
export interface VaultEntryView {
  id: string;
  name: string;
  url: string;
  host: string;
  username: string;
  hasNote: boolean;
  allAgents: boolean;
  agentIds: string[];
  source: StoredEntry["source"];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface ImportSummary { added: number; updated: number; skipped: number; invalid: number }

/** Analyse CSV RFC 4180 (guillemets, virgules et retours à la ligne dans les champs). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

/** Export du gestionnaire de mots de passe Google (Chrome) : name,url,username,password[,note]. */
export function parseGooglePasswordsCsv(text: string): { entries: Array<{ name: string; url: string; username: string; password: string; note: string }>; invalid: number } {
  const rows = parseCsv(text);
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iName = col("name", "title"), iUrl = col("url", "origin", "website"), iUser = col("username", "login", "user"), iPass = col("password"), iNote = col("note", "notes");
  if (iUrl < 0 || iPass < 0) throw new VaultProblem("VAULT_IMPORT_FORMAT");
  const entries: Array<{ name: string; url: string; username: string; password: string; note: string }> = [];
  let invalid = 0;
  for (const row of rows) {
    const url = row[iUrl]?.trim() ?? "";
    const password = row[iPass] ?? "";
    const parsed = httpUrl.safeParse(url);
    if (!parsed.success || !password || password.length > 4096) { invalid++; continue; }
    entries.push({
      name: (iName >= 0 ? row[iName]?.trim() : "") || new URL(parsed.data).hostname,
      url: parsed.data,
      username: (iUser >= 0 ? row[iUser] : "")?.slice(0, 500) ?? "",
      password,
      note: (iNote >= 0 ? row[iNote] : "")?.slice(0, 4000) ?? "",
    });
  }
  return { entries, invalid };
}

/** Le site de la page correspond-il à l'identifiant ? Même hôte, ou sous-domaine de l'hôte enregistré. */
export function siteMatches(entryHost: string, pageUrl: string): boolean {
  let page: URL;
  try { page = new URL(pageUrl); } catch { return false; }
  if (!["http:", "https:"].includes(page.protocol)) return false;
  const host = page.hostname.toLowerCase();
  const target = entryHost.toLowerCase().replace(/^www\./, "");
  const bare = host.replace(/^www\./, "");
  return bare === target || bare.endsWith(`.${target}`);
}

function loadKey(home: string, env: NodeJS.ProcessEnv): Buffer {
  if (env.COGITATOR_VAULT_KEY) {
    const key = Buffer.from(env.COGITATOR_VAULT_KEY, "base64");
    if (key.length !== 32) throw new Error("COGITATOR_VAULT_KEY doit contenir 32 octets encodés en base64.");
    return key;
  }
  const file = join(home, KEY_FILE);
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`${file} est invalide.`);
  return key;
}

export class Vault {
  private readonly key: Buffer;
  private readonly file: string;
  private entries: StoredEntry[];

  constructor(home: string, private readonly db: Db, env: NodeJS.ProcessEnv = process.env) {
    this.key = loadKey(home, env);
    this.file = join(home, STORE_FILE);
    this.entries = readJson<StoredEntry[]>(this.file, []);
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
  }

  private decrypt(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(":");
    if (version !== "v1" || !iv || !tag || data === undefined) throw new VaultProblem("VAULT_CORRUPT", 500);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    } catch { throw new VaultProblem("VAULT_KEY_MISMATCH", 500); }
  }

  private save() {
    atomicWriteJson(this.file, this.entries, 0o600);
    chmodSync(this.file, 0o600);
  }

  private view(entry: StoredEntry): VaultEntryView {
    const { password: _password, note, ...rest } = entry;
    return { ...rest, hasNote: !!note };
  }

  private find(id: string): StoredEntry {
    const entry = this.entries.find((e) => e.id === id.replace(/^secret:/, ""));
    if (!entry) throw new VaultProblem("VAULT_NOT_FOUND", 404);
    return entry;
  }

  private validateAgents(ids: string[]) {
    for (const id of ids) if (!this.db.prepare("SELECT id FROM agent_preset WHERE id=?").get(id)) throw new VaultProblem("VAULT_AGENT_NOT_FOUND");
  }

  list(): VaultEntryView[] {
    return this.entries.map((e) => this.view(e)).sort((a, b) => a.name.localeCompare(b.name));
  }

  create(raw: unknown): VaultEntryView {
    const input = vaultCreateInput.parse(raw);
    this.validateAgents(input.agentIds);
    if (this.entries.length >= MAX_ENTRIES) throw new VaultProblem("VAULT_LIMIT");
    const url = new URL(input.url);
    const now = new Date().toISOString();
    const entry: StoredEntry = {
      id: randomUUID(), name: input.name || url.hostname, url: input.url, host: url.hostname,
      username: input.username, password: this.encrypt(input.password), note: input.note ? this.encrypt(input.note) : null,
      allAgents: input.allAgents, agentIds: input.agentIds, source: input.source,
      created_at: now, updated_at: now, last_used_at: null,
    };
    this.entries.push(entry);
    this.save();
    return this.view(entry);
  }

  update(id: string, raw: unknown): VaultEntryView {
    const input = vaultUpdateInput.parse(raw);
    const entry = this.find(id);
    if (input.agentIds) this.validateAgents(input.agentIds);
    if (input.url !== undefined) { entry.url = input.url; entry.host = new URL(input.url).hostname; }
    if (input.name !== undefined) entry.name = input.name || entry.host;
    if (input.username !== undefined) entry.username = input.username;
    if (input.password !== undefined) entry.password = this.encrypt(input.password);
    if (input.note !== undefined) entry.note = input.note ? this.encrypt(input.note) : null;
    if (input.allAgents !== undefined) entry.allAgents = input.allAgents;
    if (input.agentIds !== undefined) entry.agentIds = input.agentIds;
    entry.updated_at = new Date().toISOString();
    this.save();
    return this.view(entry);
  }

  remove(id: string) {
    const entry = this.find(id);
    this.entries = this.entries.filter((e) => e !== entry);
    this.save();
    return {};
  }

  /** Propriétaire seulement (interface) : jamais exposé aux agents. */
  reveal(id: string): { password: string; note: string } {
    const entry = this.find(id);
    return { password: this.decrypt(entry.password), note: entry.note ? this.decrypt(entry.note) : "" };
  }

  importGoogle(raw: unknown): ImportSummary {
    const input = vaultImportInput.parse(raw);
    this.validateAgents(input.agentIds);
    const { entries, invalid } = parseGooglePasswordsCsv(input.csv);
    const summary: ImportSummary = { added: 0, updated: 0, skipped: 0, invalid };
    const now = new Date().toISOString();
    for (const item of entries) {
      const host = new URL(item.url).hostname;
      const existing = this.entries.find((e) => e.host === host && e.username === item.username);
      if (existing) {
        if (!input.overwrite) { summary.skipped++; continue; }
        existing.password = this.encrypt(item.password);
        existing.note = item.note ? this.encrypt(item.note) : existing.note;
        existing.updated_at = now;
        summary.updated++;
        continue;
      }
      if (this.entries.length >= MAX_ENTRIES) { summary.skipped++; continue; }
      this.entries.push({
        id: randomUUID(), name: item.name, url: item.url, host, username: item.username,
        password: this.encrypt(item.password), note: item.note ? this.encrypt(item.note) : null,
        allAgents: input.allAgents, agentIds: input.agentIds, source: "import",
        created_at: now, updated_at: now, last_used_at: null,
      });
      summary.added++;
    }
    this.save();
    return summary;
  }

  private agentOf(conversationId: string): string {
    const row = this.db.prepare("SELECT agent_id FROM conversation WHERE id=?").get(conversationId) as { agent_id: string | null } | undefined;
    if (!row?.agent_id) throw new VaultProblem("VAULT_CONVERSATION_REQUIRED");
    return row.agent_id;
  }

  private allowed(entry: StoredEntry, agentId: string) {
    return entry.allAgents || entry.agentIds.includes(agentId);
  }

  /** Identifiants utilisables par l'agent de cette conversation (optionnellement pour une page). */
  forConversation(conversationId: string, pageUrl?: string): Array<Pick<VaultEntryView, "id" | "name" | "host" | "username">> {
    const agentId = this.agentOf(conversationId);
    return this.entries
      .filter((e) => this.allowed(e, agentId) && (!pageUrl || siteMatches(e.host, pageUrl)))
      .map((e) => ({ id: `secret:${e.id}`, name: e.name, host: e.host, username: e.username }));
  }

  /** Usage interne du navigateur partagé : identifiant en clair, après contrôle de l'agent et du site. */
  credentialFor(id: string, conversationId: string, pageUrl: string): { username: string; password: string } {
    const entry = this.find(id);
    if (!this.allowed(entry, this.agentOf(conversationId))) throw new VaultProblem("VAULT_ACCESS_DENIED", 403);
    if (!siteMatches(entry.host, pageUrl)) throw new VaultProblem("VAULT_SITE_MISMATCH", 403);
    entry.last_used_at = new Date().toISOString();
    this.save();
    return { username: entry.username, password: this.decrypt(entry.password) };
  }
}
