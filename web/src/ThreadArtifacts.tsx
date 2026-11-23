import { useEffect, useState } from "react";
import { artifactsApi, type ArtifactItem } from "./api";
import { ArtifactViewer } from "./ArtifactViewer";
import { formatDate, t } from "./i18n";
import { Icon } from "./icons";

/** Onglet « Artifacts » du panneau d'un fil : liste et aperçu, rafraîchis pendant que l'agent publie. */
export function ThreadArtifacts({ conversationId, refreshKey, onCount }: { conversationId: string; refreshKey: number; onCount: (n: number) => void }) {
  const [items, setItems] = useState<ArtifactItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => artifactsApi.list(conversationId).then((r) => {
      if (!live) return;
      setItems(r.artifacts);
      onCount(r.artifacts.length);
      // Ouvre directement le plus récent, comme un aperçu qui suit le travail de l'agent.
      setSelectedId((current) => current ?? r.artifacts[0]?.id ?? null);
    }).catch(() => undefined);
    void load();
    const timer = setInterval(load, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [conversationId, refreshKey, onCount]);

  const selected = items?.find((a) => a.id === selectedId) ?? null;
  if (!items) return <p role="status" className="muted">{t("common.loading")}</p>;
  if (!items.length) return <p className="muted">{t("artifact.noneInThread")}</p>;
  return <div className="thread-artifacts">
    {items.length > 1 || !selected ? <ul className="thread-artifact-list" aria-label={t("artifact.inThread")}>
      {items.map((a) => <li key={a.id}><button type="button" className={`artifact-item${a.id === selectedId ? " is-active" : ""}`} onClick={() => setSelectedId(a.id)}>
        <span className="artifact-item-icon" aria-hidden="true"><Icon name="layers" size={14} /></span>
        <span className="artifact-item-text"><span className="artifact-item-title">{a.title}</span><span className="muted">{`v${a.versions.length} · ${formatDate(a.updated_at, { timeStyle: "short" })}`}</span></span>
      </button></li>)}
    </ul> : null}
    {selected ? <ArtifactViewer artifact={selected} compact onExpand={() => { window.location.hash = `artifact=${selected.id}`; }} /> : null}
  </div>;
}
