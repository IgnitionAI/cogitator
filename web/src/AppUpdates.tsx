import { useEffect, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { Modal } from "./ui";

const PI_UPDATE_COMMAND = "pi update --extensions";

export function AppUpdates({ onClose }: { onClose: () => void }) {
  const [release, setRelease] = useState<Awaited<ReturnType<typeof api.appUpdates>> | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setRelease(null); setFailed(false);
    api.appUpdates().then(value => { if (live) setRelease(value); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [attempt]);
  return <Modal title={t("updates.title")} onClose={onClose}>
    {!release && !failed && <p role="status">{t("extensions.checking")}</p>}
    {failed && <><p role="alert">{t("updates.failed")}</p><button className="btn" onClick={() => setAttempt(a => a + 1)}>{t("screens.retry")}</button></>}
    {release && <>
      <p>{t("updates.versions", { current: release.current, latest: release.latest })}</p>
      <p role="status">{t(`updates.${release.status}`)}</p>
    </>}
    <h3>{t("updates.piTitle")}</h3>
    <p>{t("updates.piHint")}</p>
    <pre><code>{PI_UPDATE_COMMAND}</code></pre>
    <p>{t("updates.restartPi")}</p>
    <h3>{t("updates.vpsTitle")}</h3>
    <p>{t("updates.vpsHint")}</p>
    <p className="muted">{t("updates.boundary")}</p>
    <a href="https://github.com/IgnitionAI/cogitator/blob/dev/docs/vps.md#updating-and-rollback" target="_blank" rel="noreferrer">{t("updates.guide")} ↗</a>
  </Modal>;
}
