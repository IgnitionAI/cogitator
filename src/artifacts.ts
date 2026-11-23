/**
 * Artifacts : livrables publiés par les agents (page HTML, rapport Markdown, image, SVG, CSV…),
 * versionnés et consultables dans l'interface.
 *
 * Sécurité : le contenu vient d'un agent, donc il n'est pas fiable. Il est servi avec
 * `Content-Security-Policy: sandbox` (origine opaque, sans accès aux cookies ni à l'API)
 * et l'interface l'affiche dans un iframe sandboxé sans `allow-same-origin`.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import type { Db } from "./db.js";
import { atomicWriteJson, readJson } from "./json-files.js";

export class ArtifactProblem extends Error {
  constructor(code: string, readonly status = 400) { super(code); }
}

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_VERSIONS = 50;
const MAX_ARTIFACTS = 2000;

/** Types acceptés : extension → (type MIME, famille d'affichage). */
export const ARTIFACT_TYPES: Record<string, { mime: string; kind: ArtifactKind }> = {
  ".html": { mime: "text/html; charset=utf-8", kind: "html" },
  ".htm": { mime: "text/html; charset=utf-8", kind: "html" },
  ".md": { mime: "text/markdown; charset=utf-8", kind: "markdown" },
  ".markdown": { mime: "text/markdown; charset=utf-8", kind: "markdown" },
  ".svg": { mime: "image/svg+xml", kind: "image" },
  ".png": { mime: "image/png", kind: "image" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".gif": { mime: "image/gif", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".csv": { mime: "text/csv; charset=utf-8", kind: "table" },
  ".json": { mime: "application/json; charset=utf-8", kind: "code" },
  ".txt": { mime: "text/plain; charset=utf-8", kind: "code" },
  ".pdf": { mime: "application/pdf", kind: "pdf" },
  // Canevas de design : plusieurs maquettes HTML (planches) sur une surface zoomable.
  ".canvas": { mime: "application/json; charset=utf-8", kind: "canvas" },
};
export type ArtifactKind = "html" | "markdown" | "image" | "table" | "code" | "pdf" | "canvas";

export const canvasSchema = z.object({
  v: z.literal(1),
  boards: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    /** Ligne du canevas : les planches d'un même groupe sont côte à côte. */
    group: z.string().trim().max(120).optional(),
    width: z.number().int().min(200).max(3000).default(1280),
    height: z.number().int().min(200).max(6000).default(800),
    html: z.string().min(1).max(2_000_000),
  }).strict()).min(1).max(24),
}).strict();
export type CanvasDoc = z.infer<typeof canvasSchema>;

export interface ArtifactVersion { n: number; file: string; size: number; created_at: string; note?: string }
export interface Artifact {
  id: string;
  title: string;
  ext: string;
  kind: ArtifactKind;
  mime: string;
  conversation_id: string | null;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  versions: ArtifactVersion[];
}

export const publishInput = z.object({
  conversationId: z.string().uuid(),
  /** Mettre à jour un artifact existant de cette conversation (nouvelle version). */
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160),
  filename: z.string().trim().min(1).max(200),
  /** Contenu encodé en base64. */
  content: z.string().max(Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4 + 4),
  note: z.string().max(500).optional(),
}).strict();

export const renameInput = z.object({ title: z.string().trim().min(1).max(160) }).strict();

export class Artifacts {
  private readonly dir: string;
  private readonly index: string;
  private items: Artifact[];

  constructor(home: string, private readonly db: Db) {
    this.dir = join(home, "artifacts");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    this.index = join(this.dir, "index.json");
    this.items = readJson<Artifact[]>(this.index, []);
  }

  private save() { atomicWriteJson(this.index, this.items, 0o600); }

