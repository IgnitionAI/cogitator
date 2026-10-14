import { useEffect, useRef, useState } from "react";
import { AuthError } from "./auth-api";
import { formatDate, t, useLocale } from "./i18n";
import { authMessages } from "./locales/auth";

export function useAuthAction() {
  const lock = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try { await action(); }
    catch (failure) { if (mounted.current) setError(failure instanceof AuthError ? failure : new AuthError("UNKNOWN")); }
    finally { lock.current = false; if (mounted.current) setPending(false); }
  };
  return { pending, error, run };
}

export function AuthFailure({ error }: { error: AuthError | null }) {
  useLocale();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) ref.current?.focus(); }, [error]);
  if (!error) return null;
  const key = `auth.error.${error.code}`;
  const message = Object.hasOwn(authMessages, key) ? t(key as keyof typeof authMessages) : t("auth.error.UNKNOWN");
  return <div className="error-text" role="alert" tabIndex={-1} ref={ref}>
    {message} {error.retryAt ? t("auth.retryAt", { date: formatDate(error.retryAt) }) : null}
  </div>;
}

export function RecoveryCodes({ codes, dismiss }: { codes: string[]; dismiss: () => void }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, [codes]);
  return <section aria-label={t("auth.codes")}>
    <h3 ref={ref} tabIndex={-1}>{t("auth.codes")}</h3>
    <p>{t("auth.saveCodes")}</p>
    <ul className="auth-codes mono">{codes.map((code, index) => <li key={index}>{code}</li>)}</ul>
    <button type="button" className="btn" onClick={dismiss}>{t("auth.dismiss")}</button>
  </section>;
}
