import { t } from "./i18n";
import { Modal } from "./ui";

export function WhatsNew({ onClose }: { onClose: () => void }) {
  return <Modal title={t("news.title")} onClose={onClose}>
    <div className="news-version"><strong>{t("news.version")}</strong><span className="muted">{t("news.pending")}</span></div>
    <p>{t("news.intro")}</p>
    <div className="news-list">
      <article><h3>{t("news.extensions")}</h3><p>{t("news.extensionsText")}</p></article>
      <article><h3>{t("news.subagents")}</h3><p>{t("news.subagentsText")}</p></article>
      <article><h3>{t("news.github")}</h3><p>{t("news.githubText")}</p></article>
      <article><h3>{t("news.setup")}</h3><p>{t("news.setupText")}</p></article>
      <article><h3>{t("news.reliability")}</h3><p>{t("news.reliabilityText")}</p></article>
    </div>
    <a href="https://github.com/IgnitionAI/cogitator/blob/dev/CHANGELOG.md" target="_blank" rel="noreferrer">{t("news.details")} ↗</a>
  </Modal>;
}