  list(filter: { conversationId?: string } = {}): Artifact[] {
    return this.items
      .filter((a) => !filter.conversationId || a.conversation_id === filter.conversationId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  get(id: string): Artifact {
    const item = this.items.find((a) => a.id === id);
    if (!item) throw new ArtifactProblem("ARTIFACT_NOT_FOUND", 404);
    return item;
  }

  /** Publication par un agent (socket privée) : crée l'artifact ou ajoute une version. */
  publish(raw: unknown): { artifact: Artifact; version: number } {
    const input = publishInput.parse(raw);
    const row = this.db.prepare("SELECT agent_id FROM conversation WHERE id=?").get(input.conversationId) as { agent_id: string | null } | undefined;
    if (!row) throw new ArtifactProblem("ARTIFACT_CONVERSATION_NOT_FOUND", 404);
    const ext = extname(input.filename).toLowerCase();
    const type = ARTIFACT_TYPES[ext];
    if (!type) throw new ArtifactProblem("ARTIFACT_TYPE_UNSUPPORTED");
    const bytes = Buffer.from(input.content, "base64");
    if (!bytes.length) throw new ArtifactProblem("ARTIFACT_EMPTY");
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new ArtifactProblem("ARTIFACT_TOO_LARGE");
    if (type.kind === "canvas") {
      try { canvasSchema.parse(JSON.parse(bytes.toString("utf8"))); }
      catch { throw new ArtifactProblem("ARTIFACT_CANVAS_INVALID"); }
    }
    const now = new Date().toISOString();
    let item: Artifact | undefined;
    if (input.id) {
      item = this.get(input.id);
      if (item.conversation_id !== input.conversationId) throw new ArtifactProblem("ARTIFACT_ACCESS_DENIED", 403);
      if (item.ext !== ext && ARTIFACT_TYPES[item.ext]?.kind !== type.kind) throw new ArtifactProblem("ARTIFACT_TYPE_CHANGED");
      if (item.versions.length >= MAX_VERSIONS) throw new ArtifactProblem("ARTIFACT_VERSION_LIMIT");
    } else {
      // Même titre dans la même conversation : on versionne plutôt que de dupliquer.
      item = this.items.find((a) => a.conversation_id === input.conversationId && a.title === input.title && a.ext === ext);
    }
    if (!item) {
      if (this.items.length >= MAX_ARTIFACTS) throw new ArtifactProblem("ARTIFACT_LIMIT");
      item = { id: randomUUID(), title: input.title, ext, kind: type.kind, mime: type.mime, conversation_id: input.conversationId, agent_id: row.agent_id, created_at: now, updated_at: now, versions: [] };
      this.items.push(item);
    }
    const n = (item.versions.at(-1)?.n ?? 0) + 1;
    const folder = join(this.dir, item.id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = `${n}${ext}`;
    writeFileSync(join(folder, file), bytes, { mode: 0o600 });
    item.versions.push({ n, file, size: bytes.length, created_at: now, ...(input.note ? { note: input.note } : {}) });
    item.title = input.title;
    item.ext = ext; item.kind = type.kind; item.mime = type.mime;
    item.updated_at = now;
    this.save();
    return { artifact: item, version: n };
  }

  content(id: string, n?: number): { bytes: Buffer; mime: string; filename: string; kind: ArtifactKind } {
    const item = this.get(id);
    const version = n === undefined ? item.versions.at(-1) : item.versions.find((v) => v.n === n);
    if (!version) throw new ArtifactProblem("ARTIFACT_VERSION_NOT_FOUND", 404);
    const safeTitle = item.title.replace(/[^\p{L}\p{N} ._-]+/gu, "").trim().slice(0, 80) || "artifact";
    return { bytes: readFileSync(join(this.dir, item.id, version.file)), mime: item.mime, filename: `${safeTitle}${item.ext}`, kind: item.kind };
  }

  /** Une planche d'un canevas, servie comme une page HTML isolée. */
  board(id: string, index: number, n?: number): { bytes: Buffer; title: string } {
    const content = this.content(id, n);
    if (content.kind !== "canvas") throw new ArtifactProblem("ARTIFACT_NOT_CANVAS");
    const board = canvasSchema.parse(JSON.parse(content.bytes.toString("utf8"))).boards[index];
    if (!board) throw new ArtifactProblem("ARTIFACT_BOARD_NOT_FOUND", 404);
    return { bytes: Buffer.from(board.html, "utf8"), title: board.title };
  }

  rename(id: string, raw: unknown): Artifact {
    const item = this.get(id);
    item.title = renameInput.parse(raw).title;
    item.updated_at = new Date().toISOString();
    this.save();
    return item;
  }

  remove(id: string) {
    const item = this.get(id);
    this.items = this.items.filter((a) => a !== item);
    rmSync(join(this.dir, item.id), { recursive: true, force: true });
    this.save();
    return {};
  }
}
