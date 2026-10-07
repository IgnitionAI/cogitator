import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, atomicWriteJson } from "./json-files.js";
import { CARD_PRIORITIES, CARD_STATUSES } from "./schemas.js";

/**
 * Board kanban — réplique des GitHub Issues du repo (source de vérité = GitHub).
 *
 * - Lecture : `gh issue list` → cartes mappées sur les colonnes par labels
 *   (`status:backlog|todo|in_progress|canceled`, clos → done, défaut → todo)
 *   et priorités (`priority:urgent|high|medium|low`, défaut medium).
 * - Écriture : write-through via `gh` (création, édition, close/reopen, commentaire).
 * - Sidecar local `cogitator.board.json` : uniquement les extras Cogitator
 *   (conversations liées, relations, commentaires locaux), indexés par numéro d'issue.
 * - Migration : les cartes locales non liées deviennent des issues GitHub au premier accès.
 *
 * Pas de sync bi-directionnelle : une seule vérité (GitHub), jamais de divergence.
 */

export interface BoardComment {
  id: string;
  author: string;
  text: string;
  at: string;
}

export interface BoardCard {
  id: string; // = String(issue number)
  number: number;
  url: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  labels: string[]; // labels utilisateur (sans les préfixes status:/priority:)
  assignee_agent_id: string | null; // extra Cogitator (GitHub garde ses assignés humains)
  conversation_ids: string[];
  blocks: string[];
  blocked_by: string[];
  github_issue: number;
  comments: BoardComment[];
  created_at: string;
  updated_at: string;
}

interface SidecarExtras {
  assignee_agent_id?: string | null;
  conversation_ids?: string[];
  blocks?: string[];
  blocked_by?: string[];
  comments?: BoardComment[];
}

interface SidecarFile {
  version: 2;
  extras: Record<string, SidecarExtras>; // clé = numéro d'issue
}

const STATUSES = CARD_STATUSES;
const PRIORITIES = CARD_PRIORITIES;

/** Statuts/priorités viennent des schémas zod : les predicats gardent le narrowing côté TS. */
function isStatus(value: string): value is (typeof STATUSES)[number] {
  return (STATUSES as readonly string[]).includes(value);
}

function isPriority(value: string): value is (typeof PRIORITIES)[number] {
  return (PRIORITIES as readonly string[]).includes(value);
}

export function boardPath(wsDir: string): string {
  return join(wsDir, "cogitator.board.json");
}

// ---------- gh ----------

const GH_TIMEOUT_MS = 20_000;
const GH_QUICK_TIMEOUT_MS = 10_000;
const GH_MAX_BUFFER = 8 * 1024 * 1024;
const GH_ERROR_MAX = 300;
const GH_ISSUE_LIMIT = 200;

interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function gh(wsDir: string, args: string[], timeoutMs = GH_TIMEOUT_MS): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile("gh", args, { cwd: wsDir, timeout: timeoutMs, maxBuffer: GH_MAX_BUFFER }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr).trim() });
    });
  });
}

/** Erreur gh homogène et tronquée (les sorties gh peuvent être longues). */
function ghError(action: string, r: GhResult): { error: string } {
  return { error: `${action}: ${r.stderr || r.stdout}`.slice(0, GH_ERROR_MAX) };
}

interface GhIssue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: Array<{ name: string }>;
  url: string;
  createdAt: string;
  updatedAt: string;
}

async function listIssues(wsDir: string): Promise<{ issues: GhIssue[] } | { error: string }> {
  const r = await gh(wsDir, [
    "issue", "list", "--state", "all", "--limit", String(GH_ISSUE_LIMIT),
    "--json", "number,title,body,state,labels,url,createdAt,updatedAt",
  ]);
  if (!r.ok) return { error: `gh inaccessible ou repo sans remote : ${r.stderr || r.stdout}`.slice(0, GH_ERROR_MAX) };
  try {
    return { issues: JSON.parse(r.stdout) as GhIssue[] };
  } catch {
    return { error: "sortie gh inattendue (issue list)" };
  }
}

