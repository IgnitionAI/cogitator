import type { ReactNode } from "react";

import { t, type TranslationKey } from "./i18n";
import { Icon, type IconName } from "./icons";

export const SETTINGS_SECTIONS = [
  { id: "updates", icon: "download", label: "settings.updates" },
  { id: "providers", icon: "key", label: "common.providers" },
  { id: "extensions", icon: "plug", label: "extensions.title" },
  { id: "browsers", icon: "monitor", label: "browser.title" },
  { id: "cron", icon: "clock", label: "common.cron" },
  { id: "settings", icon: "settings", label: "settings.general" },
] as const satisfies ReadonlyArray<{ id: string; icon: IconName; label: TranslationKey }>;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export function isSettingsSection(id: string): id is SettingsSection {
  return SETTINGS_SECTIONS.some((s) => s.id === id);
}

/** Réglages : un sous-menu à gauche, la section choisie à droite. */
export function SettingsHub(props: { section: SettingsSection; updateAvailable: boolean; onSection: (id: SettingsSection) => void; children: ReactNode }) {
  return <div className="settings-hub">
    <nav className="settings-nav" aria-label={t("settings.sections")}>
      <h1>{t("settings.title")}</h1>
      {SETTINGS_SECTIONS.map((s) => <button
        key={s.id}
        type="button"
        className={`settings-link${props.section === s.id ? " is-active" : ""}`}
        aria-current={props.section === s.id ? "page" : undefined}
        onClick={() => props.onSection(s.id)}
      >
        <Icon name={s.icon} size={15} />
        <span>{t(s.label)}</span>
        {s.id === "updates" && props.updateAvailable ? <span className="settings-dot" role="img" aria-label={t("settings.updateBadge")} /> : null}
      </button>)}
    </nav>
    <div className="settings-body">{props.children}</div>
  </div>;
}
