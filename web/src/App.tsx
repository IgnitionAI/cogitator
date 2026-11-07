import Browsers from "./BrowserPanel";
import { AppUpdates } from "./AppUpdates";
import { WhatsNew } from "./WhatsNew";
import Extensions from "./screens/Extensions";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, openEvents } from "./api";
import type { Health } from "./types";
import Bots from "./screens/Bots";
import Conversations from "./screens/Conversations";
import Workspaces from "./screens/Workspaces";
import Agents from "./screens/Agents";
import Providers from "./screens/Providers";
import Cron from "./screens/Cron";
import Settings from "./screens/Settings";
import WorkspacePage from "./WorkspacePage";
import type { AgentPreset, Workspace } from "./types";
import { Icon, type IconName } from "./icons";
import { LanguagePicker, useToast } from "./ui";
import { localizeText, statusLabel, t, useLocale, type TranslationKey } from "./i18n";

// three.js is ~600kB: keep it out of the first paint, the static favicon holds the slot meanwhile.
const BrandLogo3D = lazy(() => import("./BrandLogo3D"));

const NAV = [
  { id: "bots", icon: "bot", label: "common.bots" },
  { id: "conversations", icon: "chat", label: "common.conversations" },
  { id: "workspaces", icon: "folder", label: "common.workspaces" },
  { id: "agents", icon: "bot", label: "common.agents" },
  { id: "providers", icon: "plug", label: "common.providers" },
  { id: "browsers", icon: "monitor", label: "browser.title" },
  { id: "extensions", icon: "plug", label: "extensions.title" },
  { id: "cron", icon: "clock", label: "common.cron" },
  { id: "settings", icon: "settings", label: "common.settings" },
] as const satisfies ReadonlyArray<{ id: string; icon: IconName; label: TranslationKey }>;

type ScreenId = (typeof NAV)[number]["id"];

export default function App() {
  useLocale();
  const [showUpdates, setShowUpdates] = useState(false);
  const [showNews, setShowNews] = useState(false);
  const [screen, setScreen] = useState<ScreenId>("bots");
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
      if (ev.type === "agents_changed") {
        api.agents().then((r) => setAgents(r.agents)).catch(() => undefined);
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
      case "bots":
        return <Bots />;
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
      case "browsers":
        return <Browsers />;
      case "extensions":
        return <Extensions />;
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
          <Suspense fallback={<img src="/favicon.png" alt="" className="brand-logo" width={26} height={26} />}>
            <BrandLogo3D />
          </Suspense>
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
          <LanguagePicker />
          <span className="running-version">{health ? `v${health.version} · pi ${health.pi_version ?? "?"}` : "…"}</span>
          <div className="footer-actions">
          <button type="button" className="btn btn-sm" onClick={() => { setNavOpen(false); setShowUpdates(true); }}>{t("updates.title")}</button>
          <button type="button" className="btn btn-sm" onClick={() => { setNavOpen(false); setShowNews(true); }}>{t("news.title")}</button>
          </div>
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
      {showUpdates && <AppUpdates onClose={() => setShowUpdates(false)} />}
      {showNews && <WhatsNew onClose={() => setShowNews(false)} />}
    </div>
  );
}
