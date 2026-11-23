import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { localizeText, t, type TranslationKey } from "../i18n";
import { Icon } from "../icons";
import { PageHead } from "../ui";
import type { PackageOperation, PackageUpdate } from "../types";

const PI_UPDATE_COMMAND = "pi update --extensions";
const SELF = "@ignitionai/cogitator";
const RESTART_TIMEOUT_MS = 120_000;
const NOTES_URL = "https://github.com/IgnitionAI/cogitator/blob/dev/CHANGELOG.md";
const GUIDE_URL = "https://github.com/IgnitionAI/cogitator/blob/dev/docs/updater.md";

type Release = Awaited<ReturnType<typeof api.appUpdates>>;
type Phase =
  | { kind: "idle" }
  | { kind: "confirm-busy" }
  | { kind: "installing"; target: string; step?: string }
  | { kind: "restarting"; target: string; step?: string }
  | { kind: "ready"; target: string }
  | { kind: "error"; message: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Étapes du service de mise à jour, dans l'ordre (« rolling-back » est un détour, pas une étape). */
const STEPS = ["requested", "downloading", "installing", "switching", "verifying"] as const;
const legacyStepKey = (step?: string) => step && [...STEPS, "rolling-back"].includes(step as never) ? `updates.step.${step}` as TranslationKey : null;

/** Mises à jour de Cogitator et des extensions, en page (Réglages › Mises à jour). */
export default function Updates() {
  const [release, setRelease] = useState<Release | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    let live = true;
    setFailed(false);
    api.appUpdates().then((value) => {
      if (!live) return;
      setRelease(value);
      // Mise à jour déjà en cours (page rouverte) : reprendre le suivi.
      const s = value.selfUpdate?.state;
      if (s && (s.status === "installing" || s.status === "restarting") && s.target) void follow(s.target);
    }).catch(() => { if (live) setFailed(true); }).finally(() => { if (live) setChecking(false); });
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
        if (!restarting) { restarting = true; setPhase({ kind: "restarting", target, step: "switching" }); }
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
  const recheck = () => { setChecking(true); setAttempt((a) => a + 1); };

  return <div className="settings-page">
    <PageHead title={t("settings.updates")} sub={t("upd.sub")} />

    {!release && !failed ? <p role="status" className="muted">{t("extensions.checking")}</p> : null}
    {failed && !release ? <section className="upd-hero">
      <div className="upd-hero-body"><p role="alert">{t("updates.failed")}</p>
        <div className="upd-actions"><button type="button" className="btn" onClick={recheck}>{t("screens.retry")}</button></div></div>
    </section> : null}

    {release && working ? <UpdateProgress phase={phase} mode={self?.mode} /> : null}

    {release && !working && phase.kind === "error" ? <section className="upd-hero is-error" role="alert">
      <span className="upd-hero-icon" aria-hidden="true"><Icon name="warning" size={20} /></span>
      <div className="upd-hero-body">
        <h2>{t("upd.errorTitle")}</h2>
        <p>{t("updates.applyFailed", { error: localizeText(phase.message) })}</p>
        <div className="upd-actions"><button type="button" className="btn" onClick={() => setPhase({ kind: "idle" })}>{t("upd.retry")}</button></div>
      </div>
    </section> : null}

    {release && !working && phase.kind !== "error" ? (release.status === "available" ? <section className="upd-hero is-available">
      <img className="upd-hero-logo" src="/icon.png" alt="" width={88} height={88} />
      <div className="upd-hero-body">
        <p className="upd-kicker">{t("upd.kicker")}</p>
        <h2>{t("upd.availableTitle", { version: release.latest })}</h2>
        <p className="muted">{t("upd.installed", { version: release.current })}</p>

        {self?.supported ? <>
          {phase.kind === "confirm-busy" ? <div className="updates-warning" role="alert">
            <p><Icon name="warning" size={14} /> {t("updates.busy")}</p>
            <div className="upd-actions">
              <button type="button" className="btn" onClick={() => setPhase({ kind: "idle" })}>{t("updates.wait")}</button>
              <button type="button" className="btn btn-primary" onClick={() => void apply(true)}>{t("updates.force")}</button>
            </div>
          </div> : <>
            <div className="upd-actions">
              <button type="button" className="btn btn-primary" onClick={() => void apply(false)}><Icon name="download" size={14} /> {t("updates.apply", { version: release.latest })}</button>
              <a className="btn btn-ghost" href={NOTES_URL} target="_blank" rel="noreferrer">{t("upd.notes")} <span aria-hidden="true">↗</span></a>
            </div>
            <p className="muted upd-hint">{t(self.mode === "updater" ? "updates.applyHintUpdater" : "updates.applyHint")}</p>
            {self.mode !== "updater" ? <><p className="muted upd-hint">{t("updates.manualPi")}</p><CopyCode code={PI_UPDATE_COMMAND} /></> : null}
          </>}
        </> : self?.setup ? <UpdaterSetup command={self.setup} checking={checking} checked={attempt > 0 && !checking} onCheck={recheck} />
          : <>
            <p className="muted upd-hint">{t(`updates.reason.${self?.reason ?? "NOT_PI_MANAGED"}` as TranslationKey)}</p>
            <div className="upd-actions">
              <a className="btn" href={GUIDE_URL} target="_blank" rel="noreferrer">{t("upd.guide")} <span aria-hidden="true">↗</span></a>
              <a className="btn btn-ghost" href={NOTES_URL} target="_blank" rel="noreferrer">{t("upd.notes")} <span aria-hidden="true">↗</span></a>
            </div>
          </>}
      </div>
    </section> : <section className="upd-hero">
      <span className="upd-hero-icon is-ok" aria-hidden="true"><Icon name="check" size={20} /></span>
      <div className="upd-hero-body">
        <h2>{release.status === "current" ? t("upd.currentTitle") : t("upd.otherTitle", { version: release.current })}</h2>
        <p className="muted" role="status">{release.status === "current" ? t("upd.currentText", { version: release.current }) : t(`updates.${release.status}` as TranslationKey)}</p>
        <div className="upd-actions">
          <button type="button" className="btn" disabled={checking} onClick={recheck}>{t("upd.check")}</button>
          <a className="btn btn-ghost" href={NOTES_URL} target="_blank" rel="noreferrer">{t("upd.notesLabel")} <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </section>) : null}

    <ExtensionUpdates disabled={working} />
  </div>;
}

function UpdateProgress({ phase, mode }: { phase: Phase; mode?: "pi" | "updater" }) {
  if (phase.kind === "ready") return <section className="upd-hero is-ok" role="status">
    <span className="upd-hero-icon is-ok" aria-hidden="true"><Icon name="check" size={20} /></span>
    <div className="upd-hero-body"><h2>{t("upd.readyTitle", { version: phase.target })}</h2><p className="muted">{t("upd.readyText")}</p></div>
  </section>;
  if (phase.kind !== "installing" && phase.kind !== "restarting") return null;
  const legacy = legacyStepKey(phase.step);
  const index = Math.max(0, STEPS.indexOf((phase.step ?? (phase.kind === "restarting" ? "switching" : "requested")) as typeof STEPS[number]));
  const rollingBack = phase.step === "rolling-back";
  return <section className="upd-hero is-running" aria-live="polite">
    <div className="upd-hero-body">
      <h2>{t("upd.runningTitle", { version: phase.target })}</h2>
      {mode === "updater" ? <>
        <div className="upd-bar" aria-hidden="true"><span style={{ width: `${Math.round(((index + 0.5) / STEPS.length) * 100)}%` }} /></div>
        <ol className="upd-steps">
          {STEPS.map((step, i) => {
            const state = i < index ? "done" : i === index ? "active" : "next";
            return <li key={step} className={`is-${state}`}>
              <span className="upd-step-state">{t(`upd.stepState.${state}` as TranslationKey)}</span>
              <span>{t(`upd.step.${step}` as TranslationKey)}</span>
            </li>;
          })}
        </ol>
        {rollingBack && legacy ? <p className="updates-warning" role="alert">{t(legacy)}</p> : null}
      </> : <div className="updates-progress" role="status"><span className="updates-spinner" aria-hidden="true" />
        {phase.kind === "installing" ? t("updates.installing", { version: phase.target }) : t("updates.restarting")}</div>}
      <p className="muted upd-hint">{t(mode === "updater" ? "upd.runningHint" : "upd.runningHintPi")}</p>
    </div>
  </section>;
}

function UpdaterSetup({ command, checking, checked, onCheck }: { command: string; checking: boolean; checked: boolean; onCheck: () => void }) {
  return <div className="upd-setup">
    <h3>{t("upd.setupTitle")}</h3>
    <p className="muted">{t("upd.setupText")}</p>
    <ol>
      <li><span className="upd-num" aria-hidden="true">1</span><div><p>{t("upd.setupStep1")}</p><CopyCode code={command} /></div></li>
      <li><span className="upd-num" aria-hidden="true">2</span><div><p>{t("upd.setupStep2")}</p>
        <button type="button" className="btn btn-primary" disabled={checking} onClick={onCheck}>{t("upd.check")}</button>
        {checked ? <p className="muted upd-hint" role="status">{t("upd.notFound")}</p> : null}
      </div></li>
    </ol>
  </div>;
}

export function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => undefined);
  };
  return <div className="copy-code">
    <code>{code}</code>
    <button type="button" className="btn btn-sm" onClick={copy}>{copied ? t("upd.copied") : t("upd.copy")}</button>
  </div>;
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
  return <section className="upd-section">
    <div className="upd-section-head">
      <h2>{t("updates.extensions")}</h2>
      {available.length > 0 && !running ? (
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => void updateAll()}><Icon name="download" size={14} /> {t("updates.updateAll", { count: available.length })}</button>
      ) : null}
    </div>
    {!updates && !error ? <p role="status" className="muted">{t("updates.extensionsChecking")}</p> : null}
    {updates && available.length === 0 && !operation ? <p role="status" className="muted">{t("updates.extensionsCurrent")}</p> : null}
    {available.length > 0 ? (
      <ul className="upd-list">
        {available.map((u) => <li key={u.name}><span className="mono">{u.name}</span><span className="muted mono">{u.version} → {u.latest}</span></li>)}
      </ul>
    ) : null}
    {running ? <div className="updates-progress" role="status"><span className="updates-spinner" aria-hidden="true" /> {t("updates.updatingAll")}</div> : null}
    {operation?.status === "done" && operation.updated?.length ? <p role="status" className="updates-success"><Icon name="check" size={14} /> {t("updates.updatedAll", { count: operation.updated.length })}</p> : null}
    {operation && !running ? operation.failed?.map((f) => <p key={f.name} className="error-text">{t("updates.updateFailedFor", { name: f.name, error: localizeText(f.error) })}</p>) : null}
    {error ? <p className="error-text" role="alert">{localizeText(error)}</p> : null}
  </section>;
}
