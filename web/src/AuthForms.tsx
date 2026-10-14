import { useEffect, useRef, useState } from "react";
import { authMutation, enableFactor, signIn, type AuthStatus } from "./auth-api";
import { AuthFailure, RecoveryCodes, useAuthAction } from "./AuthControls";
import { Field } from "./ui";
import { formatDate, t } from "./i18n";

type ProtectedStatus = Extract<AuthStatus, { mode: "protected" }>;
export default function AuthForms({ status, refresh, logout }: { status: ProtectedStatus; refresh: () => Promise<boolean>; logout: () => Promise<void> }) {
  const [challenge, setChallenge] = useState(false);
  const [backup, setBackup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [material, setMaterial] = useState<Awaited<ReturnType<typeof enableFactor>> | null>(null);
  const [replace, setReplace] = useState(false);
  const [verified, setVerified] = useState(false);
  const { pending, error, run } = useAuthAction();
  const heading = useRef<HTMLHeadingElement>(null);
  const enrollment = status.state === "enrollment";
  const [now, setNow] = useState(Date.now);
  const busyUntil = status.enrollment?.busyUntil;
  const enrollmentBusy = enrollment && Boolean(busyUntil && Date.parse(busyUntil) > now);
  useEffect(() => {
    if (!busyUntil) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Date.parse(busyUntil) - Date.now()));
    return () => clearTimeout(timer);
  }, [busyUntil]);
  const setupPending = status.enrollment?.pending || material !== null;
  const title = verified ? "auth.verified" : enrollment ? "auth.enroll" : challenge ? "auth.mfa" : status.state === "reauthenticate" ? "auth.reauth" : "auth.title";
  useEffect(() => { heading.current?.focus(); }, [title]);
  useEffect(() => {
    // Never carry enrollment material into a different authorization state.
    setMaterial(null); setPassword(""); setSetupKey(""); setCode("");
  }, [status.state]);
  useEffect(() => {
    if (status.enrollment?.requiresSetupKey || status.enrollment?.busyUntil) setMaterial(null);
  }, [status.enrollment?.requiresSetupKey, status.enrollment?.busyUntil]);
  const submitCode = () => run(async () => {
    if (enrollmentBusy) return;
    await authMutation(backup && !enrollment ? "two-factor/verify-backup-code" : "two-factor/verify-totp", { code });
    setCode("");
    if (enrollment) { setMaterial(null); setVerified(true); }
    else { setChallenge(false); await refresh(); }
  });

  return <>
    <h1 ref={heading} tabIndex={-1}>{t(title)}</h1>
    <AuthFailure error={error} />
    {status.state === "anonymous" && !challenge ? <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
      const needsFactor = await signIn(email, password);
      setPassword("");
      if (needsFactor) setChallenge(true);
      else await refresh();
    }); }}>
      <fieldset disabled={pending}>
        <Field label={t("auth.email")}><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t("auth.password")}><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <button className="btn btn-primary">{t(pending ? "auth.working" : "auth.signIn")}</button>
      </fieldset>
    </form> : null}

    {enrollment && !verified ? <>
      <p>{t("auth.enrollHint")}</p>
      {status.enrollment?.busyUntil ? <p role="status">{t("auth.busyUntil", { date: formatDate(status.enrollment.busyUntil) })}</p> : null}
      <p className="muted">{t("auth.keyHelp")}</p>
      {setupPending ? <p>{t("auth.pending")}</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
        if (enrollmentBusy) return;
        // A replacement can succeed even if its response is lost: never keep old material.
        setMaterial(null);
        try {
          const next = await enableFactor(password, status.enrollment?.requiresSetupKey ? setupKey : undefined);
          setMaterial(next); setPassword(""); setSetupKey(""); setReplace(false);
        } catch (failure) {
          await refresh(); // Discover pending setup before allowing a replacement retry.
          throw failure;
        }
        // Refresh selected-claim metadata; this does not promote the session.
        await refresh();
      }); }}>
        <fieldset disabled={pending || enrollmentBusy}>
          <Field label={t("auth.password")}><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {status.enrollment?.requiresSetupKey ? <Field label={t("auth.key")}><input type="password" autoComplete="off" required value={setupKey} onChange={(e) => setSetupKey(e.target.value)} /></Field> : null}
          {setupPending ? <label className="auth-check"><input type="checkbox" required checked={replace} onChange={(e) => setReplace(e.target.checked)} />{t("auth.invalidateSetup")}</label> : null}
          <button className="btn" disabled={Boolean(setupPending && !replace)}>{t(pending ? "auth.working" : setupPending ? "auth.regenerateSetup" : "auth.enable")}</button>
        </fieldset>
      </form>
      {material ? <section>
        <h2>{t("auth.secret")}</h2><p>{t("auth.secretHint")}</p>
        <p className="auth-secret mono">{material.secret}</p>
        {material.backupCodes.length ? <RecoveryCodes codes={material.backupCodes} dismiss={() => setMaterial({ ...material, backupCodes: [] })} /> : null}
      </section> : null}
    </> : null}

    {(challenge || (enrollment && setupPending)) && !verified ? <form onSubmit={(event) => { event.preventDefault(); void submitCode(); }}>
      <fieldset disabled={pending || enrollmentBusy}>
        <Field label={t(backup && !enrollment ? "auth.backup" : "auth.otp")}>
          <input type="text" inputMode={backup && !enrollment ? "text" : "numeric"} autoComplete="one-time-code" spellCheck={false} autoCapitalize="none" required value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <button className="btn btn-primary">{t(pending ? "auth.working" : "auth.verify")}</button>
        {!enrollment ? <button type="button" className="btn" onClick={() => { setBackup(!backup); setCode(""); }}>{t(backup ? "auth.useOtp" : "auth.useBackup")}</button> : null}
      </fieldset>
    </form> : null}
    {enrollment && !verified ? <p className="muted">{t("auth.lostVerification")}</p> : null}
    {status.state !== "anonymous" || challenge ? <div className="auth-session-actions">
      <p className="muted">{t("auth.logoutScope")}</p>
      <button type="button" className="btn" disabled={pending} onClick={() => void run(logout)}>{t("auth.logout")}</button>
      {!verified ? <button type="button" className="btn" disabled={pending} onClick={() => void run(async () => { await refresh(); })}>{t("auth.retry")}</button> : null}
    </div> : null}
    <p className="muted">{t("auth.recovery")}</p>
  </>;
}
