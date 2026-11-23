import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artifactsApi, type ArtifactItem } from "./api";
import { t } from "./i18n";
import { Icon } from "./icons";

interface Board { title: string; group?: string; width: number; height: number }
interface Placed extends Board { index: number; x: number; y: number }
interface Row { label: string | null; y: number }

const GAP = 80, ROW_GAP = 150, LABEL = 46, PAD = 80;
const FRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals";

/** Disposition : une ligne par groupe (ou tout sur des lignes de 3 sans groupe). */
function layout(boards: Board[]): { placed: Placed[]; rows: Row[]; width: number; height: number } {
  const groups: Array<{ label: string | null; items: Array<Board & { index: number }> }> = [];
  const grouped = boards.some((b) => b.group);
  boards.forEach((board, index) => {
    const label = grouped ? board.group ?? "" : null;
    let group = grouped ? groups.find((g) => g.label === label) : groups.at(-1);
    if (!group || (!grouped && group.items.length >= 3)) { group = { label, items: [] }; groups.push(group); }
    group.items.push({ ...board, index });
  });
  const placed: Placed[] = [], rows: Row[] = [];
  let y = PAD, width = 0;
  for (const group of groups) {
    rows.push({ label: group.label, y });
    let x = PAD;
    const top = y + (group.label ? LABEL + 24 : 0) + 34;
    for (const item of group.items) { placed.push({ ...item, x, y: top }); x += item.width + GAP; }
    width = Math.max(width, x - GAP + PAD);
    y = top + Math.max(...group.items.map((i) => i.height)) + ROW_GAP;
  }
  return { placed, rows, width, height: y - ROW_GAP + PAD };
}

