import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

import { genomeKey, type AvatarGenome } from "./genome";
import { buildHead } from "./head";
import { makeStudio } from "./stage";

/**
 * La tête animée d'un agent. Un seul exemplaire à l'écran (l'agent sélectionné) :
 * les listes utilisent des vignettes, pour rester loin de la limite de contextes WebGL.
 */
export default function AgentHead3D(props: { genome: AvatarGenome; working?: boolean; error?: boolean; size?: number }) {
  const size = props.size ?? 150;
  const canvas = useRef<HTMLCanvasElement>(null);
  const target = useRef({ work: props.working ? 1 : 0, err: props.error ? 1 : 0 });
  target.current = { work: props.working ? 1 : 0, err: props.error ? 1 : 0 };
  const [failed, setFailed] = useState(false);
  const key = genomeKey(props.genome);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: element, antialias: true, alpha: true, powerPreference: "low-power" });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(size, size, false);
    const scene = makeStudio(renderer);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    camera.position.set(0, 0.1, 3.6);
    camera.lookAt(0, 0.06, 0);
    const head = buildHead(props.genome);
    scene.add(head.root);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const live = { ...target.current };
    const pointer = { x: 0, y: 0 };
    const onMove = (event: PointerEvent) => {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove);

    let visible = true;
    const observer = new IntersectionObserver(([entry]) => { visible = Boolean(entry?.isIntersecting); });
    observer.observe(element);

    let frame = 0;
    let last = performance.now();
    let clock = 1.3;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible) return;
      const k = Math.min(1, dt * 3);
      live.work += (target.current.work - live.work) * k;
      live.err += (target.current.err - live.err) * k;
      if (reduced) {
        head.update(1.3, 0, { work: target.current.work, err: target.current.err });
      } else {
        clock += dt;
        head.root.rotation.y = -0.18 + Math.sin(clock * 0.35) * 0.2 + pointer.x * 0.3;
        head.root.rotation.x = pointer.y * 0.12;
        head.update(clock, dt, live);
      }
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("pointermove", onMove);
      head.dispose();
      scene.environment?.dispose();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, size]);

  if (failed) return <img src="/icon.png" alt="" width={size} height={size} />;
  return <canvas ref={canvas} className="agent-head-3d" width={size} height={size} style={{ width: size, height: size }} aria-hidden="true" />;
}
