import { useEffect, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { ErrorText } from "./ui";
import type { GitHubConnectionState } from "./types";

export function GitHubConnection() {
  const [state, setState] = useState<GitHubConnectionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () => api.githubConnection().then(value => { if (live) { setState(value); setError(null); } }).catch((e: Error) => { if (live) setError(e.message); });
    void refresh(); const timer = setInterval(refresh, 2000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  async function start() {
    setBusy(true); setError(null);
    try { setState(await api.connectGithub()); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const pending = state?.status === "starting" || state?.status === "waiting";
  return <div className="github-connection">
    {state?.connected ? <p role="status">{t("github.connected", { login: state.login ?? "" })}</p> : <>
      <p>{t("github.privateHint")}</p>
      {pending ? <>
        {state.code ? <>
          <p>{t("github.enterCode")}</p>
          <strong className="github-device-code">{state.code}</strong>
          <a className="btn btn-primary" href="https://github.com/login/device" target="_blank" rel="noreferrer">{t("github.open")}</a>
          <p role="status" className="muted">{t("github.waiting")}</p>
        </> : <p role="status">{t("github.starting")}</p>}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={async () => { setBusy(true); try { await api.cancelGithub(); setState(null); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{t("screens.cancel")}</button>
      </> : <button type="button" className="btn" disabled={busy || state?.available === false} onClick={() => void start()}>{t(busy ? "github.starting" : "github.connect")}</button>}
      {state?.available === false && <p>{t("github.unavailable")}</p>}
      {state?.status === "error" && <ErrorText error={t(state.error === "github.expired" ? "github.expired" : "github.loginFailed")} />}
    </>}
    <ErrorText error={error} />
  </div>;
}
