import { execFile } from "node:child_process";

/**
 * Énumération des subagents herdr d'une conversation (ADR-012).
 * Le serveur est le seul lecteur du socket herdr : shell-out `herdr api snapshot`
 * (JSON, schéma figé via `herdr api schema --json` protocol 22). Dégradation
 * gracieuse : daemon absent / timeout / JSON invalide → { live: false, subagents: [] }.
 */

/** Pane herdr — sous-ensemble de PaneInfo du schéma socket. */
export interface HerdrPane {
  pane_id: string;
  label?: string | null;
  agent?: string | null;
  agent_status?: string;
  agent_session?: { source: string; agent: string; kind: "id" | "path"; value: string } | null;
}

export interface SubagentView {
  pane_id: string;
  label: string | null;
  agent: string | null;
  status: string;
  session: string | null;
}

export type SubagentRunner = (cmd: string, args: string[]) => Promise<string>;

export const HERDR_SNAPSHOT_TIMEOUT_MS = 3_000;

const execRunner: SubagentRunner = (cmd, args) =>
  new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout: HERDR_SNAPSHOT_TIMEOUT_MS }, (err, stdout) =>
      err ? reject(err) : resolvePromise(stdout),
    );
  });

/** Extrait les panes d'un snapshot quelconque (forme racine à confirmer au spike). */
function collectPanes(node: unknown, out: Map<string, HerdrPane>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === "object" && typeof (item as { pane_id?: unknown }).pane_id === "string") {
        const pane = item as HerdrPane;
        if (!out.has(pane.pane_id)) out.set(pane.pane_id, pane);
      } else {
        collectPanes(item, out);
      }
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) collectPanes(value, out);
  }
}

/**
 * Règle de liaison parent → enfant. Hypothèse L1 : l'extension pi déclare l'identité
 * de la session parente dans agent_session.source. À confirmer par le spike live
 * (plan 0006 étape 1) ; si le réel est le répertoire de value (kind "path"), c'est ici
 * que la règle change — aucun autre appelant ne doit décider de liaison lui-même.
 */
export function linkBelongsToConversation(pane: HerdrPane, sessionFile: string): boolean {
  return pane.agent_session?.source === sessionFile;
}

/** Pur : panes liés à la session + projection lecture seule. */
export function subagentsForConversation(snapshot: unknown, sessionFile: string): SubagentView[] {
  const panes = new Map<string, HerdrPane>();
  collectPanes(snapshot, panes);
  return [...panes.values()]
    .filter((pane) => linkBelongsToConversation(pane, sessionFile))
    .map((pane) => ({
      pane_id: pane.pane_id,
      label: pane.label ?? null,
      agent: pane.agent ?? null,
      status: pane.agent_status ?? "unknown",
      session: pane.agent_session?.value ?? null,
    }));
}

/** Glue : snapshot herdr → réponse API. sessionFile null → jamais de mapping, live selon herdr. */
export async function listSubagents(
  sessionFile: string | null,
  runner: SubagentRunner = execRunner,
): Promise<{ live: boolean; subagents: SubagentView[] }> {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(await runner("herdr", ["api", "snapshot"]));
  } catch {
    return { live: false, subagents: [] };
  }
  if (!sessionFile) return { live: true, subagents: [] };
  return { live: true, subagents: subagentsForConversation(snapshot, sessionFile) };
}
