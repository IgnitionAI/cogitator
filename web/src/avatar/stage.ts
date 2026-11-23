import * as THREE from "three";

import { genomeKey, type AvatarGenome } from "./genome";
import { buildHead } from "./head";

/** Studio commun : reflets, lumière chaude devant, contre-jour violet derrière. */
export function makeStudio(renderer: THREE.WebGLRenderer): THREE.Scene {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.75;
  const scene = new THREE.Scene();

  const pmrem = new THREE.PMREMGenerator(renderer);
  const probe = new THREE.Scene();
  probe.background = new THREE.Color(0x0a0b10);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const panel = (color: number, power: number, position: [number, number, number], scale: [number, number, number]) => {
    const mesh = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power) }));
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    probe.add(mesh);
  };
  panel(0xffe2b8, 4, [3, 4, 3], [3, 0.2, 3]);
  panel(0x8090ff, 3, [-4, 1, -3], [0.2, 4, 4]);
  panel(0x3a4058, 1.2, [0, -3, 0], [10, 0.2, 10]);
  panel(0xffffff, 1.6, [0, 2, 5], [2, 2, 0.2]);
  scene.environment = pmrem.fromScene(probe, 0.04).texture;
  scene.environmentIntensity = 1.5;
  probe.traverse((o) => { const m = o as THREE.Mesh; if (m.material) (m.material as THREE.Material).dispose(); });
  box.dispose();
  pmrem.dispose();

  // Les intensités sont physiques (three ≥ 0.155) : d'où les facteurs π.
  scene.add(new THREE.AmbientLight(0x404458, 0.45 * Math.PI));
  const key = new THREE.DirectionalLight(0xffe0c0, 1.3 * Math.PI);
  key.position.set(2.5, 3, 3.5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7c84ff, 2.2 * Math.PI);
  rim.position.set(-2.5, 1.8, -3);
  scene.add(rim);
  const warm = new THREE.DirectionalLight(0xff9a5c, 0.8 * Math.PI);
  warm.position.set(2.5, 1, -3);
  scene.add(warm);
  return scene;
}

/** Un seul rendu hors écran « photographie » chaque tête pour les listes : pas un contexte WebGL par agent. */
const SNAP_SIZE = 160;
let snapRenderer: THREE.WebGLRenderer | null = null;
let snapScene: THREE.Scene | null = null;
let snapCamera: THREE.PerspectiveCamera | null = null;
let snapBroken = false;
const snapCache = new Map<string, string>();

/** Vignette déjà calculée, sans rien rendre. */
export function cachedSnapshot(genome: AvatarGenome): string | null {
  return snapCache.get(genomeKey(genome)) ?? null;
}

export function avatarSnapshot(genome: AvatarGenome): string | null {
  const key = genomeKey(genome);
  const cached = snapCache.get(key);
  if (cached) return cached;
  if (snapBroken) return null;
  try {
    if (!snapRenderer) {
      const canvas = document.createElement("canvas");
      snapRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "low-power" });
      snapRenderer.setPixelRatio(1);
      snapRenderer.setSize(SNAP_SIZE, SNAP_SIZE, false);
      snapScene = makeStudio(snapRenderer);
      snapCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
      snapCamera.position.set(0, 0.06, 2.95);
      snapCamera.lookAt(0, 0.02, 0);
    }
    const head = buildHead(genome);
    head.root.rotation.y = -0.32;
    head.update(1.3, 0.016, { work: 0, err: 0 });
    snapScene!.add(head.root);
    snapRenderer.render(snapScene!, snapCamera!);
    const url = snapRenderer.domElement.toDataURL("image/png");
    snapScene!.remove(head.root);
    head.dispose();
    snapCache.set(key, url);
    return url;
  } catch {
    snapBroken = true;
    return null;
  }
}
