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
import { localizeText, setLocale, statusLabel, t, useLocale, type TranslationKey } from "./i18n";

const NAV = [
  { id: "conversations", icon: "chat", label: "common.conversations" },
  { id: "workspaces", icon: "folder", label: "common.workspaces" },
  { id: "agents", icon: "bot", label: "common.agents" },
  { id: "providers", icon: "plug", label: "common.providers" },
  { id: "cron", icon: "clock", label: "common.cron" },
  { id: "settings", icon: "settings", label: "common.settings" },
] as const satisfies ReadonlyArray<{ id: string; icon: IconName; label: TranslationKey }>;

type ScreenId = (typeof NAV)[number]["id"];

export default function App() {
  const locale = useLocale();
  const [screen, setScreen] = useState<ScreenId>("conversations");
  const [health, setHealth] = useState<Health | null>(null);
  const toast = useToast();
  const [openWorkspace, setOpenWorkspace] = useState<Workspace | null>(null);
  const [agents, setAgents] = useState<AgentPreset[]>([]);
  const [pendingConv, setPendingConv] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const activeScreen = openWorkspace ? "workspaces" : screen;

  useEffect(() => {
    api.health().then(setHealth).catch(() => undefined);
    api.agents().then((r) => setAgents(r.agents)).catch(() => undefined);
    const close = openEvents("/api/events", (e) => {
      const ev = e as { type?: string; name?: string; status?: string; error?: string };
      if (ev.type === "cron_run_finished") {
        toast(t(ev.error ? "common.cronFinishedError" : "common.cronFinished", { name: ev.name ?? "", status: statusLabel(ev.status ?? ""), error: localizeText(ev.error ?? "") }), ev.status !== "ok");
      }
    });
    return close;
  }, [toast]);

  useEffect(() => {
    if (!navOpen) return;
    const desktop = window.matchMedia("(min-width: 769px)");
    const closeOnDesktop = () => { if (desktop.matches) setNavOpen(false); };
    const links = sidebar.current?.querySelectorAll<HTMLElement>("button, select");
    sidebar.current?.querySelector<HTMLButtonElement>("[aria-current=page]")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
      if (event.key !== "Tab" || !links?.length) return;
      const first = links[0];
      const last = links[links.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    desktop.addEventListener("change", closeOnDesktop);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      desktop.removeEventListener("change", closeOnDesktop);
      document.removeEventListener("keydown", onKeyDown);
      if (!desktop.matches) menuButton.current?.focus();
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
          api.agents().then((r) => setAgents(r.agents)).catch((error: unknown) => toast(t("common.refreshAgentsError", { error: localizeText(String(error)) }), true));
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
      <a className="skip-link" href="#main" inert={navOpen}>{t("common.skip")}</a>
      <header className="topbar" inert={navOpen}>
        <button ref={menuButton} type="button" className="icon-btn" aria-label={t(navOpen ? "common.closeMenu" : "common.openMenu")} aria-expanded={navOpen} aria-controls="sidebar" onClick={() => setNavOpen((open) => !open)}>
          <Icon name="menu" />
        </button>
        <span className="brand-inline">Cogitator</span>
      </header>
      <div className="nav-scrim" onClick={() => setNavOpen(false)} />
      <aside ref={sidebar} id="sidebar" className="sidebar" role={navOpen ? "dialog" : undefined} aria-modal={navOpen || undefined} aria-label={t("common.navigation")}>
        <div className="brand">
          <img src="/favicon.png" alt="" className="brand-logo" width={26} height={26} />
          <span>Cogita<em>tor</em></span>
          <button type="button" className="icon-btn nav-close" aria-label={t("common.closeMenu")} onClick={() => setNavOpen(false)}><Icon name="close" /></button>
        </div>
        <nav aria-label={t("common.main")}>
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`nav-item ${activeScreen === n.id ? "active" : ""}`}
              aria-current={activeScreen === n.id ? "page" : undefined}
              onClick={() => { setOpenWorkspace(null); go(n.id); }}
            >
              <Icon name={n.icon} /> {t(n.label)}
            </button>
          ))}
        </nav>
        <div className="foot">
          <label className="language-picker">
            <span>{t("common.language")}</span>
            <select value={locale} onChange={(event) => setLocale(event.target.value === "fr" ? "fr" : "en")}>
              <option value="fr" lang="fr">Français</option>
              <option value="en" lang="en">English</option>
            </select>
          </label>
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
