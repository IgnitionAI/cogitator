import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { api } from "./api";
import { localizeText, t, type TranslationKey } from "./i18n";
import { Icon } from "./icons";
import { Empty, ErrorText, PageHead } from "./ui";
import type { TerminalAgent, TerminalSession, TerminalStatus, Workspace } from "./types";

const SUGGEST_KEY = "cogitator.terminal.suggestions";
const ASSIST_AGENT_KEY = "cogitator.terminal.assistAgent";
const GHOST_DELAY_MS = 650;

function readPref(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } }
function writePref(key: string, value: string): void { try { window.localStorage.setItem(key, value); } catch { /* préférence locale facultative */ } }

export default function TerminalScreen() {
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [assistAgent, setAssistAgent] = useState(() => readPref(ASSIST_AGENT_KEY) ?? "");
  const [suggest, setSuggest] = useState(() => readPref(SUGGEST_KEY) !== "0");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await api.terminalStatus();
    setStatus(next);
    setActive((current) => current && next.sessions.some((s) => s.id === current) ? current : next.sessions.at(-1)?.id ?? null);
    return next;
  }, []);

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
    api.workspaces().then((r) => setWorkspaces(r.workspaces)).catch(() => undefined);
  }, [refresh]);

  const open = async (agentId?: string) => {
    setBusy(true); setError(null);
    try {
      const r = await api.terminalCreate({ agent_id: agentId, workspace_id: workspaceId || undefined, cols: 100, rows: 30 });
      await refresh();
      setActive(r.session.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const close = async (session: TerminalSession) => {
    if (!session.exited && !window.confirm(t("terminal.closeConfirm"))) return;
    try { await api.terminalClose(session.id); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (!status) return <><PageHead title={t("terminal.title")} sub={t("terminal.intro")} /><ErrorText error={error} /></>;
  if (!status.enabled) {
    const key = `terminal.reason.${status.reason ?? "TERMINAL_UNAVAILABLE"}` as TranslationKey;
    return <><PageHead title={t("terminal.title")} sub={t("terminal.intro")} /><Empty title={t("terminal.title")}>{t(key)}</Empty></>;
  }

  const agents = status.agents;
  const current = status.sessions.find((s) => s.id === active) ?? null;
  return (
    <div className="terminal-page">
      <PageHead title={t("terminal.title")} sub={t("terminal.intro")} />
      <ErrorText error={error} />
      <div className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label={t("terminal.title")}>
          {status.sessions.map((s) => (
            <div key={s.id} className={`terminal-tab${s.id === active ? " is-active" : ""}${s.exited ? " is-exited" : ""}`}>
              <button type="button" role="tab" aria-selected={s.id === active} onClick={() => setActive(s.id)}>
                <Icon name={s.kind === "agent" ? "bot" : "terminal"} size={14} />
                <span>{s.title}</span>
              </button>
              <button type="button" className="icon-btn" aria-label={t("terminal.close", { name: s.title })} onClick={() => void close(s)}><Icon name="close" size={12} /></button>
            </div>
          ))}
        </div>
        <div className="terminal-actions">
          <select aria-label={t("terminal.folder")} title={t("terminal.folder")} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            <option value="">{t("terminal.home")}</option>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select aria-label={t("terminal.openAgent")} value="" disabled={busy || agents.length === 0} onChange={(e) => { if (e.target.value) void open(e.target.value); }}>
            <option value="">{t("terminal.openAgent")}</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void open()}><Icon name="plus" size={14} /> {t("terminal.newShell")}</button>
        </div>
      </div>
      {current ? (
        <TerminalView
          key={current.id}
          session={current}
          agents={agents}
          assistAgent={assistAgent}
          onAssistAgent={(id) => { setAssistAgent(id); writePref(ASSIST_AGENT_KEY, id); }}
          suggest={suggest}
          onSuggest={(on) => { setSuggest(on); writePref(SUGGEST_KEY, on ? "1" : "0"); }}
          onExit={() => void refresh()}
        />
      ) : (
        <Empty title={t("terminal.empty")} action={<button type="button" className="btn btn-primary" disabled={busy} onClick={() => void open()}><Icon name="terminal" size={14} /> {t("terminal.newShell")}</button>}>
          {t("terminal.emptyHint")}
        </Empty>
      )}
    </div>
  );
}

interface Failure { command: string; code: number }
interface Explanation { text: string; fix?: string }

function TerminalView(props: {
  session: TerminalSession;
  agents: TerminalAgent[];
  assistAgent: string;
  onAssistAgent: (id: string) => void;
  suggest: boolean;
  onSuggest: (on: boolean) => void;
  onExit: () => void;
}) {
  const { session } = props;
  const host = useRef<HTMLDivElement>(null);
  const ghostEl = useRef<HTMLSpanElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<((data: string) => void) | null>(null);
  const [connection, setConnection] = useState<"connecting" | "open" | "lost" | "exited">("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [thinking, setThinking] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [assistError, setAssistError] = useState<string | null>(null);
  // Aides IA : seulement pour un shell (un agent pi a déjà sa propre interface).
  const aiEnabled = session.kind === "shell";
  const settings = useRef({ suggest: props.suggest, agent: props.assistAgent });
  settings.current = { suggest: props.suggest, agent: props.assistAgent };

  const send = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "i", d: data }));
  }, []);

  /** Dernières lignes visibles (contexte pour l'assistant). */
  const recentOutput = useCallback((lines = 40) => {
    const term = termRef.current;
    if (!term) return "";
    const buffer = term.buffer.active;
    const end = buffer.baseY + buffer.cursorY;
    const out: string[] = [];
    for (let i = Math.max(0, end - lines); i <= end; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? "");
    return out.join("\n").replace(/\n+$/, "");
  }, []);

  const assist = useCallback((body: { mode: "command" | "complete" | "explain"; input: string; output?: string; exit_code?: number }, signal?: AbortSignal) =>
    api.terminalAssist({ ...body, cwd: session.cwd, agent_id: settings.current.agent || undefined }, signal), [session.cwd]);

  useEffect(() => {
    let disposed = false;
    let term: XTerm | null = null;
    let fit: FitAddon | null = null;
    let observer: ResizeObserver | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Ligne en cours, reconstituée depuis la frappe (fiable tant qu'on ne navigue pas dans la ligne).
    let line = "";
    let lineKnown = true;
    let lastCommand: string | null = null;
    let ghost = "";
    let ghostTimer: ReturnType<typeof setTimeout> | undefined;
    let ghostAbort: AbortController | null = null;

    const renderGhost = () => {
      const el = ghostEl.current;
      if (!el || !term) return;
      const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
      if (!ghost || !screen) { el.textContent = ""; el.hidden = true; return; }
      const cellW = screen.clientWidth / term.cols;
      const cellH = screen.clientHeight / term.rows;
      const buffer = term.buffer.active;
      if (buffer.viewportY !== buffer.baseY) { el.hidden = true; return; }
      const frame = el.parentElement!.getBoundingClientRect();
      const origin = screen.getBoundingClientRect();
      el.style.left = `${origin.left - frame.left + buffer.cursorX * cellW}px`;
      el.style.top = `${origin.top - frame.top + buffer.cursorY * cellH}px`;
      el.style.height = `${cellH}px`;
      el.style.lineHeight = `${cellH}px`;
      el.textContent = ghost;
      el.hidden = false;
    };
    const clearGhost = () => {
      ghost = ""; ghostAbort?.abort(); ghostAbort = null;
      if (ghostTimer) clearTimeout(ghostTimer);
      renderGhost();
    };
    const scheduleGhost = () => {
      clearGhost();
      if (!aiEnabled || !settings.current.suggest || !lineKnown || line.trim().length < 2 || line.trimStart().startsWith("#")) return;
      const snapshot = line;
      ghostTimer = setTimeout(() => {
        const abort = new AbortController();
        ghostAbort = abort;
        assist({ mode: "complete", input: snapshot, output: recentOutput(12) }, abort.signal)
          .then((r) => { if (!abort.signal.aborted && line === snapshot && r.text) { ghost = r.text; renderGhost(); } })
          .catch(() => undefined);
      }, GHOST_DELAY_MS);
    };

    const askCommand = (request: string) => {
      send("\u0015"); // efface la ligne dans le shell (readline : unix-line-discard)
      line = ""; lineKnown = true;
      setThinking(true); setAssistError(null);
      assist({ mode: "command", input: request, output: recentOutput(20) })
        .then((r) => { if (r.text) { send(r.text); line = r.text; lineKnown = true; } term?.focus(); })
        .catch((e: Error) => setAssistError(e.message))
        .finally(() => setThinking(false));
    };

    const onInput = (data: string) => {
      if (!aiEnabled) return send(data);
      if (data === "\u001b[C" && ghost) { // → : accepte la suggestion
        const accepted = ghost; clearGhost(); send(accepted); line += accepted; return;
      }
      if (data === "\r") {
        const request = line.trimStart();
        if (lineKnown && request.startsWith("#") && request.slice(1).trim().length > 2) { clearGhost(); askCommand(request.slice(1).trim()); return; }
        lastCommand = lineKnown && line.trim() ? line.trim() : null;
        line = ""; lineKnown = true; clearGhost(); setFailure(null); setExplanation(null);
        return send(data);
      }
      if (data === "\u007f") { line = line.slice(0, -1); send(data); return scheduleGhost(); }
      if (data === "\u0003" || data === "\u0015") { line = ""; lineKnown = true; clearGhost(); return send(data); }
      if (!/[\u0000-\u001f\u007f]/.test(data)) { line += data; send(data); return scheduleGhost(); }
      // Tab, flèches, Échap… : la ligne n'est plus connue avec certitude jusqu'à Entrée.
      lineKnown = false; clearGhost(); send(data);
    };

    inputRef.current = onInput;

    const connect = () => {
      if (disposed) return;
      setConnection((c) => c === "exited" ? c : "connecting");
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/api/terminal/ws/${session.id}`);
      wsRef.current = ws;
      let replayed = false;
      ws.onopen = () => {
        setConnection((c) => c === "exited" ? c : "open");
        if (term) ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }));
      };
      ws.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as { t: "o"; d: string } | { t: "x"; code: number };
        if (frame.t === "o") {
          if (!replayed) { replayed = true; term?.reset(); } // une reconnexion rejoue le tampon complet
          term?.write(frame.d, renderGhost);
        } else {
          setExitCode(frame.code); setConnection("exited");
          term?.write(`\r\n\u001b[2m${t("terminal.exited", { code: frame.code })}\u001b[0m\r\n`);
          props.onExit();
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        setConnection((c) => c === "exited" ? c : "lost");
        retry = setTimeout(connect, 2000);
      };
    };

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !host.current) return;
      const css = getComputedStyle(document.documentElement);
      term = new Terminal({
        cursorBlink: true, fontSize: 13, scrollback: 5000, allowProposedApi: true,
        fontFamily: "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
        theme: {
          background: css.getPropertyValue("--surface").trim() || "#0f1011",
          foreground: css.getPropertyValue("--fg").trim() || "#f7f8f8",
          cursor: css.getPropertyValue("--accent-text").trim() || "#8792ed",
          selectionBackground: "rgba(94, 106, 210, 0.35)",
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      termRef.current = term;
      fit.fit();
      term.onData(onInput);
      term.onResize(({ cols, rows }) => { const ws = wsRef.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "r", c: cols, r: rows })); });
      term.onScroll(renderGhost);
      // Statut de sortie émis par le shell (OSC 133;D;code) : proposer d'expliquer un échec.
      term.parser.registerOscHandler(133, (payload) => {
        const m = /^D;(\d+)/.exec(payload);
        if (m && aiEnabled) {
          const code = Number(m[1]);
          if (code !== 0 && code !== 130 && lastCommand) setFailure({ command: lastCommand, code });
          lastCommand = null;
        }
        return true;
      });
      observer = new ResizeObserver(() => { try { fit?.fit(); renderGhost(); } catch { /* conteneur masqué */ } });
      observer.observe(host.current);
      term.focus();
      connect();
    })();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (ghostTimer) clearTimeout(ghostTimer);
      ghostAbort?.abort();
      observer?.disconnect();
      const ws = wsRef.current;
      if (ws) { ws.onclose = null; ws.close(); }
      term?.dispose();
      termRef.current = null;
      inputRef.current = null;
    };
    // La session est la clé du composant : un seul cycle de vie par session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const explain = async () => {
    if (!failure) return;
    setExplaining(true); setAssistError(null);
    try { setExplanation(await assist({ mode: "explain", input: failure.command, output: recentOutput(60), exit_code: failure.code })); }
    catch (e) { setAssistError(e instanceof Error ? e.message : String(e)); }
    finally { setExplaining(false); }
  };

  const key = (data: string) => { (inputRef.current ?? send)(data); termRef.current?.focus(); };

  return (
    <section className="terminal-view" aria-label={session.title}>
      {failure && aiEnabled ? (
        <div className="terminal-failure" role="status">
          <Icon name="warning" size={14} />
          <span className="terminal-failure-text">{t("terminal.failed", { command: failure.command.length > 60 ? `${failure.command.slice(0, 57)}…` : failure.command, code: failure.code })}</span>
          {!explanation ? <button type="button" className="btn btn-sm" disabled={explaining} onClick={() => void explain()}>{explaining ? t("terminal.explaining") : t("terminal.explain")}</button> : null}
          <button type="button" className="icon-btn" aria-label={t("terminal.dismiss")} onClick={() => { setFailure(null); setExplanation(null); }}><Icon name="close" size={12} /></button>
          {explanation ? (
            <div className="terminal-explanation">
              <p>{explanation.text}</p>
              {explanation.fix ? (
                <div className="terminal-fix">
                  <code>{explanation.fix}</code>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => { send("\u0015" + explanation.fix); termRef.current?.focus(); setFailure(null); setExplanation(null); }}>{t("terminal.insertFix")}</button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {assistError ? <ErrorText error={t("terminal.assistError", { error: localizeText(assistError) })} /> : null}

      <div className="terminal-frame">
        <div ref={host} className="terminal-host" />
        <span ref={ghostEl} className="terminal-ghost" aria-hidden="true" hidden />
        {thinking ? <div className="terminal-overlay-chip" role="status"><span className="terminal-spinner" aria-hidden="true" /> {t("terminal.thinking")}</div> : null}
        {connection === "connecting" || connection === "lost" ? (
          <div className="terminal-overlay-chip is-muted" role="status">{connection === "lost" ? t("terminal.disconnected") : t("terminal.connecting")}</div>
        ) : null}
      </div>

      {aiEnabled ? (
        <div className="terminal-statusbar">
          <label className="terminal-field">
            <span>{t("terminal.assistant")}</span>
            <select value={props.assistAgent} onChange={(e) => props.onAssistAgent(e.target.value)}>
              <option value="">{t("terminal.defaultAgent")}</option>
              {props.agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.model}</option>)}
            </select>
          </label>
          <label className="terminal-toggle" title={t("terminal.suggestionsHint")}>
            <input type="checkbox" checked={props.suggest} onChange={(e) => props.onSuggest(e.target.checked)} />
            <span>{t("terminal.suggestions")}</span>
          </label>
          <span className="terminal-tips muted">
            <span><kbd>#</kbd> {t("terminal.tipAsk")}</span>
            <span><kbd>→</kbd> {t("terminal.tipAccept")}</span>
          </span>
        </div>
      ) : null}

      <div className="terminal-keys" aria-label={t("terminal.keys")}>
        {([["Esc", "\u001b"], ["Tab", "\t"], ["Ctrl C", "\u0003"], ["↑", "\u001b[A"], ["↓", "\u001b[B"], ["←", "\u001b[D"], ["→", "\u001b[C"]] as const).map(([label, data]) => (
          <button key={label} type="button" className="btn btn-sm" disabled={exitCode !== null} onClick={() => key(data)}>{label}</button>
        ))}
      </div>
    </section>
  );
}
