import { createContext, useCallback, useEffect, useRef, useState } from "react";
import App from "./App";
import { closeAllEvents } from "./api";
import { AuthError, authMutation, authStatus, setAccessCheck, type AuthStatus } from "./auth-api";
import { AuthFailure } from "./AuthControls";
import AuthForms from "./AuthForms";
import { LanguagePicker, ToastProvider } from "./ui";
import { t, useLocale } from "./i18n";
import "./auth.css";

export const AuthSession = createContext<{ logout: () => Promise<void> } | null>(null);
const allowed = (status: AuthStatus | null) => status?.mode === "local" || (status?.mode === "protected" && status.state === "authenticated");

export default function AuthGate() {
  useLocale();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<AuthError | null>(null);
  const [logoutRequired, setLogoutRequired] = useState(false);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const checking = useRef<Promise<boolean> | null>(null);
  const signingOut = useRef(false);
  const logoutInFlight = useRef(false);

  const check = useCallback((): Promise<boolean> => {
    if (signingOut.current) return Promise.resolve(false);
    if (checking.current) return checking.current;
    const version = generation.current;
    const promise = (async () => {
      try {
        let next = await authStatus();
        if (version !== generation.current) return false;
        if (next.mode === "protected" && next.expiresAt && Date.parse(next.expiresAt) <= Date.now()) next = { mode: "protected", state: "reauthenticate" };
        setStatus(next);
        setError(null);
        if (!allowed(next)) closeAllEvents();
        return allowed(next);
      } catch (failure) {
        if (version !== generation.current) return false;
        setStatus(null);
        closeAllEvents();
        setError(failure instanceof AuthError ? failure : new AuthError("AUTH_UNAVAILABLE"));
        return false;
      } finally {
        if (version === generation.current) { checking.current = null; }
      }
    })();
    checking.current = promise;
    return promise;
  }, []);

  useEffect(() => {
    setAccessCheck(() => check());
    void check();
    const focus = () => { void check(); };
    window.addEventListener("focus", focus);
    return () => { generation.current++; checking.current = null; setAccessCheck(); closeAllEvents(); window.removeEventListener("focus", focus); };
  }, [check]);

  useEffect(() => {
    if (status?.mode !== "protected" || !status.expiresAt) return;
    const timer = setTimeout(() => {
      generation.current++;
      checking.current = null;
      setStatus(null);
      closeAllEvents();
      void check();
    }, Math.max(0, Math.min(Date.parse(status.expiresAt) - Date.now(), 2147483647)));
    return () => clearTimeout(timer);
  }, [status, check]);

  const logout = useCallback(async () => {
    if (logoutInFlight.current) return;
    logoutInFlight.current = true;
    signingOut.current = true;
    generation.current++;
    checking.current = null;
    setStatus(null);
    setError(null);
    setPending(true);
    setLogoutRequired(true);
    closeAllEvents();
    try {
      await authMutation("sign-out");
      signingOut.current = false;
      setLogoutRequired(false);
      await check();
    } catch (failure) {
      setError(failure instanceof AuthError ? failure : new AuthError("UNKNOWN"));
    } finally { logoutInFlight.current = false; setPending(false); }
  }, [check]);

  if (allowed(status) && !logoutRequired) return <AuthSession.Provider value={status?.mode === "protected" ? { logout } : null}><ToastProvider><App /></ToastProvider></AuthSession.Provider>;
  return <main className="auth-shell">
    <header className="auth-header"><strong>Cogitator</strong><LanguagePicker /></header>
    <div className="auth-panel">
      <AuthFailure error={error} />
      {logoutRequired ? <>
        <h1>{t("auth.logout")}</h1><p>{t("auth.logoutScope")}</p>
        {error ? <p>{t("auth.logoutFailed")}</p> : null}
        <button className="btn btn-primary" disabled={pending} onClick={() => void logout()}>{t(pending ? "auth.working" : "auth.logout")}</button>
      </> : status?.mode === "protected" ? <AuthForms status={status} refresh={() => check()} logout={logout} /> : error ?
        <button className="btn" disabled={pending} onClick={() => { setPending(true); void check().finally(() => setPending(false)); }}>{t(pending ? "auth.working" : "auth.retry")}</button> :
        <p role="status">{t("auth.checking")}</p>}
    </div>
  </main>;
}
