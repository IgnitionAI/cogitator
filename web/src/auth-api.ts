export type AuthStatus = { mode: "local" } | {
  mode: "protected";
  state: "anonymous" | "enrollment" | "reauthenticate" | "authenticated";
  email?: string;
  expiresAt?: string;
  enrollment?: { requiresSetupKey: boolean; pending: boolean; busyUntil?: string };
};

export class AuthError extends Error {
  constructor(public code: string, public retryAt?: string) { super(code); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

export function parseAuthStatus(value: unknown): AuthStatus {
  if (!record(value)) throw new AuthError("AUTH_UNAVAILABLE");
  if (value.mode === "local") return { mode: "local" };
  if (value.mode !== "protected" || typeof value.state !== "string" || !["anonymous", "enrollment", "reauthenticate", "authenticated"].includes(value.state)) throw new AuthError("AUTH_UNAVAILABLE");
  if (value.email !== undefined && typeof value.email !== "string") throw new AuthError("AUTH_UNAVAILABLE");
  if (value.expiresAt !== undefined && !date(value.expiresAt)) throw new AuthError("AUTH_UNAVAILABLE");
  if (value.state === "authenticated" && !date(value.expiresAt)) throw new AuthError("AUTH_UNAVAILABLE");
  if (value.enrollment !== undefined) {
    const item = value.enrollment;
    if (!record(item) || typeof item.requiresSetupKey !== "boolean" || typeof item.pending !== "boolean" || (item.busyUntil !== undefined && !date(item.busyUntil))) throw new AuthError("AUTH_UNAVAILABLE");
  }
  if (value.state === "enrollment" && (!value.enrollment || !date(value.expiresAt))) throw new AuthError("AUTH_UNAVAILABLE");
  return value as AuthStatus;
}

async function request(path: string, body?: object): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`/api/auth/${path}`, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new AuthError("OFFLINE"); }
  const data: unknown = await response.json().catch(() => null);
  if (!record(data)) throw new AuthError("AUTH_UNAVAILABLE");
  if (!response.ok) {
    if (path === "two-factor/generate-backup-codes" && (response.status === 401 || response.status === 403)) void recheckAccess();
    const retryAt = date(data.retryAt) ? data.retryAt : typeof data.retryAfter === "number" && Number.isFinite(data.retryAfter) && data.retryAfter >= 0 && data.retryAfter < 86400 ? new Date(Date.now() + data.retryAfter * 1000).toISOString() : undefined;
    throw new AuthError(typeof data.error === "string" ? data.error : "UNKNOWN", retryAt);
  }
  return data;
}

export const authStatus = async () => parseAuthStatus(await request("status"));
export async function signIn(email: string, password: string): Promise<boolean> {
  const data = await request("sign-in/email", { email, password });
  if (typeof data.twoFactorRequired !== "boolean") throw new AuthError("AUTH_UNAVAILABLE");
  return data.twoFactorRequired;
}
export async function authMutation(path: "sign-out" | "two-factor/verify-totp" | "two-factor/verify-backup-code", body: object = {}): Promise<void> {
  const data = await request(path, body);
  if (data.ok !== true) throw new AuthError("AUTH_UNAVAILABLE");
}
function codes(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data.backupCodes) || !data.backupCodes.length || !data.backupCodes.every((code): code is string => typeof code === "string" && code.length > 0)) throw new AuthError("AUTH_UNAVAILABLE");
  return data.backupCodes;
}
export async function enableFactor(password: string, setupKey?: string) {
  const data = await request("two-factor/enable", { password, ...(setupKey ? { setupKey } : {}) });
  if (typeof data.totpURI !== "string") throw new AuthError("AUTH_UNAVAILABLE");
  let uri: URL;
  try { uri = new URL(data.totpURI); } catch { throw new AuthError("AUTH_UNAVAILABLE"); }
  const secret = uri.searchParams.get("secret");
  if (uri.protocol !== "otpauth:" || uri.hostname !== "totp" || !secret || !/^[A-Z2-7]+=*$/i.test(secret)) throw new AuthError("AUTH_UNAVAILABLE");
  return { secret, backupCodes: codes(data) };
}
export async function regenerateCodes(password: string) {
  return codes(await request("two-factor/generate-backup-codes", { password }));
}

// Application failures ask the gate to revalidate; a business 403 is not a logout.
let checkAccess: (() => Promise<boolean>) | undefined;
export function setAccessCheck(check?: () => Promise<boolean>) { checkAccess = check; }
export function recheckAccess(): Promise<boolean> { return checkAccess?.() ?? Promise.resolve(false); }
