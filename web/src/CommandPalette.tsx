import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n";
import { Icon, type IconName } from "./icons";
import type { AgentPreset, Conversation } from "./types";

const ESC = "Esc";

export interface PaletteCommand { id: string; label: string; hint?: string; icon: IconName; group: string; run: () => void }

/** Palette ⌘K : naviguer, parler à un agent, rouvrir un fil, au clavier. */
export function CommandPalette(props: {
  screens: Array<{ id: string; label: string; icon: IconName }>;
  agents: AgentPreset[];
  conversations: Conversation[];
  onScreen: (id: string) => void;
  onAgent: (id: string) => void;
  onConversation: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    input.current?.focus();
    return () => { if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus(); };
  }, []);

  const commands = useMemo<PaletteCommand[]>(() => [
    ...props.agents.map((a) => ({ id: `agent:${a.id}`, label: t("palette.talkTo", { name: a.name }), hint: a.model, icon: "bot" as IconName, group: t("palette.agents"), run: () => props.onAgent(a.id) })),
    ...props.screens.map((s) => ({ id: `screen:${s.id}`, label: s.label, icon: s.icon, group: t("palette.goTo"), run: () => props.onScreen(s.id) })),
    ...props.conversations.slice(0, 40).map((c) => ({ id: `conv:${c.id}`, label: c.title || t("chat.untitled"), hint: c.model, icon: "chat" as IconName, group: t("palette.threads"), run: () => props.onConversation(c.id) })),
  ], [props]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? commands.filter((c) => `${c.label} ${c.hint ?? ""} ${c.group}`.toLowerCase().includes(q)) : commands;
    return list.slice(0, 30);
  }, [commands, query]);
  useEffect(() => { setActive(0); }, [query]);

  const runAt = (index: number) => {
    const command = visible[index];
    if (!command) return;
    props.onClose();
    command.run();
  };

  let lastGroup = "";
  return <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
    <div className="palette" role="dialog" aria-modal="true" aria-label={t("palette.title")}>
      <div className="palette-search">
        <Icon name="spark" size={16} />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={visible[active] ? `palette-${active}` : undefined}
          aria-label={t("palette.title")}
          placeholder={t("palette.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(visible.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); runAt(active); }
            else if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
          }}
        />
        <kbd>{ESC}</kbd>
      </div>
      <div id="palette-list" role="listbox" className="palette-list">
        {visible.length === 0 ? <p className="palette-empty">{t("palette.empty")}</p> : null}
        {visible.map((c, i) => {
          const header = c.group !== lastGroup ? <p className="palette-group" role="presentation">{c.group}</p> : null;
          lastGroup = c.group;
          return <div key={c.id}>
            {header}
            <div id={`palette-${i}`} role="option" aria-selected={i === active} className={`palette-item${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)} onClick={() => runAt(i)}>
              <Icon name={c.icon} size={15} />
              <span className="palette-label">{c.label}</span>
              {c.hint ? <span className="palette-hint mono">{c.hint}</span> : null}
            </div>
          </div>;
        })}
      </div>
      <div className="palette-foot"><span>↑↓ {t("palette.navigate")}</span><span>↵ {t("palette.choose")}</span><span>{ESC} {t("palette.close")}</span></div>
    </div>
  </div>;
}
