import { useCallback, useEffect, useState } from "react";
import { api, artifactsApi, openEvents, type ArtifactItem } from "../api";
import { ArtifactViewer } from "../ArtifactViewer";
import { AgentFace } from "../AgentFace";
import { formatDate, t } from "../i18n";
import { Icon, type IconName } from "../icons";
import { Empty, ErrorText, PageHead } from "../ui";
import type { AgentPreset } from "../types";

const KINDS = ["html", "markdown", "image", "table", "code", "pdf"] as const;
const KIND_ICON: Record<ArtifactItem["kind"], IconName> = { html: "monitor", markdown: "files", image: "image", table: "board", code: "feed", pdf: "files" };

/** Galerie des artifacts : liste à gauche, aperçu à droite (comme les artifacts de Claude). */
export default function Artifacts(props: { initialId?: string | null; onOpenThread?: (conversationId: string) => void }) {
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(props.initialId ?? null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ArtifactItem["kind"] | null>(null);

  const refresh = useCallback(() => {
    Promise.all([artifactsApi.list(), api.agents()])
      .then(([a, g]) => { setItems(a.artifacts); setAgents(g.agents); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    refresh();
    return openEvents("/api/events", (e) => { if ((e as { type?: string }).type === "artifact_published") refresh(); });
  }, [refresh]);
  useEffect(() => { if (props.initialId) setSelectedId(props.initialId); }, [props.initialId]);

  const needle = query.trim().toLowerCase();
  const shown = items.filter((a) => (!kind || a.kind === kind) && (!needle || a.title.toLowerCase().includes(needle)));
  const selected = items.find((a) => a.id === selectedId) ?? null;
  const agentOf = (a: ArtifactItem) => agents.find((g) => g.id === a.agent_id);

  return <div className={`artifacts-page${selected ? " has-selection" : ""}`}>
    <div className="artifacts-list">
      <PageHead title={t("artifact.title")} sub={t("artifact.sub")} />
      <ErrorText error={error} />
      {items.length > 0 ? <>
        <label className="sr-only" htmlFor="artifact-search">{t("artifact.search")}</label>
        <input id="artifact-search" type="search" className="artifacts-search" value={query} placeholder={t("artifact.search")} onChange={(e) => setQuery(e.target.value)} />
        <div className="artifacts-kinds" role="group" aria-label={t("artifact.title")}>
          <button type="button" className={`vault-chip${kind === null ? " is-on" : ""}`} aria-pressed={kind === null} onClick={() => setKind(null)}>{t("artifact.all")}</button>
          {KINDS.filter((k) => items.some((a) => a.kind === k)).map((k) => <button key={k} type="button" className={`vault-chip${kind === k ? " is-on" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{t(`artifact.kind.${k}`)}</button>)}
        </div>
      </> : null}
      {loading ? <p role="status">{t("common.loading")}</p> : items.length === 0 ? (
        <Empty title={t("artifact.empty")}>{t("artifact.emptyHint")}</Empty>
      ) : <ul className="artifacts-items">
        {shown.map((a) => {
          const agent = agentOf(a);
          return <li key={a.id}>
            <button type="button" className={`artifact-item${a.id === selectedId ? " is-active" : ""}`} aria-current={a.id === selectedId ? "true" : undefined} onClick={() => setSelectedId(a.id)}>
              <span className="artifact-item-icon" aria-hidden="true"><Icon name={KIND_ICON[a.kind]} size={16} /></span>
              <span className="artifact-item-text">
                <span className="artifact-item-title">{a.title}</span>
                <span className="muted">{`${t(`artifact.kind.${a.kind}`)} · v${a.versions.length} · ${formatDate(a.updated_at, { dateStyle: "medium" })}`}</span>
              </span>
              {agent ? <AgentFace agent={agent} size={26} /> : null}
            </button>
          </li>;
        })}
      </ul>}
    </div>
    <div className="artifacts-preview">
      {selected ? <>
        <button type="button" className="btn btn-sm artifacts-back" onClick={() => setSelectedId(null)}><Icon name="back" size={14} /> {t("artifact.back")}</button>
        <ArtifactViewer
          key={selected.id}
          artifact={selected}
          agentName={agentOf(selected)?.name}
          onThread={selected.conversation_id && props.onOpenThread ? () => props.onOpenThread!(selected.conversation_id!) : undefined}
          onChanged={(next) => { if (!next) setSelectedId(null); refresh(); }}
        />
      </> : <div className="artifacts-placeholder"><Icon name="layers" size={28} /><p className="muted">{items.length ? t("artifact.pick") : t("artifact.emptyHint")}</p></div>}
    </div>
  </div>;
}
