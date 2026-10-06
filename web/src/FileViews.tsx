import { useEffect, useState } from "react";
import { api } from "./api";
import type { FileChange, FileEvent } from "./types";
import { Modal } from "./ui";

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
