import { useEffect, useRef, useState } from "react";
import { api, openEvents } from "./api";
import type { Health } from "./types";
import Conversations from "./screens/Conversations";
import Workspaces from "./screens/Workspaces";
import Agents from "./screens/Agents";
import Providers from "./screens/Providers";
import Cron from "./screens/Cron";
import Settings from "./screens/Settings";
import WorkspacePage from "./WorkspacePage";
import type { AgentPreset, Workspace } from "./types";
import { Icon, type IconName } from "./icons";
import { useToast } from "./ui";

const NAV = [
  { id: "conversations", icon: "chat", label: "Conversations" },
  { id: "workspaces", icon: "folder", label: "Workspaces" },
  { id: "agents", icon: "bot", label: "Agents" },
  { id: "providers", icon: "plug", label: "Providers" },
  { id: "cron", icon: "clock", label: "Cron" },
  { id: "settings", icon: "settings", label: "Settings" },
] as const satisfies ReadonlyArray<{ id: string; icon: IconName; label: string }>;

type ScreenId = (typeof NAV)[number]["id"];

export default function App() {
  const [screen, setScreen] = useState<ScreenId>("conversations");
  const [health, setHealth] = useState<Health | null>(null);
  const toast = useToast();
  const [openWorkspace, setOpenWorkspace] = useState<Workspace | null>(null);
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [pendingConv, setPendingConv] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const activeScreen = openWorkspace ? "workspaces" : screen;

  useEffect(() => {
    api.health().then(setHealth).catch(() => undefined);
    api.agents().then((r) => setAgents(r.agents)).catch(() => undefined);
    const close = openEvents("/api/events", (e) => {
      const ev = e as { type?: string; name?: string; status?: string; error?: string };
      if (ev.type === "cron_run_finished") {
        toast(`${ev.name} : run ${ev.status}${ev.error ? ` (${ev.error})` : ""}`, ev.status !== "ok");
      }
    });
    return close;
  }, [toast]);

  useEffect(() => {
    if (!navOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setNavOpen(false); };
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("keydown", close);
      menuButton.current?.focus();
    };
  }, [navOpen]);

  const go = (id: ScreenId) => {
    setScreen(id);
    setNavOpen(false);
  };

  const screenNode = (() => {
    switch (screen) {
      case "conversations":
        return <Conversations initialOpenId={pendingConv} onConsumeInitial={() => setPendingConv(null)} />;
      case "workspaces":
        return <Workspaces onOpenWorkspace={(w) => {
          setOpenWorkspace(w);
          api.agents().then((r) => setAgents(r.agents)).catch((error: unknown) => toast(`Impossible d’actualiser les agents : ${String(error)}`, true));
        }} />;
      case "agents":
        return <Agents />;
      case "providers":
        return <Providers />;
      case "cron":
        return <Cron />;
      case "settings":
        return <Settings />;
    }
  })();

  return (
    <div className={`app ${navOpen ? "nav-open" : ""}`}>
      <a className="skip-link" href="#main">Aller au contenu</a>
      <header className="topbar">
        <button ref={menuButton} type="button" className="icon-btn" aria-label={navOpen ? "Fermer le menu" : "Ouvrir le menu"} aria-expanded={navOpen} aria-controls="sidebar" onClick={() => setNavOpen((open) => !open)}>
          <Icon name="menu" />
        </button>
        <span className="brand-inline">Cogitator</span>
      </header>
      <div className="nav-scrim" onClick={() => setNavOpen(false)} />
      <aside id="sidebar" className="sidebar">
        <div className="brand"><img src="/favicon.png" alt="Cogitator" className="brand-logo" style={{ width: 26, height: 26, borderRadius: 6, flexShrink: 0, objectFit: "cover", boxShadow: "0 0 14px rgba(94,106,210,.35)" }} />Cogita<em>tor</em></div>
        <nav aria-label="Principal">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`nav-item ${activeScreen === n.id ? "active" : ""}`}
              aria-current={activeScreen === n.id ? "page" : undefined}
              onClick={() => { setOpenWorkspace(null); go(n.id); }}
            >
              <Icon name={n.icon} /> {n.label}
            </button>
          ))}
        </nav>
        <div className="foot">
          {health ? `v${health.version} · pi ${health.pi_version ?? "?"}` : "…"}
        </div>
      </aside>
      <main id="main" className="main" tabIndex={-1} inert={navOpen}>
        {openWorkspace ? (
          <WorkspacePage
            workspace={openWorkspace}
            agents={agents}
            onBack={() => setOpenWorkspace(null)}
            onOpenConversation={(id) => { setPendingConv(id); setOpenWorkspace(null); setScreen("conversations"); }}
          />
        ) : screenNode}
      </main>
    </div>
  );
}
