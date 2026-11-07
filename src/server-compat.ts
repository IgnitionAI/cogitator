import { readServerIdentity, type ServerIdentity } from "./server-identity.js";

/** Message d'échec inchangé : l'utilisateur doit inspecter/arrêter lui-même l'instance en cause. */
export const UNAVAILABLE_MESSAGE =
  "Cogitator unavailable: check the server/auth state and stop incompatible previous instances.";

const PROBE_TIMEOUT_MS = 1_000;
const STARTUP_ATTEMPTS = 50;
const STARTUP_POLL_MS = 100;
/** Borne d'attente d'un SIGTERM accepté : au-delà on ne remonte pas en SIGKILL (jamais d'escalade). */
const STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_MS = 200;

/**
 * - `down` : rien n'écoute (fetch en échec) → démarrage normal ;
 * - `cogitator` : serveur Cogitator identifié, `version` lisible si non `null` ;
 * - `foreign` : la porte répond, mais ce n'est pas un serveur Cogitator → ni kill ni comparaison.
 */
export type HealthProbe =
  | { kind: "down" }
  | { kind: "cogitator"; version: string | null }
  | { kind: "foreign" };

export type UnavailableReason = "foreign-service" | "incoherent-pidfile" | "stop-timeout" | "start-timeout";

export type CompatOutcome =
  | { action: "connected"; version: string | null }
  | { action: "started"; version: string | null }
  | { action: "restarted"; version: string | null; stoppedPid: number }
  | { action: "unavailable"; reason: UnavailableReason };

/** Entrées injectables : aucun process ni socket réel n'est touché par la logique elle-même. */
export interface CompatDeps {
  /** Version du paquet installé (celle que `pi update --extensions` vient de poser). */
  installedVersion: string;
  /** URL sondée (BASE_URL) : sert aussi à valider le `port` du pidfile. */
  baseUrl: string;
  probeServer: (baseUrl: string) => Promise<HealthProbe>;
  readIdentity: () => ServerIdentity | null;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  spawnServer: () => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  startupAttempts?: number;
  startupPollMs?: number;
  stopTimeoutMs?: number;
  stopPollMs?: number;
}

type HttpJson = { kind: "down" } | { kind: "response"; status: number; body: unknown };

async function getJson(url: string, timeoutMs: number): Promise<HttpJson> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined; // réponse non JSON : traitée comme non identifiable
    }
    return { kind: "response", status: res.status, body };
  } catch {
    return { kind: "down" };
  }
}

/** Reconnaît le contrat `GET /api/health` (version + au moins un marqueur Cogitator). */
function recognizedHealth(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const r = body as Record<string, unknown>;
  if (typeof r.version !== "string" || r.version === "") return undefined;
  if (r.ok !== true && !("pi_version" in r) && !("db" in r)) return undefined;
  return r.version;
}

/** Reconnaît `GET /api/status` — la sonde historique de `isUp()`, seule accessible en mode auth. */
function recognizedStatus(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as Record<string, unknown>).service === "cogitator";
}

/**
 * Sonde réelle : `/api/health` d'abord (version), puis `/api/status` en repli.
 * Le repli préserve le comportement existant quand `/api/health` est filtré (auth
 * requise, 5xx) : on se connecte sans comparer, et on ne tue jamais rien.
 */
