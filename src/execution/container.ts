/**
 * Spécification des workers conteneurisés (Plan 0002 §4, P2 ; ADR-008 D5).
 *
 * Construction pure et vérifiable d'un `docker run` orienté rootless :
 * rootfs en lecture seule, scratch tmpfs noexec, seul le workspace enrôlé est
 * monté (rw), aucun socket Docker ni montage du plan de contrôle, capabilities
 * droppées, métadonnées cloud et ports du plan de contrôle injoignables
 * (network none par défaut ; egress uniquement via le proxy allowlist), limites
 * mémoire/CPU/PID, utilisateur non-root, aucun secret dans l'environnement.
 *
 * Limite documentée : le Docker local de développement n'est pas une preuve
 * rootless de production ; l'application rejetée ici (spec invalide) et les
 * limites non supportées par l'hôte (validateHostEnforcement) sont des échecs
 * de déploiement, jamais un abaissement silencieux.
 */

import { enrollWorkspaceDir, type EnrollmentPolicy } from "./confinement.js";
import { egressProxyEnv, type EgressPolicy } from "./egress.js";
import { resolve, sep } from "node:path";

export interface WorkerMount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface WorkerContainerSpec {
  image: string;
  name: string;
  command: string[];
  /** Seuls les workspaces enrôlés sont montés en écriture. */
  mounts: WorkerMount[];
  /** "none" : aucun egress ; "egress" : proxy allowlist obligatoire. */
  network: "none" | "egress";
  env: Record<string, string>;
  user: string;
  memoryBytes: number;
  cpuCount: number;
  pidsLimit: number;
}

const FORBIDDEN_MOUNT_SOURCES = ["/var/run/docker.sock", "/run/docker.sock", "/var/run/docker"];
/** Le worker ne reçoit aucun secret : clés fournisseurs, tokens GitHub, état Cogitator. */
const SECRET_ENV_PATTERN = /^(AWS_|AZURE_|GOOGLE_|GITHUB_|GH_|OPENAI_|ANTHROPIC_|COGITATOR_|SECRET|TOKEN)/i;

function isForbiddenMount(source: string): boolean {
  const canonical = resolve(source);
  return FORBIDDEN_MOUNT_SOURCES.some((f) => canonical === resolve(f) || canonical.endsWith(sep + "docker.sock"));
}
/** IP de métadonnées cloud (169.254.169.254) — injoignable avec network "none". */
export const CLOUD_METADATA_IP = "169.254.169.254";

export interface BuildSpecInput {
  image: string;
  name: string;
  command: string[];
  /** Workspace enrôlé monté en écriture ; obligatoire pour une mission. */
  workspaceMount?: { source: string; target: string };
  env?: Record<string, string>;
  /** null/undefined → network none (pas d'egress). Sinon proxy allowlist obligatoire. */
  egress?: EgressPolicy | null;
  user?: string;
  memoryBytes?: number;
  cpuCount?: number;
  pidsLimit?: number;
}

export type SpecResult = { spec: WorkerContainerSpec } | { error: string };

export function buildWorkerContainerSpec(input: BuildSpecInput, enrollment: EnrollmentPolicy): SpecResult {
  if (input.workspaceMount) {
    const enrolled = enrollWorkspaceDir(enrollment, input.workspaceMount.source);
    if ("error" in enrolled) return { error: `montage workspace refusé: ${enrolled.error}` };
    const source = enrolled.dir;
    if (isForbiddenMount(source)) {
      return { error: `montage du plan de contrôle refusé: ${source}` };
    }
    input = { ...input, workspaceMount: { ...input.workspaceMount, source } };
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (SECRET_ENV_PATTERN.test(key)) return { error: `variable d'environnement secrète refusée au worker: ${key}` };
    if (value.includes(CLOUD_METADATA_IP)) return { error: `valeur d'environnement pointant vers les métadonnées cloud: ${key}` };
  }
  let env = { ...(input.env ?? {}) };
  const network = input.egress ? "egress" as const : "none" as const;
  if (input.egress) env = { ...env, ...egressProxyEnv(input.egress) };
  return {
    spec: {
      image: input.image,
      name: input.name,
      command: input.command,
      mounts: input.workspaceMount
        ? [{ source: input.workspaceMount.source, target: input.workspaceMount.target, readOnly: false }]
        : [],
      network,
      env,
      user: input.user ?? "65534:65534", // nobody:nogroup — jamais root
      memoryBytes: input.memoryBytes ?? 2 * 1024 ** 3, // 2 GiB (Plan 0002, worker limits)
      cpuCount: input.cpuCount ?? 1.5,
      pidsLimit: input.pidsLimit ?? 256,
    },
  };
}

/** Traduction en arguments `docker run` (image linux/OCI, Docker comme chemin local d'expérimentation). */
export function dockerRunArgs(spec: WorkerContainerSpec): string[] {
  const args = [
    "run", "--rm", "-i",
    "--name", spec.name,
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
    "--tmpfs", "/workspace/.scratch:rw,noexec,nosuid,size=256m,mode=1777",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", spec.user,
    "--network", spec.network === "none" ? "none" : "bridge",
    "--memory", String(spec.memoryBytes),
    "--cpus", String(spec.cpuCount),
    "--pids-limit", String(spec.pidsLimit),
  ];
  for (const mount of spec.mounts) {
    args.push("-v", `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ":rw"}`);
  }
  for (const [key, value] of Object.entries(spec.env)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(spec.image, ...spec.command);
  return args;
}

export interface HostEnforcementInfo {
  securityOptions: string[];
  cgroupDriver: string;
}

/**
 * Une limite ressource non supportée par l'hôte est un échec de déploiement
 * (Plan 0002 §8 : pas d'abaissement silencieux). Seccomp obligatoire.
 */
export function validateHostEnforcement(info: HostEnforcementInfo): void {
  if (!info.securityOptions.some((o) => o.includes("seccomp"))) {
    throw new Error("déploiement refusé: seccomp non actif sur l'hôte Docker");
  }
  if (!info.cgroupDriver) {
    throw new Error("déploiement refusé: driver cgroup indéterminé, limites mémoire/CPU non garanties");
  }
}
