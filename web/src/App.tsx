import { MachineStatus } from "./MachineStatus";
import Browsers from "./BrowserPanel";
import TerminalScreen from "./TerminalPanel";
import Updates from "./screens/Updates";
import Vault from "./screens/Vault";
import Artifacts from "./screens/Artifacts";
import { isSettingsSection, SETTINGS_SECTIONS, SettingsHub } from "./SettingsHub";
import { markNewsSeen, newsUnseen, WhatsNew } from "./WhatsNew";
import Extensions from "./screens/Extensions";
import Hub, { type HubTarget } from "./Hub";
import { CommandPalette } from "./CommandPalette";
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
import type { AgentPreset, Conversation, Workspace } from "./types";
import { Icon, type IconName } from "./icons";
import { LanguagePicker, useToast } from "./ui";
import { localizeText, statusLabel, t, useLocale, type TranslationKey } from "./i18n";

// three.js is ~600kB: keep it out of the first paint, the static favicon holds the slot meanwhile.
const BrandLogo3D = lazy(() => import("./BrandLogo3D"));

/** Rail : l'essentiel. Le reste (conversations, groupes) reste accessible par ⌘K. */
const NAV = [
  { id: "home", icon: "chat", label: "hub.title" },
  { id: "workspaces", icon: "folder", label: "common.workspaces" },
  { id: "agents", icon: "bot", label: "common.agents" },
  { id: "artifacts", icon: "layers", label: "artifact.title" },
  { id: "terminal", icon: "terminal", label: "terminal.title" },
] as const satisfies ReadonlyArray<{ id: string; icon: IconName; label: TranslationKey }>;
const EXTRA = [
  { id: "conversations", icon: "feed", label: "common.conversations" },
  { id: "bots", icon: "users", label: "hub.groups" },
] as const satisfies ReadonlyArray<{ id: string; icon: IconName; label: TranslationKey }>;

const PALETTE_SHORTCUT = "⌘K";

type ScreenId = (typeof NAV)[number]["id"] | (typeof EXTRA)[number]["id"] | (typeof SETTINGS_SECTIONS)[number]["id"];

