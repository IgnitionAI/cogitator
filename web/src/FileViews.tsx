import { t, formatTime, formatNumber, localizeText } from "./i18n";
import { useEffect, useRef, useState } from "react";
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
    <div className={`file-row ${props.onClick ? "clickable" : ""}`} title={f.path} aria-label={props.onClick ? t("workspace.viewChanges", { path: f.path }) : undefined} role={props.onClick ? "button" : undefined} tabIndex={props.onClick ? 0 : undefined} onClick={props.onClick} onKeyDown={props.onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onClick?.(); } } : undefined}>
      <span className={`file-kind ${f.kind === "write" ? "W" : "E"}`} title={f.kind === "write" ? t("workspace.write") : t("workspace.edit")}>{f.kind === "write" ? t("workspace.writeShort") : t("workspace.editShort")}</span>
      <span className="file-path mono">{f.path.split("/").slice(-2).join("/")}</span>
      <span className="file-stats">
        {f.additions > 0 ? <span className="add">+{formatNumber(f.additions)}</span> : null}
        {f.deletions > 0 ? <span className="del">−{formatNumber(f.deletions)}</span> : null}
      </span>
      {props.onClick ? <DiffAffordance /> : null}
    </div>
  );
}

/** Diff d'un fichier reconstruit depuis les toolcalls de la session. */
export function FileDiffModal(props: { conversationId: string; path: string; onClose: () => void }) {
  const [operations, setOperations] = useState<FileEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setOperations(null);
    setError(null);
    api.fileDetail(props.conversationId, props.path)
      .then((r) => { if (active) setOperations(r.operations); })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [props.conversationId, props.path, retry]);

  const shortName = props.path.split("/").slice(-2).join("/");
  return (
    <Modal title={t("workspace.changesTitle", { name: shortName })} onClose={props.onClose} wide>
      {error ? <div className="error-text" role="alert">{t("workspace.error", { detail: localizeText(error) })} <button type="button" className="btn btn-sm" onClick={() => setRetry((n) => n + 1)}>{t("workspace.retry")}</button></div> : null}
      {!error && operations === null ? <div className="muted" role="status" style={{ padding: 12 }}>{t("workspace.loading")}</div> : null}
      {operations !== null && operations.length === 0 ? (
        <div className="muted" style={{ padding: 12 }}>{t("workspace.noOperations")}</div>
      ) : null}
      {operations?.map((op, i) => (
        <div key={i} className="diff-op">
          <div className="diff-op-head">
            <span className={`file-kind ${op.kind === "write" ? "W" : "E"}`} title={op.kind === "write" ? t("workspace.write") : t("workspace.edit")}>{op.kind === "write" ? t("workspace.writeShort") : t("workspace.editShort")}</span>
            <span className="muted mono">{formatTime(op.at)}</span>
            <span className="file-stats" style={{ marginLeft: "auto" }}>
              {op.additions > 0 ? <span className="add">+{formatNumber(op.additions)}</span> : null}
              {op.deletions > 0 ? <span className="del">−{formatNumber(op.deletions)}</span> : null}
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
          {t("workspace.reconstructed")}
        </div>
      ) : null}
    </Modal>
  );
}

/** Ligne de fichier cliquable : chevron d'affordance diff. */
function DiffAffordance() {
  return <span className="chevron afford" aria-hidden="true">▸</span>;
}