/** Canevas de design : toutes les planches côte à côte, zoom et déplacement, puis une planche en grand. */
export function ArtifactCanvas({ artifact, version }: { artifact: ArtifactItem; version: number }) {
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, k: 0.2 });
  const [focus, setFocus] = useState<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    setBoards(null); setFailed(false); setFocus(null);
    fetch(artifactsApi.rawUrl(artifact.id, version), { credentials: "same-origin" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((doc: { boards: Array<Board & { html?: string }> }) => { if (live) setBoards(doc.boards.map(({ title, group, width, height }) => ({ title, group, width: width ?? 1280, height: height ?? 800 }))); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [artifact.id, version]);

  const plan = useMemo(() => layout(boards ?? []), [boards]);

  const fit = useCallback(() => {
    const el = stage.current;
    if (!el || !plan.width) return;
    const k = Math.min(el.clientWidth / plan.width, el.clientHeight / plan.height, 1);
    setView({ k, x: (el.clientWidth - plan.width * k) / 2, y: (el.clientHeight - plan.height * k) / 2 });
  }, [plan]);
  useEffect(() => { fit(); }, [fit]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      const el = stage.current;
      const px = cx ?? (el ? el.clientWidth / 2 : 0), py = cy ?? (el ? el.clientHeight / 2 : 0);
      const k = Math.min(2, Math.max(0.04, v.k * factor));
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    });
  }, []);

  // Molette : zoom avec Ctrl/⌘ (ou pincement), sinon déplacement. Écouteur non passif pour bloquer le zoom de la page.
  useEffect(() => {
    const el = stage.current;
    if (!el || focus !== null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = el.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      } else setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, focus, boards]);

  useEffect(() => {
    if (focus === null || !boards) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocus(null);
      if (event.key === "ArrowRight") setFocus((f) => f === null ? f : (f + 1) % boards.length);
      if (event.key === "ArrowLeft") setFocus((f) => f === null ? f : (f - 1 + boards.length) % boards.length);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focus, boards]);

  if (failed) return <p className="error-text" role="alert">{t("artifact.loadFailed")}</p>;
  if (!boards) return <p className="muted" role="status">{t("common.loading")}</p>;
  const boardUrl = (index: number) => `${artifactsApi.rawUrl(artifact.id, version)}&board=${index}`;

  if (focus !== null) {
    const board = boards[focus]!;
    return <div className="canvas-focus">
      <div className="canvas-bar">
        <button type="button" className="btn btn-sm" onClick={() => setFocus(null)}><Icon name="board" size={14} /> {t("canvas.all")}</button>
        <button type="button" className="icon-btn" aria-label={t("canvas.previous")} onClick={() => setFocus((focus - 1 + boards.length) % boards.length)}><Icon name="back" size={15} /></button>
        <span className="canvas-bar-title">{board.title} <span className="muted">{`${focus + 1} / ${boards.length} · ${board.width}×${board.height}`}</span></span>
        <button type="button" className="icon-btn canvas-next" aria-label={t("canvas.next")} onClick={() => setFocus((focus + 1) % boards.length)}><Icon name="back" size={15} /></button>
        <a className="btn btn-sm" href={boardUrl(focus)} target="_blank" rel="noreferrer">{t("artifact.newTab")} <span aria-hidden="true">↗</span></a>
      </div>
      <FocusBoard key={focus} board={board} url={boardUrl(focus)} />
    </div>;
  }

  return <div className="canvas-wrap">
    <div
      ref={stage}
      className="canvas-stage"
      onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => {
        const d = drag.current; if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true; d.x = e.clientX; d.y = e.clientY;
        setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      }}
      onPointerUp={(e) => {
        const d = drag.current; drag.current = null;
        if (d?.moved) return;
        // Clic sans déplacement : ouvrir la planche sous le pointeur.
        const rect = e.currentTarget.getBoundingClientRect();
        const cx = (e.clientX - rect.left - view.x) / view.k, cy = (e.clientY - rect.top - view.y) / view.k;
        const hit = plan.placed.find((b) => cx >= b.x && cx <= b.x + b.width && cy >= b.y - 34 && cy <= b.y + b.height);
        if (hit) setFocus(hit.index);
      }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <div className="canvas-world" style={{ width: plan.width, height: plan.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        {plan.rows.map((row, i) => row.label ? <div key={i} className="canvas-row-label" style={{ top: row.y, left: PAD }}>{row.label}</div> : null)}
        {plan.placed.map((board) => <div key={board.index} className="canvas-board" style={{ left: board.x, top: board.y, width: board.width, height: board.height }}>
          <div className="canvas-board-name">{board.title}</div>
          <iframe title={board.title} src={boardUrl(board.index)} sandbox={FRAME_SANDBOX} referrerPolicy="no-referrer" loading="lazy" tabIndex={-1} />
        </div>)}
      </div>
    </div>
    <div className="canvas-tools" role="toolbar" aria-label={t("canvas.tools")}>
      <button type="button" className="icon-btn" aria-label={t("canvas.zoomOut")} onClick={() => zoomAt(1 / 1.25)}>−</button>
      <span className="canvas-zoom">{`${Math.round(view.k * 100)} %`}</span>
      <button type="button" className="icon-btn" aria-label={t("canvas.zoomIn")} onClick={() => zoomAt(1.25)}>+</button>
      <button type="button" className="btn btn-sm" onClick={fit}>{t("canvas.fit")}</button>
      <label className="canvas-jump"><span className="sr-only">{t("canvas.open")}</span>
        <select value="" onChange={(e) => { if (e.target.value) setFocus(Number(e.target.value)); }}>
          <option value="">{t("canvas.boards", { count: boards.length })}</option>
          {boards.map((b, i) => <option key={i} value={i}>{b.group ? `${b.group} · ${b.title}` : b.title}</option>)}
        </select>
      </label>
    </div>
    <p className="canvas-hint muted">{t("canvas.hint")}</p>
  </div>;
}

/** Une planche en grand, ajustée à la place disponible et utilisable (clics, saisie). */
function FocusBoard({ board, url }: { board: Board; url: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [actual, setActual] = useState(false);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const update = () => setScale(Math.min(1, (el.clientWidth - 24) / board.width, (el.clientHeight - 24) / board.height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [board.width, board.height]);
  const k = actual ? 1 : scale;
  return <div ref={box} className={`canvas-focus-box${actual ? " is-actual" : ""}`}>
    <button type="button" className="btn btn-sm canvas-actual" aria-pressed={actual} onClick={() => setActual((v) => !v)}>{actual ? t("canvas.fitBoard") : `${Math.round(scale * 100)} % → 100 %`}</button>
    <div className="canvas-focus-size" style={{ width: board.width * k, height: board.height * k }}>
      <iframe title={board.title} src={url} sandbox={FRAME_SANDBOX} referrerPolicy="no-referrer" style={{ width: board.width, height: board.height, transform: `scale(${k})` }} />
    </div>
  </div>;
}