export default function App() {
  useLocale();
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [artifactTarget, setArtifactTarget] = useState<string | null>(null);
  const [showNews, setShowNews] = useState(false);
  const [newsSeen, setNewsSeen] = useState(() => !newsUnseen());
  const [screen, setScreen] = useState<ScreenId>("home");
  const [hubTarget, setHubTarget] = useState<HubTarget | null>(null);
  const [palette, setPalette] = useState(false);
  const [paletteConversations, setPaletteConversations] = useState<Conversation[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
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
    api.appUpdates().then((r) => setUpdateAvailable(r.status === "available")).catch(() => undefined);
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
  const openHub = (target: Omit<HubTarget, "nonce">) => {
    setOpenWorkspace(null);
    setHubTarget({ ...target, nonce: Date.now() });
    go("home");
  };

  // #artifact=<id> : les cartes d'artifact du chat ouvrent la galerie sur cet artifact.
  useEffect(() => {
    const onHash = () => {
      const match = /^#artifact=([0-9a-f-]{36})$/.exec(window.location.hash);
      if (!match) return;
      setArtifactTarget(match[1]!);
      setOpenWorkspace(null);
      setScreen("artifacts");
      history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // ⌘K / Ctrl+K : palette de commandes, depuis n'importe quel écran.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!palette) return;
    api.conversations().then((r) => setPaletteConversations(r.conversations.filter((c) => !c.group_id))).catch(() => undefined);
  }, [palette]);
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMoreOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  const screenNode = (() => {
    switch (screen) {
      case "home":
        return <Hub target={hubTarget} onNavigate={(id) => go(id)} />;
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
        return <Agents onOpenAgent={(id) => openHub({ agentId: id })} />;
      case "artifacts":
        return <Artifacts initialId={artifactTarget} onOpenThread={(id) => openHub({ conversationId: id })} />;
      case "terminal":
        return <TerminalScreen />;
      case "updates":
      case "providers":
      case "vault":
      case "browsers":
      case "extensions":
      case "cron":
      case "settings":
        return <SettingsHub section={screen} updateAvailable={updateAvailable} onSection={(id) => go(id)}>
          {screen === "updates" ? <Updates />
            : screen === "providers" ? <Providers />
            : screen === "vault" ? <Vault />
            : screen === "browsers" ? <Browsers />
            : screen === "extensions" ? <Extensions />
            : screen === "cron" ? <Cron />
            : <Settings />}
        </SettingsHub>;
    }
  })();
  const inSettings = !openWorkspace && isSettingsSection(screen);

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
          <button type="button" className="nav-item nav-search" title={`${t("hub.search")} (${PALETTE_SHORTCUT})`} onClick={() => { setNavOpen(false); setPalette(true); }}>
            <Icon name="spark" /> <span className="nav-label">{t("hub.search")}</span> <kbd className="nav-kbd">{PALETTE_SHORTCUT}</kbd>
          </button>
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              title={t(n.label)}
              className={`nav-item ${activeScreen === n.id ? "active" : ""}`}
              aria-current={activeScreen === n.id ? "page" : undefined}
              onClick={() => { setOpenWorkspace(null); go(n.id); }}
            >
              <Icon name={n.icon} /> <span className="nav-label">{t(n.label)}</span>
            </button>
          ))}
          <button
            type="button"
            title={t("settings.title")}
            className={`nav-item nav-settings ${inSettings ? "active" : ""}`}
            aria-current={inSettings ? "page" : undefined}
            onClick={() => { setOpenWorkspace(null); go(inSettings ? screen : updateAvailable ? "updates" : "settings"); }}
          >
            <Icon name="settings" /> <span className="nav-label">{t("settings.title")}</span>
            {updateAvailable ? <span className="news-dot rail-dot" role="img" aria-label={t("settings.updateBadge")} /> : null}
          </button>
        </nav>
        <button type="button" className="nav-item rail-more" title={t("hub.more")} aria-label={t("hub.more")} aria-expanded={moreOpen} aria-controls="sidebar-foot" onClick={() => setMoreOpen((open) => !open)}>
          <Icon name="menu" />{!newsSeen ? <span className="news-dot rail-dot" role="img" aria-label={t("news.unseen")} /> : null}
        </button>
        {moreOpen ? <div className="rail-scrim" onClick={() => setMoreOpen(false)} /> : null}
        <div id="sidebar-foot" className={`foot${moreOpen ? " is-open" : ""}`}>
          <MachineStatus />
          <LanguagePicker />
          <span className="running-version">{health ? `v${health.version} · pi ${health.pi_version ?? "?"}` : "…"}</span>
          <div className="footer-actions">
          <button type="button" className="btn btn-sm" onClick={() => { setNavOpen(false); setMoreOpen(false); setOpenWorkspace(null); go("updates"); }}>{t("updates.title")}</button>
          <button type="button" className="btn btn-sm" onClick={() => { setNavOpen(false); setMoreOpen(false); setShowNews(true); markNewsSeen(); setNewsSeen(true); }}>
            {t("news.title")}{!newsSeen ? <span className="news-dot" role="img" aria-label={t("news.unseen")} /> : null}
          </button>
          </div>
        </div>
      </aside>
      <main id="main" className="main" tabIndex={-1} inert={navOpen}>
        {openWorkspace ? (
          <WorkspacePage
            workspace={openWorkspace}
            agents={agents}
            onBack={() => setOpenWorkspace(null)}
            onOpenConversation={(id) => openHub({ conversationId: id })}
          />
        ) : screenNode}
      </main>
      {showNews && <WhatsNew onClose={() => setShowNews(false)} />}
      {palette ? <CommandPalette
        screens={[...NAV, ...EXTRA, ...SETTINGS_SECTIONS].map((n) => ({ id: n.id, label: t(n.label), icon: n.icon }))}
        agents={agents}
        conversations={paletteConversations}
        onScreen={(id) => { setOpenWorkspace(null); go(id as ScreenId); }}
        onAgent={(id) => openHub({ agentId: id })}
        onConversation={(id) => openHub({ conversationId: id })}
        onClose={() => setPalette(false)}
      /> : null}
    </div>
  );
}
