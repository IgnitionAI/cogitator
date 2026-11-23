import { lazy, useEffect, useMemo, useState } from "react";

import { agentGenome, genomeKey, type AvatarGenome, type AvatarSource } from "./avatar/genome";

/** La tête animée : three.js reste hors du premier rendu. */
export const AgentHead3D = lazy(() => import("./avatar/AgentHead3D"));

const COLORS = ["#5e6ad2", "#b0702a", "#2f7d5c", "#7a4aa8", "#a8455a", "#2b7a99", "#6b7a2f", "#8a5a2b"];
function letterColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

// Les vignettes sont calculées une par une, entre deux images, pour ne pas figer l'interface.
type Stage = typeof import("./avatar/stage");
let stage: Promise<Stage> | null = null;
const queue: Array<() => void> = [];
let draining = false;
function drain() {
  const job = queue.shift();
  if (!job) { draining = false; return; }
  job();
  requestAnimationFrame(drain);
}
function snapshotLater(genome: AvatarGenome, done: (url: string | null) => void): () => void {
  let cancelled = false;
  (stage ??= import("./avatar/stage")).then((module) => {
    const cached = module.cachedSnapshot(genome);
    if (cached) { if (!cancelled) done(cached); return; }
    queue.push(() => { if (!cancelled) done(module.avatarSnapshot(genome)); });
    if (!draining) { draining = true; requestAnimationFrame(drain); }
  }).catch(() => done(null));
  return () => { cancelled = true; };
}

export function useAgentGenome(agent: AvatarSource | null): AvatarGenome | null {
  const skills = agent?.skills?.join("|") ?? "";
  const subagents = agent?.subagents?.length ?? 0;
  return useMemo(
    () => (agent ? agentGenome(agent) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent?.id, agent?.name, agent?.description, agent?.provider, skills, subagents],
  );
}

/** Vignette d'agent : sa tête de machine en image, l'initiale en attendant (ou sans WebGL). */
export function AgentFace(props: { agent: AvatarSource; size?: number; status?: "working" | "ready" | "idle" }) {
  const size = props.size ?? 38;
  const genome = useAgentGenome(props.agent)!;
  const key = genomeKey(genome);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => snapshotLater(genome, setUrl), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return <span className={`hub-avatar${url ? " is-machine" : ""}`} style={{ width: size, height: size, background: url ? undefined : letterColor(props.agent.id), fontSize: Math.round(size * 0.4) }} aria-hidden="true">
    {url ? <img src={url} alt="" width={size} height={size} /> : props.agent.name.trim().charAt(0).toUpperCase() || "?"}
    {props.status ? <span className={`hub-presence is-${props.status}`} /> : null}
  </span>;
}