export function TreePanel(props: {
  workspaceId: string;
  modifiedPaths?: Set<string>;
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<{ name: string; content: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeLoading, setTreeLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const fileRequest = useRef(0);

  useEffect(() => {
    let active = true;
    fileRequest.current++;
    setTreeLoading(true);
    setTreeError(null);
    setTree([]);
    setSelected(null);
    setContent(null);
    setError(null);
    setFileLoading(false);
    setOpen(new Set());
    api.workspaceTree(props.workspaceId)
      .then((r) => { if (active) setTree(r.tree); })
      .catch((e: Error) => { if (active) setTreeError(e.message); })
      .finally(() => { if (active) setTreeLoading(false); });
    return () => { active = false; fileRequest.current++; };
  }, [props.workspaceId, retry]);

  const loadFile = (path: string) => {
    const current = ++fileRequest.current;
    setSelected(path);
    setError(null);
    setContent(null);
    setFileLoading(true);
    api.workspaceFile(props.workspaceId, path)
      .then((r) => {
        if (current === fileRequest.current) setContent({ name: r.file.name, content: r.file.content, truncated: r.file.truncated });
      })
      .catch((e: Error) => { if (current === fileRequest.current) setError(e.message); })
      .finally(() => { if (current === fileRequest.current) setFileLoading(false); });
  };

  const pick = (node: TreeNode) => {
    if (node.type === "file") { loadFile(node.path); return; }
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  };

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((n) => (
      <div key={n.path}>
        <button
          type="button"
          className={`tree-row ${selected === n.path ? "selected" : ""} ${props.modifiedPaths?.has(n.path) ? "modified" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => pick(n)}
          title={n.path}
          aria-expanded={n.type === "dir" ? open.has(n.path) : undefined}
          aria-pressed={n.type === "file" ? selected === n.path : undefined}
        >
          <span className="tree-icon">{n.type === "dir" ? (open.has(n.path) ? "▾" : "▸") : ""}</span>
          <span className={`tree-name ${n.type}`}>{n.name}</span>
          {props.modifiedPaths?.has(n.path) ? <span className="tree-dot" role="img" aria-label={t("workspace.modified")} /> : null}
          {n.type === "file" && n.size !== undefined ? (
            <span className="tree-size">{n.size > 1024 ? t("workspace.kilobytes", { count: formatNumber(Math.round(n.size / 1024)) }) : t("workspace.bytes", { count: formatNumber(n.size) })}</span>
          ) : null}
        </button>
        {n.type === "dir" && open.has(n.path) && n.children ? (
          <div>{renderNodes(n.children, depth + 1)}</div>
        ) : null}
      </div>
    ));

  return (
      <div className="tree-panes">
        <div className="tree-nav">
          <button type="button" className="btn btn-sm" disabled={treeLoading} onClick={() => setRetry((n) => n + 1)}>{t("workspace.refresh")}</button>
          {treeLoading ? <p role="status">{t("workspace.treeLoading")}</p> : treeError ? <div role="alert" className="error-text">{t("workspace.error", { detail: localizeText(treeError) })} <button type="button" className="btn btn-sm" onClick={() => setRetry((n) => n + 1)}>{t("workspace.retry")}</button></div> : tree.length === 0 ? <p className="muted">{t("workspace.emptyFolder")}</p> : renderNodes(tree, 0)}
        </div>
        <div className="tree-viewer">
          {error ? <div className="error-text" role="alert" style={{ padding: 12 }}>{t("workspace.error", { detail: localizeText(error) })} <button type="button" className="btn btn-sm" onClick={() => selected && loadFile(selected)}>{t("workspace.retry")}</button></div> : null}
          {fileLoading ? <p role="status">{t("workspace.fileLoading")}</p> : null}
          {!fileLoading && !error && !content ? (
            <div className="muted" style={{ padding: 14, fontSize: 12.5 }}>
              {t("workspace.selectFile")}
            </div>
          ) : null}
          {content ? (
            <>
              <div className="tree-viewer-head mono">{selected}</div>
              <pre className="tree-content" tabIndex={0} aria-label={t("workspace.fileContent", { path: selected ?? "" })}>{content.content}</pre>
              {content.truncated ? <div className="muted" style={{ padding: 8, fontSize: 11.5 }}>{t("workspace.truncated")}</div> : null}
            </>
          ) : null}
        </div>
      </div>
  );
}

/** Arborescence du workspace : tree à gauche, contenu read-only à droite. */
export function FileTreeModal(props: {
  workspaceId: string;
  workspaceName: string;
  modifiedPaths?: Set<string>;
  onClose: () => void;
}) {
  return (
    <Modal title={t("workspace.treeTitle", { name: props.workspaceName })} onClose={props.onClose} wide>
      <TreePanel workspaceId={props.workspaceId} modifiedPaths={props.modifiedPaths} />
    </Modal>
  );
}
