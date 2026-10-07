import { useEffect, useState } from "react";
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
  }, []);

  const go = (id: ScreenId) => {
    setScreen(id);
    setNavOpen(false);
  };

  const screenNode = (() => {
    switch (screen) {
      case "conversations":
        return <Conversations initialOpenId={pendingConv} onConsumeInitial={() => setPendingConv(null)} />;
      case "workspaces":
        return <Workspaces onOpenWorkspace={(w) => setOpenWorkspace(w)} />;
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
        <button type="button" className="icon-btn" aria-label="Ouvrir le menu" onClick={() => setNavOpen(true)}>
          <Icon name="menu" />
        </button>
        <span className="brand-inline">Cogitator</span>
      </header>
      <div className="nav-scrim" onClick={() => setNavOpen(false)} />
      <aside className="sidebar">
        <div className="brand"><span className="mark" />Cogita<em>tor</em></div>
        <nav aria-label="Principal">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`nav-item ${screen === n.id && !openWorkspace ? "active" : ""}`}
              aria-current={screen === n.id && !openWorkspace ? "page" : undefined}
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
      <main id="main" className="main">
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
