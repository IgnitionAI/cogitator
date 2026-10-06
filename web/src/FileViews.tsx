import { useEffect, useState } from "react";
import { api } from "./api";
import type { FileChange, FileEvent } from "./types";
import { Modal } from "./ui";

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  children?: TreeNode[];
}

/** Ligne de fichier cliquable (panneau conversation + modale workspace). */
export function FileRow(props: { f: FileChange; onClick?: () => void }) {
  const { f } = props;
  return (
    <div className={`file-row ${props.onClick ? "clickable" : ""}`} title={f.path} onClick={props.onClick}>
      <span className={`file-kind ${f.kind}`}>{f.kind === "write" ? "W" : "E"}</span>
      <span className="file-path mono">{f.path.split("/").slice(-2).join("/")}</span>
      <span className="file-stats">
        {f.additions > 0 ? <span className="add">+{f.additions}</span> : null}
        {f.deletions > 0 ? <span className="del">−{f.deletions}</span> : null}
      </span>
      {props.onClick ? <DiffAffordance /> : null}
    </div>
  );
}

/** Diff d'un fichier reconstruit depuis les toolcalls de la session. */
export function FileDiffModal(props: { conversationId: string; path: string; onClose: () => void }) {
  const [operations, setOperations] = useState<FileEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.fileDetail(props.conversationId, props.path)
      .then((r) => setOperations(r.operations))
      .catch((e: Error) => setError(e.message));
  }, [props.conversationId, props.path]);

  const shortName = props.path.split("/").slice(-2).join("/");
  return (
    <Modal title={`Diff — ${shortName}`} onClose={props.onClose} wide>
      {error ? <div className="error-text">{error}</div> : null}
      {operations === null ? <div className="muted" style={{ padding: 12 }}>Chargement…</div> : null}
      {operations !== null && operations.length === 0 ? (
        <div className="muted" style={{ padding: 12 }}>Aucune opération trouvée dans cette session.</div>
      ) : null}
      {operations?.map((op, i) => (
        <div key={i} className="diff-op">
          <div className="diff-op-head">
            <span className={`file-kind ${op.kind}`}>{op.kind === "write" ? "W" : "E"}</span>
            <span className="muted mono">{new Date(op.at).toLocaleTimeString()}</span>
            <span className="file-stats" style={{ marginLeft: "auto" }}>
              {op.additions > 0 ? <span className="add">+{op.additions}</span> : null}
              {op.deletions > 0 ? <span className="del">−{op.deletions}</span> : null}
            </span>
          </div>
          {op.hunks.map((h, j) => (
            <div key={j} className="diff-hunk">
              {h.old ? <pre className="diff-old">{h.old}</pre> : null}
              {h.new ? <pre className="diff-new">{h.new}</pre> : null}
            </div>
          ))}
        </div>
      ))}
      {operations !== null && operations.length > 0 ? (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          Reconstruit depuis les toolcalls de la session — l'état actuel du fichier sur disque peut différer.
        </div>
      ) : null}
    </Modal>
  );
}

/** Ligne de fichier cliquable : chevron d'affordance diff. */
function DiffAffordance() {
  return <span className="chevron afford">▸</span>;
}

/** Arborescence du workspace : tree à gauche, contenu read-only à droite. */
export function FileTreeModal(props: {
  workspaceId: string;
  workspaceName: string;
  /** fichiers modifiés (activité) : surlignés dans le tree */
  modifiedPaths?: Set<string>;
  onClose: () => void;
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<{ name: string; content: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.workspaceTree(props.workspaceId).then((r) => setTree(r.tree)).catch((e: Error) => setError(e.message));
  }, [props.workspaceId]);

  const pick = (node: TreeNode) => {
    if (node.type === "dir") {
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(node.path)) next.delete(node.path);
        else next.add(node.path);
        return next;
      });
      return;
    }
    setSelected(node.path);
    setError(null);
    setContent(null);
    api.workspaceFile(props.workspaceId, node.path)
      .then((r) => setContent({ name: r.file.name, content: r.file.content, truncated: r.file.truncated }))
      .catch((e: Error) => setError(e.message));
  };

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((n) => (
      <div key={n.path}>
        <div
          className={`tree-row ${selected === n.path ? "selected" : ""} ${props.modifiedPaths?.has(n.path) ? "modified" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => pick(n)}
          title={n.path}
        >
          <span className="tree-icon">{n.type === "dir" ? (open.has(n.path) ? "▾" : "▸") : ""}</span>
          <span className={`tree-name ${n.type}`}>{n.name}</span>
          {props.modifiedPaths?.has(n.path) ? <span className="tree-dot" title="modifié dans une conversation" /> : null}
          {n.type === "file" && n.size !== undefined ? (
            <span className="tree-size">{n.size > 1024 ? `${Math.round(n.size / 1024)} Ko` : `${n.size} o`}</span>
          ) : null}
        </div>
        {n.type === "dir" && open.has(n.path) && n.children ? (
          <div>{renderNodes(n.children, depth + 1)}</div>
        ) : null}
      </div>
    ));

  return (
    <Modal title={`Arborescence — ${props.workspaceName}`} onClose={props.onClose} wide>
      <div className="tree-panes">
        <div className="tree-nav">{renderNodes(tree, 0)}</div>
        <div className="tree-viewer">
          {error ? <div className="error-text" style={{ padding: 12 }}>{error}</div> : null}
          {!error && !content ? (
            <div className="muted" style={{ padding: 14, fontSize: 12.5 }}>
              Clique un fichier pour le lire (read-only). Les points marquent les fichiers modifiés par les agents.
            </div>
          ) : null}
          {content ? (
            <>
              <div className="tree-viewer-head mono">{selected}</div>
              <pre className="tree-content">{content.content}</pre>
              {content.truncated ? <div className="muted" style={{ padding: 8, fontSize: 11.5 }}>(tronqué)</div> : null}
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
