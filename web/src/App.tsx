import { useEffect, useState } from "react";
import { api, openEvents } from "./api";
import type { Health } from "./types";
import Conversations from "./screens/Conversations";
import Workspaces from "./screens/Workspaces";
import Agents from "./screens/Agents";
import Providers from "./screens/Providers";
import Cron from "./screens/Cron";
import Settings from "./screens/Settings";

const NAV = [
  { id: "conversations", icon: "💬", label: "Conversations" },
  { id: "workspaces", icon: "🗂", label: "Workspaces" },
  { id: "agents", icon: "🤖", label: "Agents" },
  { id: "providers", icon: "🔌", label: "Providers" },
  { id: "cron", icon: "⏰", label: "Cron" },
  { id: "settings", icon: "⚙️", label: "Settings" },
] as const;

export interface Toast {
  id: number;
  text: string;
  err?: boolean;
}

export function useToasts(): [Toast[], (text: string, err?: boolean) => void] {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = (text: string, err = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };
  return [toasts, push];
}

export default function App() {
  const [screen, setScreen] = useState<string>("conversations");
  const [health, setHealth] = useState<Health | null>(null);
  const [toasts, toast] = useToasts();

  useEffect(() => {
    api.health().then(setHealth).catch(() => undefined);
    const close = openEvents("/api/events", (e) => {
      const ev = e as { type?: string; name?: string; status?: string; error?: string };
      if (ev.type === "cron_run_finished") {
        toast(`${ev.name} : run ${ev.status}${ev.error ? ` — ${ev.error}` : ""}`, ev.status !== "ok");
      }
    });
    return close;
  }, []);

  const Screen = {
    conversations: Conversations,
    workspaces: Workspaces,
    agents: Agents,
    providers: Providers,
    cron: Cron,
    settings: Settings,
  }[screen] ?? Conversations;

  return (
    <>
      <aside className="sidebar">
        <div className="brand"><span className="mark" />Cogita<em>tor</em></div>
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${screen === n.id ? "active" : ""}`} onClick={() => setScreen(n.id)}>
            <span>{n.icon}</span> {n.label}
          </button>
        ))}
        <div className="foot">
          {health ? `v${health.version} · pi ${health.pi_version ?? "?"}` : "…"}
        </div>
      </aside>
      <main className="main">
        <Screen toast={toast} />
      </main>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.err ? "err" : ""}`}>{t.text}</div>
        ))}
      </div>
    </>
  );
}
