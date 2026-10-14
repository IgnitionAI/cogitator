import { useContext, useState } from "react";
import { AuthSession } from "./AuthGate";
import { regenerateCodes } from "./auth-api";
import { AuthFailure, RecoveryCodes, useAuthAction } from "./AuthControls";
import { Field } from "./ui";
import { t } from "./i18n";

export default function AuthSecurity() {
  const session = useContext(AuthSession);
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const { pending, error, run } = useAuthAction();
  if (!session) return null;
  return <section className="auth-security" aria-labelledby="owner-security">
    <h2 id="owner-security">{t("auth.security")}</h2>
    <p>{t("auth.logoutScope")}</p>
    <button type="button" className="btn" disabled={pending} onClick={() => void run(session.logout)}>{t("auth.logout")}</button>
    <h3>{t("auth.replaceCodes")}</h3>
    <AuthFailure error={error} />
    <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
      setCodes([]);
      const next = await regenerateCodes(password);
      setCodes(next); setPassword(""); setConfirmed(false);
    }); }}>
      <fieldset disabled={pending}>
        <Field label={t("auth.password")}><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <label className="auth-check"><input type="checkbox" required checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />{t("auth.invalidateCodes")}</label>
        <button className="btn" disabled={!confirmed}>{t(pending ? "auth.working" : "auth.replaceCodes")}</button>
      </fieldset>
    </form>
    {codes.length ? <RecoveryCodes codes={codes} dismiss={() => setCodes([])} /> : null}
  </section>;
}