// ---------- mapping ----------

export function statusFromIssue(issue: GhIssue): string {
  if (issue.state === "CLOSED") {
    return issue.labels.some((l) => l.name === "status:canceled") ? "canceled" : "done";
  }
  const found = issue.labels.find((l) => l.name.startsWith("status:"))?.name.slice("status:".length);
  return found && isStatus(found) ? found : "todo";
}

export function priorityFromIssue(issue: GhIssue): string {
  const found = issue.labels.find((l) => l.name.startsWith("priority:"))?.name.slice("priority:".length);
  return found && isPriority(found) ? found : "medium";
}

const USER_LABELS_MAX = 8;

function userLabels(issue: GhIssue): string[] {
  return issue.labels
    .map((l) => l.name)
    .filter((n) => !n.startsWith("status:") && !n.startsWith("priority:"))
    .slice(0, USER_LABELS_MAX);
}

function mergeCard(issue: GhIssue, extras: SidecarExtras | undefined): BoardCard {
  return {
    id: String(issue.number),
    number: issue.number,
    url: issue.url,
    title: issue.title,
    description: issue.body ?? "",
    status: statusFromIssue(issue),
    priority: priorityFromIssue(issue),
    labels: userLabels(issue),
    assignee_agent_id: extras?.assignee_agent_id ?? null,
    conversation_ids: extras?.conversation_ids ?? [],
    blocks: extras?.blocks ?? [],
    blocked_by: extras?.blocked_by ?? [],
    github_issue: issue.number,
    comments: extras?.comments ?? [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

// ---------- sidecar ----------

function readSidecar(wsDir: string): SidecarFile {
  const raw = readJson<SidecarFile | { version: 1; cards?: unknown[] }>(boardPath(wsDir), { version: 2, extras: {} });
  if (raw.version === 2 && typeof (raw as SidecarFile).extras === "object") return raw as SidecarFile;
  return { version: 2, extras: {} }; // v1 ou invalide : on repart sur un sidecar vide (migration gérée par GitHub)
}

function saveSidecar(wsDir: string, sidecar: SidecarFile): void {
  atomicWriteJson(boardPath(wsDir), sidecar);
}

/** Extras Cogitator d'une carte (clé = numéro d'issue). */
function readExtras(wsDir: string, number: number): SidecarExtras | undefined {
  return readSidecar(wsDir).extras[String(number)];
}

// ---------- API publique ----------

/** Liste les cartes = issues GitHub + extras sidecar. */
export async function listCards(wsDir: string): Promise<{ cards: BoardCard[] } | { error: string }> {
  const listed = await listIssues(wsDir);
  if ("error" in listed) return { error: listed.error };
  const sidecar = readSidecar(wsDir);
  const cards = listed.issues.map((i) => mergeCard(i, sidecar.extras[String(i.number)]));
  cards.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { cards };
}

export interface CardWrite {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  assignee_agent_id?: string | null;
  conversation_ids?: string[];
  blocks?: string[];
  blocked_by?: string[];
}

function targetLabels(write: CardWrite): string[] {
  const status = write.status ?? "backlog";
  const priority = write.priority ?? "medium";
  return [`status:${status}`, `priority:${priority}`, ...(write.labels ?? [])];
}

async function ensureOpenState(wsDir: string, number: number, status: string): Promise<void> {
  if (status === "done" || status === "canceled") {
    await gh(wsDir, ["issue", "close", String(number)]);
  } else {
    await gh(wsDir, ["issue", "reopen", String(number)]);
  }
}

const LABEL_COLOR_SYSTEM = "5e6ad2";
const LABEL_COLOR_USER = "8a8f98";
const LABELS_ENSURED = new Set<string>();

/** Crée les labels manquants sur le repo (idempotent). Les labels système ne sont recréés
 *  qu'une fois par workspace et par process ; les labels carte sont assurés à chaque écriture. */
async function ensureLabels(wsDir: string, cardLabels: string[] = []): Promise<void> {
  if (!LABELS_ENSURED.has(wsDir)) {
    const system = [
      ...STATUSES.map((s) => `status:${s}`),
      ...PRIORITIES.map((p) => `priority:${p}`),
    ];
    for (const name of system) {
      await gh(wsDir, ["label", "create", name, "--force", "--color", LABEL_COLOR_SYSTEM], GH_QUICK_TIMEOUT_MS);
    }
    LABELS_ENSURED.add(wsDir);
  }
  for (const name of cardLabels) {
    await gh(wsDir, ["label", "create", name, "--force", "--color", LABEL_COLOR_USER], GH_QUICK_TIMEOUT_MS);
  }
}

export async function createCardGh(wsDir: string, write: CardWrite): Promise<{ card: BoardCard } | { error: string }> {
  // gh issue create n'a pas --json : l'URL de la nouvelle issue est imprimée sur stdout
  await ensureLabels(wsDir, write.labels ?? []);
  const r = await gh(wsDir, [
    "issue", "create", "--title", write.title,
    "--body", write.description ?? "",
    ...targetLabels(write).flatMap((l) => ["--label", l]),
  ]);
  if (!r.ok) return ghError("gh issue create a échoué", r);
  const urlMatch = r.stdout.trim().match(/\/issues\/(\d+)/);
  if (!urlMatch) return { error: `URL d'issue introuvable dans la sortie gh : ${r.stdout.slice(0, GH_ERROR_MAX)}` };
  const number = Number(urlMatch[1]);
  const now = new Date().toISOString();
  const issue: GhIssue = {
    number,
    title: write.title,
    body: write.description ?? "",
    state: "OPEN",
    labels: targetLabels(write).map((name) => ({ name })),
    url: r.stdout.trim().split("\n").pop()!,
    createdAt: now,
    updatedAt: now,
  };
  const sidecar = readSidecar(wsDir);
  sidecar.extras[String(issue.number)] = {
    assignee_agent_id: write.assignee_agent_id ?? null,
    conversation_ids: write.conversation_ids ?? [],
    blocks: write.blocks ?? [],
    blocked_by: write.blocked_by ?? [],
    comments: [],
  };
  saveSidecar(wsDir, sidecar);
  return { card: mergeCard(issue, sidecar.extras[String(issue.number)]) };
}

export async function updateCardGh(wsDir: string, number: number, write: Partial<CardWrite> & { title?: string }): Promise<{ card: BoardCard } | { error: string }> {
  const listed = await listIssues(wsDir);
  if ("error" in listed) return { error: listed.error };
  const issue = listed.issues.find((i) => i.number === number);
  if (!issue) return { error: `issue #${number} introuvable` };

  const current = mergeCard(issue, readExtras(wsDir, number));
  const next: { title: string; description: string; status: string; priority: string; labels: string[] } = {
    title: write.title ?? current.title,
    description: write.description ?? current.description,
    status: write.status ?? current.status,
    priority: write.priority ?? current.priority,
    labels: write.labels ?? current.labels,
  };

  // labels : différence add/remove
  const wanted = new Set(targetLabels(next));
  const have = new Set(issue.labels.map((l) => l.name));
  const add = [...wanted].filter((l) => !have.has(l));
  const remove = [...have].filter((l) => l.startsWith("status:") || l.startsWith("priority:")).filter((l) => !wanted.has(l));

  const args = ["issue", "edit", String(number), "--title", next.title, "--body", next.description];
  for (const l of add) args.push("--add-label", l);
  for (const l of remove) args.push("--remove-label", l);
  await ensureLabels(wsDir, next.labels);
  const r = await gh(wsDir, args);
  if (!r.ok) return ghError("gh issue edit a échoué", r);
  await ensureOpenState(wsDir, number, next.status);

  // extras sidecar
  const sidecar = readSidecar(wsDir);
  const extras = sidecar.extras[String(number)] ?? { comments: [] };
  if (write.assignee_agent_id !== undefined) extras.assignee_agent_id = write.assignee_agent_id;
  if (write.conversation_ids !== undefined) extras.conversation_ids = write.conversation_ids;
  if (write.blocks !== undefined) extras.blocks = write.blocks.filter((id) => id !== String(number));
  if (write.blocked_by !== undefined) extras.blocked_by = write.blocked_by.filter((id) => id !== String(number));
  sidecar.extras[String(number)] = extras;
  saveSidecar(wsDir, sidecar);

  const relisted = await listIssues(wsDir);
  if ("error" in relisted) return { error: relisted.error };
  const updated = relisted.issues.find((i) => i.number === number);
  if (!updated) return { error: `issue #${number} introuvable` };
  return { card: mergeCard(updated, sidecar.extras[String(number)]) };
}

export async function moveCardGh(wsDir: string, number: number, status: string): Promise<{ card: BoardCard } | { error: string }> {
  if (!isStatus(status)) return { error: `statut invalide: ${status}` };
  const listed = await listIssues(wsDir);
  if ("error" in listed) return { error: listed.error };
  const issue = listed.issues.find((i) => i.number === number);
  if (!issue) return { error: `issue #${number} introuvable` };
  const current = mergeCard(issue, readExtras(wsDir, number));
  return updateCardGh(wsDir, number, { status, priority: current.priority, labels: current.labels });
}

const COMMENTS_MAX = 100;

export async function addCommentGh(wsDir: string, number: number, text: string, author = "user"): Promise<{ card: BoardCard } | { error: string }> {
  // commentaire GitHub (visible par tous) + copie locale dans le sidecar pour l'UI
  const r = await gh(wsDir, ["issue", "comment", String(number), "--body", `_${author}_ (via Cogitator) :\n${text}`]);
  if (!r.ok) return ghError("gh issue comment a échoué", r);
  const sidecar = readSidecar(wsDir);
  const extras = sidecar.extras[String(number)] ?? {};
  const comment: BoardComment = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, author, text, at: new Date().toISOString() };
  extras.comments = [...(extras.comments ?? []), comment].slice(-COMMENTS_MAX);
  sidecar.extras[String(number)] = extras;
  saveSidecar(wsDir, sidecar);
  const listed = await listIssues(wsDir);
  if ("error" in listed) return { error: listed.error };
  const issue = listed.issues.find((i) => i.number === number);
  if (!issue) return { error: `issue #${number} introuvable` };
  return { card: mergeCard(issue, extras) };
}

/** "Suppression" = fermeture de l'issue (GitHub ne supprime pas) + nettoyage du sidecar et des relations. */
export async function closeCardGh(wsDir: string, number: number): Promise<{ ok: true } | { error: string }> {
  const r = await gh(wsDir, ["issue", "close", String(number), "--comment", "Fermé via Cogitator"]);
  if (!r.ok) return ghError("gh issue close a échoué", r);
  const sidecar = readSidecar(wsDir);
  delete sidecar.extras[String(number)];
  for (const extras of Object.values(sidecar.extras)) {
    extras.blocks = (extras.blocks ?? []).filter((id) => id !== String(number));
    extras.blocked_by = (extras.blocked_by ?? []).filter((id) => id !== String(number));
  }
  saveSidecar(wsDir, sidecar);
  return { ok: true };
}

/** Vrai si le repo a un remote (board utilisable). */
export async function githubAvailable(wsDir: string): Promise<boolean> {
  if (!existsSync(join(wsDir, ".git"))) return false;
  const r = await gh(wsDir, ["repo", "view", "--json", "nameWithOwner"], 10_000);
  return r.ok;
}
