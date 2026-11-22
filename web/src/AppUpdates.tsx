import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { localizeText, t, type TranslationKey } from "./i18n";
import { Icon } from "./icons";
import { Modal } from "./ui";
import type { PackageOperation, PackageUpdate } from "./types";

const PI_UPDATE_COMMAND = "pi update --extensions";
const SELF = "@ignitionai/cogitator";
const RESTART_TIMEOUT_MS = 120_000;

type Release = Awaited<ReturnType<typeof api.appUpdates>>;
type Phase =
  | { kind: "idle" }
  | { kind: "confirm-busy" }
  | { kind: "installing"; target: string; step?: string }
  | { kind: "restarting"; target: string; step?: string }
  | { kind: "ready"; target: string }
  | { kind: "error"; message: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEPS = ["requested", "downloading", "installing", "switching", "verifying", "rolling-back"];
const stepKey = (step?: string) => step && STEPS.includes(step) ? `updates.step.${step}` as TranslationKey : null;

export function AppUpdates({ onClose }: { onClose: () => void }) {
  const [release, setRelease] = useState<Release | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    let live = true;
    setRelease(null); setFailed(false);
    api.appUpdates().then((value) => {
      if (!live) return;
      setRelease(value);
      // Mise à jour déjà en cours (dialogue rouvert) : reprendre le suivi.
      const s = value.selfUpdate?.state;
      if (s && (s.status === "installing" || s.status === "restarting") && s.target) void follow(s.target);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  /** Suit l'installation puis attend que le serveur revienne avec la nouvelle version. */
  const follow = async (target: string) => {
    setPhase({ kind: "installing", target });
    const deadline = Date.now() + RESTART_TIMEOUT_MS + 180_000;
    let restarting = false;
    while (alive.current && Date.now() < deadline) {
      await sleep(1500);
      try {
        const state = await api.appUpdateState(AbortSignal.timeout(4000));
        if (state.version === target && state.state.status === "idle") {
          setPhase({ kind: "ready", target });
          await sleep(1200);
          window.location.reload();
          return;
        }
        if (state.state.status === "error") { setPhase({ kind: "error", message: state.state.error ?? "" }); return; }
        if (state.state.status === "restarting") { restarting = true; setPhase({ kind: "restarting", target, step: state.state.step }); }
        else if (state.state.status === "installing") setPhase({ kind: "installing", target, step: state.state.step });
      } catch {
        // Serveur en cours de redémarrage : injoignable quelques secondes.
        if (!restarting) { restarting = true; setPhase({ kind: "restarting", target }); }
      }
    }
    if (alive.current) setPhase({ kind: "error", message: t("updates.noRestart") });
  };

  const apply = async (force: boolean) => {
    setPhase({ kind: "idle" });
    try {
      const state = await api.applyAppUpdate(force);
      if (state.target) void follow(state.target);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith("SELF_UPDATE_BUSY")) setPhase({ kind: "confirm-busy" });
      else setPhase({ kind: "error", message });
    }
  };

  const self = release?.selfUpdate;
  const working = phase.kind === "installing" || phase.kind === "restarting" || phase.kind === "ready";

  return <Modal title={t("updates.title")} onClose={onClose}>
    <section className="updates-card">
      <div className="updates-card-head">
        <Icon name="download" size={16} />
        <h3>{t("updates.cogitator")}</h3>
        {release ? <span className={`updates-pill is-${release.status}`}>{release.status === "available" ? `${release.current} → ${release.latest}` : release.current}</span> : null}
      </div>
      {!release && !failed && <p role="status" className="muted">{t("extensions.checking")}</p>}
      {failed && <><p role="alert">{t("updates.failed")}</p><button type="button" className="btn btn-sm" onClick={() => setAttempt((a) => a + 1)}>{t("screens.retry")}</button></>}
      {release && <p role="status">{t(`updates.${release.status}` as TranslationKey)}</p>}

      {release?.status === "available" && self?.supported ? <>
        {phase.kind === "idle" || phase.kind === "error" ? <>
          <p className="muted">{t(self.mode === "updater" ? "updates.applyHintUpdater" : "updates.applyHint")}</p>
          <button type="button" className="btn btn-primary" onClick={() => void apply(false)}><Icon name="download" size={14} /> {t("updates.apply", { version: release.latest })}</button>
        </> : null}
        {phase.kind === "confirm-busy" ? (
          <div className="updates-warning" role="alert">
            <p><Icon name="warning" size={14} /> {t("updates.busy")}</p>
            <div className="updates-actions">
              <button type="button" className="btn btn-sm" onClick={() => setPhase({ kind: "idle" })}>{t("updates.wait")}</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => void apply(true)}>{t("updates.force")}</button>
            </div>
          </div>
        ) : null}
        {working ? (
          <div className="updates-progress" role="status">
            <span className="updates-spinner" aria-hidden="true" />
            {phase.kind === "installing" ? (stepKey(phase.step) ? t(stepKey(phase.step)!) : t("updates.installing", { version: phase.target }))
              : phase.kind === "restarting" ? (stepKey(phase.step) ? t(stepKey(phase.step)!) : t("updates.restarting"))
              : t("updates.ready", { version: phase.target })}
          </div>
        ) : null}
        {phase.kind === "error" ? <p className="error-text" role="alert">{t("updates.applyFailed", { error: localizeText(phase.message) })}</p> : null}
      </> : null}

      {release?.status === "available" && self && !self.supported ? <>
        <p className="muted">{t(`updates.reason.${self.reason ?? "NOT_PI_MANAGED"}` as TranslationKey)}</p>
        {self.reason === "NOT_PI_MANAGED" || self.reason === "SERVICE_MANAGED" ? (
          <a href="https://github.com/IgnitionAI/cogitator/blob/dev/docs/vps.md#updating-and-rollback" target="_blank" rel="noreferrer">{t("updates.guide")} ↗</a>
        ) : null}
      </> : null}
      {release?.status === "available" && self?.supported && self.mode !== "updater" && phase.kind === "idle" ? <>
        <p className="muted updates-manual">{t("updates.manualPi")}</p>
        <pre><code>{PI_UPDATE_COMMAND}</code></pre>
      </> : null}
    </section>

    <ExtensionUpdates disabled={working} />
  </Modal>;
}

function ExtensionUpdates({ disabled }: { disabled: boolean }) {
  const [updates, setUpdates] = useState<PackageUpdate[] | null>(null);
  const [operation, setOperation] = useState<PackageOperation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.packageUpdates().then((r) => setUpdates(r.updates.filter((u) => u.name !== SELF))).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);

  const updateAll = async () => {
    setError(null);
    try {
      let op = await api.updateAllPackages();
      setOperation(op);
      while (op.status === "running") {
        await sleep(1200);
        op = (await api.packages()).operation ?? op;
        setOperation(op);
      }
      void load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const available = updates?.filter((u) => u.available) ?? [];
  const running = operation?.status === "running";
  return <section className="updates-card">
    <div className="updates-card-head">
      <Icon name="plug" size={16} />
      <h3>{t("updates.extensions")}</h3>
      {available.length ? <span className="updates-pill is-available">{available.length}</span> : null}
    </div>
    {!updates && !error ? <p role="status" className="muted">{t("updates.extensionsChecking")}</p> : null}
    {updates && available.length === 0 && !operation ? <p role="status">{t("updates.extensionsCurrent")}</p> : null}
    {available.length > 0 ? (
      <ul className="updates-list">
        {available.map((u) => <li key={u.name}><span className="mono">{u.name}</span><span className="muted mono">{u.version} → {u.latest}</span></li>)}
      </ul>
    ) : null}
    {available.length > 0 && !running ? (
      <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => void updateAll()}><Icon name="download" size={14} /> {t("updates.updateAll", { count: available.length })}</button>
    ) : null}
    {running ? <div className="updates-progress" role="status"><span className="updates-spinner" aria-hidden="true" /> {t("updates.updatingAll")}</div> : null}
    {operation?.status === "done" && operation.updated?.length ? <p role="status" className="updates-success"><Icon name="check" size={14} /> {t("updates.updatedAll", { count: operation.updated.length })}</p> : null}
    {operation && !running ? operation.failed?.map((f) => <p key={f.name} className="error-text">{t("updates.updateFailedFor", { name: f.name, error: localizeText(f.error) })}</p>) : null}
    {error ? <p className="error-text" role="alert">{localizeText(error)}</p> : null}
  </section>;
}