export async function probeServer(baseUrl: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<HealthProbe> {
  const health = await getJson(`${baseUrl}/api/health`, timeoutMs);
  if (health.kind === "down") return { kind: "down" };
  const version = recognizedHealth(health.body);
  if (version !== undefined) return { kind: "cogitator", version };
  const status = await getJson(`${baseUrl}/api/status`, timeoutMs);
  if (status.kind === "response" && recognizedStatus(status.body)) return { kind: "cogitator", version: null };
  return { kind: "foreign" };
}

/** Comparaison semver tolérante : numéros manquants = 0, pré-version < version finale. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = "", ...rest] = value.trim().replace(/^v/, "").split("+")[0]!.split("-");
    const numbers = core.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
    return { numbers, pre: rest.join("-") };
  };
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let i = 0; i < length; i++) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  if (left.pre === right.pre) return 0;
  return left.pre < right.pre ? -1 : 1;
}

function portOf(baseUrl: string): number | null {
  try {
    const url = new URL(baseUrl);
    if (url.port !== "") return Number(url.port);
    return url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : null;
  } catch {
    return null;
  }
}

/**
 * Garantit qu'un serveur compatible avec la version installée est disponible.
 * Ordre : rien → démarrer ; version ≥ installée → se connecter ; version <
 * installée → SIGTERM sur le pid du pidfile *si et seulement si* pidfile et
 * réponse HTTP concordent, puis redémarrage. Toute ambiguïté → aucun kill.
 */
export async function ensureCompatibleServer(deps: CompatDeps): Promise<CompatOutcome> {
  const probe = await deps.probeServer(deps.baseUrl);
  if (probe.kind === "down") {
    const started = await startServer(deps, "started");
    return started.action === "unavailable" ? started : { action: "started", version: started.version };
  }
  if (probe.kind === "foreign") return { action: "unavailable", reason: "foreign-service" };
  if (probe.version === null) return { action: "connected", version: null };
  if (compareVersions(probe.version, deps.installedVersion) >= 0) {
    return { action: "connected", version: probe.version };
  }
  const identity = deps.readIdentity();
  const port = portOf(deps.baseUrl);
  const coherent =
    identity !== null &&
    identity.pid !== process.pid &&
    identity.version === probe.version &&
    port !== null &&
    identity.port === port &&
    deps.isAlive(identity.pid);
  if (!identity || !coherent) return { action: "unavailable", reason: "incoherent-pidfile" };
  try {
    deps.kill(identity.pid, "SIGTERM");
  } catch {
    return { action: "unavailable", reason: "incoherent-pidfile" };
  }
  if (!(await waitForStop(deps, identity.pid))) return { action: "unavailable", reason: "stop-timeout" };
  const started = await startServer(deps, "restarted");
  if (started.action === "unavailable") return started;
  return { action: "restarted", version: started.version, stoppedPid: identity.pid };
}

async function startServer(deps: CompatDeps, action: "started" | "restarted"): Promise<
  { action: "started" | "restarted"; version: string | null } | { action: "unavailable"; reason: UnavailableReason }
> {
  deps.spawnServer();
  const attempts = deps.startupAttempts ?? STARTUP_ATTEMPTS;
  const pollMs = deps.startupPollMs ?? STARTUP_POLL_MS;
  for (let i = 0; i < attempts; i++) {
    await deps.sleep(pollMs);
    const probe = await deps.probeServer(deps.baseUrl);
    if (probe.kind === "cogitator") return { action, version: probe.version };
  }
  return { action: "unavailable", reason: "start-timeout" };
}

async function waitForStop(deps: CompatDeps, pid: number): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.stopTimeoutMs ?? STOP_TIMEOUT_MS);
  const pollMs = deps.stopPollMs ?? STOP_POLL_MS;
  for (;;) {
    const alive = deps.isAlive(pid);
    const probe = await deps.probeServer(deps.baseUrl);
    if (!alive && probe.kind === "down") return true;
    if (now() >= deadline) return false;
    await deps.sleep(pollMs);
  }
}

/**
 * Garde de démarrage (CLI) : refuse d'écraser un pidfile dont le PID est vivant
 * et répond comme Cogitator sur le port qu'il déclare. Un pidfile périmé (PID
 * mort, ou vivant mais muet) est remplacé sans bruit : c'est un arrêt brutal.
 */
export async function assertNoLiveInstance(
  home: string,
  opts: { probeServer: (baseUrl: string) => Promise<HealthProbe>; isAlive: (pid: number) => boolean; host?: string },
): Promise<void> {
  const identity = readServerIdentity(home);
  if (!identity || !opts.isAlive(identity.pid)) return;
  const probe = await opts.probeServer(`http://${opts.host ?? "127.0.0.1"}:${identity.port}`);
  if (probe.kind !== "cogitator") return;
  throw new Error(
    `Cogitator ${identity.version} is already running (pid ${identity.pid}, port ${identity.port}). Stop it before starting another server.`,
  );
}
