import { formatDate, t, type TranslationKey } from "./i18n";
import { Icon, type IconName } from "./icons";
import { Modal } from "./ui";

/** Version décrite par le dialogue. La changer fait réapparaître le point « non lu ». */
export const NEWS_VERSION = "0.9.0";
const NEWS_DATE = "2026-11-22T12:00:00Z";
const NEWS_SEEN_KEY = "cogitator.newsSeen";
const CHANGELOG_URL = "https://github.com/IgnitionAI/cogitator/blob/dev/CHANGELOG.md";
const FEATURE_DOC_URL = "https://github.com/IgnitionAI/cogitator/blob/dev/CHANGELOG.md";

const ITEMS: Array<{ icon: IconName; title: TranslationKey; text: TranslationKey }> = [
  { icon: "settings", title: "news.updateAll", text: "news.updateAllText" },
  { icon: "spark", title: "news.safeRestart", text: "news.safeRestartText" },
  { icon: "bot", title: "news.vps", text: "news.vpsText" },
];

/** Le propriétaire a-t-il déjà ouvert les notes de cette version ? (préférence locale, best-effort) */
export function newsUnseen(): boolean {
  try { return window.localStorage.getItem(NEWS_SEEN_KEY) !== NEWS_VERSION; } catch { return false; }
}

export function markNewsSeen(): void {
  try { window.localStorage.setItem(NEWS_SEEN_KEY, NEWS_VERSION); } catch { /* stockage indisponible */ }
}

export function WhatsNew({ onClose }: { onClose: () => void }) {
  return <Modal title={t("news.title")} onClose={onClose}>
    <header className="news-hero">
      <div className="news-meta">
        <span className="news-tag">{`v${NEWS_VERSION}`}</span>
        <span className="news-status"><Icon name="check" size={12} /> {t("news.pending")}</span>
        <time className="muted" dateTime={NEWS_DATE.slice(0, 10)}>{formatDate(NEWS_DATE, { dateStyle: "long" })}</time>
      </div>
      <p className="news-headline">{t("news.intro")}</p>
    </header>

    <article className="news-feature">
      <span className="news-feature-icon" aria-hidden="true"><Icon name="chat" size={18} /></span>
      <div>
        <span className="news-kicker">{t("news.featured")}</span>
        <h3>{t("news.updates")}</h3>
        <p>{t("news.updatesText")}</p>
        <a className="news-cta" href={FEATURE_DOC_URL} target="_blank" rel="noreferrer">{t("news.updatesCta")} <span aria-hidden="true">↗</span></a>
      </div>
    </article>

    <h3 className="news-section">{t("news.more")}</h3>
    <ul className="news-list">
      {ITEMS.map((item) => <li key={item.title}>
        <span className="news-icon" aria-hidden="true"><Icon name={item.icon} size={15} /></span>
        <div>
          <strong>{t(item.title)}</strong>
          <p>{t(item.text)}</p>
        </div>
      </li>)}
    </ul>

    <footer className="news-foot">
      <a href={CHANGELOG_URL} target="_blank" rel="noreferrer">{t("news.details")} <span aria-hidden="true">↗</span></a>
      <button type="button" className="btn btn-primary" onClick={onClose}>{t("news.done")}</button>
    </footer>
  </Modal>;
}
