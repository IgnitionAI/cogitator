import * as THREE from "three";

import type { AvatarGenome } from "./genome";

/**
 * La tête de machine commune à tous les agents (le « parent ») et les variantes de type.
 * Construite en code, sans fichier 3D : crâne, masque riveté, optiques, oreilles-engrenages,
 * crête à voyants, antennes. Le type change le masque ; le génome règle le reste.
 */

export interface AvatarState {
  /** 0 = au repos, 1 = au travail. Interpolé par l'appelant. */
  work: number;
  /** 0 = normal, 1 = en erreur. */
  err: number;
}

export interface AvatarHead {
  root: THREE.Group;
  update: (time: number, delta: number, state: AvatarState) => void;
  dispose: () => void;
}

const RED = new THREE.Color(0xff3b30);
const PLATE_DEPTH = 0.045;
const bendZ = (x: number, y: number) => -0.55 * x * x - 0.18 * y * y;
const plateFront = (x: number, y: number) => 0.5 + bendZ(x, y) + PLATE_DEPTH + 0.015;

let glowTexture: THREE.Texture | null = null;
function glowMap(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.22, "rgba(255,255,255,0.55)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}

function glow(color: THREE.Color, scale: number): THREE.Sprite {
  const material = new THREE.SpriteMaterial({ map: glowMap(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(scale);
  return sprite;
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Même profil de dents que le logo Cogitator. */
export function gearGeometry(teeth: number, rIn: number, rOut: number, hole: number, depth: number) {
  const shape = new THREE.Shape();
  const n = teeth * 18;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = rIn + (rOut - rIn) * smooth(-0.25, 0.45, Math.cos(a * teeth));
    if (i) shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  shape.closePath();
  if (hole) {
    const path = new THREE.Path();
    path.absarc(0, 0, hole, 0, Math.PI * 2, true);
    shape.holes.push(path);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: depth * 0.3, bevelSize: depth * 0.22, bevelSegments: 1, curveSegments: 24,
  });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

/** Le masque : un bouclier extrudé puis courbé autour du crâne (pas de trous, les orbites sont posées dessus). */
function plateGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, 0.36);
  s.bezierCurveTo(0.22, 0.37, 0.42, 0.33, 0.45, 0.16);
  s.bezierCurveTo(0.48, 0.0, 0.44, -0.14, 0.36, -0.27);
  s.bezierCurveTo(0.28, -0.42, 0.18, -0.53, 0.0, -0.56);
  s.bezierCurveTo(-0.18, -0.53, -0.28, -0.42, -0.36, -0.27);
  s.bezierCurveTo(-0.44, -0.14, -0.48, 0.0, -0.45, 0.16);
  s.bezierCurveTo(-0.42, 0.33, -0.22, 0.37, 0, 0.36);
  const geometry = new THREE.ExtrudeGeometry(s, {
    depth: PLATE_DEPTH, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.012, bevelSegments: 3, curveSegments: 36,
  });
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const nor = geometry.attributes.normal as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    pos.setZ(i, pos.getZ(i) + bendZ(x, y));
    const nz = nor.getZ(i);
    v.set(nor.getX(i) + nz * 1.1 * x, nor.getY(i) + nz * 0.36 * y, nz).normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.translate(0, 0, 0.5);
  return geometry;
}

export function buildHead(g: AvatarGenome): AvatarHead {
  const root = new THREE.Group();
  const head = new THREE.Group();
  root.add(head);
  const optic = new THREE.Color().setHSL(g.hue, 0.85, 0.6);

  const gunM = new THREE.MeshStandardMaterial({ color: 0x30343d, metalness: 0.85, roughness: 0.46 + g.wear * 0.1 });
  const plateM = g.type === "intendant"
    ? new THREE.MeshStandardMaterial({ color: g.metal, metalness: 1, roughness: 0.32 })
    : new THREE.MeshStandardMaterial({ color: g.type === "sentinelle" ? 0x2a2e36 : 0x454b57, metalness: 0.8, roughness: g.type === "sentinelle" ? 0.55 : 0.42 });
  const accentM = new THREE.MeshStandardMaterial({ color: g.metal, metalness: 1, roughness: 0.26 + g.wear * 0.15 });
  const darkM = new THREE.MeshStandardMaterial({ color: 0x15171c, metalness: 0.8, roughness: 0.5 });
  const voidM = new THREE.MeshBasicMaterial({ color: 0x020203 });

  const lit: THREE.MeshBasicMaterial[] = [];
  const glows: Array<{ sprite: THREE.Sprite; base: number }> = [];
  const ticks: Array<(t: number, dt: number, w: number) => void> = [];

  const addLit = (color = optic) => { const m = new THREE.MeshBasicMaterial({ color: color.clone() }); lit.push(m); return m; };
  const addGlow = (parent: THREE.Object3D, scale: number) => { const s = glow(optic.clone(), scale); parent.add(s); glows.push({ sprite: s, base: scale }); return s; };

  function lens(x: number, y: number, radius: number, glowScale: number, parent: THREE.Object3D = head, z = plateFront(x, y) - 0.004) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), addLit());
    eye.scale.z = 0.45;
    eye.position.set(x, y, z);
    parent.add(eye);
    const halo = addGlow(parent, glowScale);
    halo.position.set(x, y, z + 0.06);
    return { eye, halo };
  }
  function onPlate(x: number, y: number, lift: number) {
    const holder = new THREE.Group();
    holder.position.set(x, y, plateFront(x, y) + lift);
    holder.rotation.y = Math.atan(1.1 * x);
    holder.rotation.x = -Math.atan(0.36 * y);
    head.add(holder);
    return holder;
  }
  function socket(x: number, y: number, rx: number, ry: number, rot = 0) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 40), voidM);
    disc.scale.set(rx, ry, 1);
    disc.rotation.z = rot;
    onPlate(x, y, 0.001).add(disc);
  }
  function rim(x: number, y: number, rx: number, ry: number, rot = 0, tube = 0.012) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, tube, 8, 48), accentM);
    ring.scale.set(rx + 0.008, ry + 0.008, 1);
    ring.rotation.z = rot;
    onPlate(x, y, 0.002).add(ring);
  }
  const eye = (x: number, y: number, rx: number, ry: number, rot: number, tube?: number) => {
    socket(x, y, rx, ry, rot);
    lens(x, y, 0.05, 0.42);
    rim(x, y, rx, ry, rot, tube);
  };

  // Crâne et masque
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.56, 64, 48), gunM);
  skull.scale.set(0.9, 1.02, 1.04);
  skull.position.set(0, 0.04, -0.05);
  head.add(skull);
  head.add(new THREE.Mesh(plateGeometry(), plateM));

  // Grille de bouche, couture, rivets
  onPlate(0, -0.33, 0.001).add(new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.14), voidM));
  for (let i = -2; i <= 2; i++) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.14, 8), accentM);
    bar.position.set(i * 0.038, -0.33, plateFront(i * 0.038, -0.33) + 0.008);
    head.add(bar);
  }
  const seam = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.16, 0.01), darkM);
  seam.position.set(0, 0.25, plateFront(0, 0.25) + 0.002);
  head.add(seam);
  const rivet = new THREE.SphereGeometry(0.011, 8, 6);
  for (const [x, y] of [[-0.39, 0.2], [0.39, 0.2], [-0.4, -0.08], [0.4, -0.08], [-0.27, -0.36], [0.27, -0.36], [-0.12, 0.3], [0.12, 0.3]] as const) {
    const r = new THREE.Mesh(rivet, accentM);
    r.position.set(x, y, plateFront(x, y) - 0.004);
    head.add(r);
  }

  // Tubes respiratoires
  for (const side of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 0.13, -0.38, 0.47), new THREE.Vector3(side * 0.2, -0.52, 0.4),
      new THREE.Vector3(side * 0.22, -0.66, 0.22), new THREE.Vector3(side * 0.2, -0.78, 0.05),
    ]);
    head.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.026, 10, false), darkM));
    for (const u of [0.2, 0.45, 0.7]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.008, 6, 16), accentM);
      const point = curve.getPoint(u);
      ring.position.copy(point);
      ring.lookAt(point.clone().add(curve.getTangent(u)));
      head.add(ring);
    }
  }

  // Optiques selon le type
  let scanner: { eye: THREE.Mesh; halo: THREE.Sprite } | null = null;
  let monocle: THREE.Group | null = null;
  if (g.type === "sentinelle") {
    const slotM = new THREE.MeshBasicMaterial({ color: optic.clone().multiplyScalar(0.18) });
    for (let i = 0; i < 14; i++) {
      const x = -0.28 + (i + 0.5) * 0.04;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.05, 0.004), slotM);
      seg.position.set(x, 0.07, plateFront(x, 0.07) + 0.001);
      seg.rotation.y = Math.atan(1.1 * x);
      head.add(seg);
    }
    scanner = lens(0, 0.07, 0.04, 0.5);
  } else {
    eye(-0.17, 0.07, 0.1, 0.056, -0.12);
    if (g.type === "artificier") {
      monocle = new THREE.Group();
      monocle.position.set(0.17, 0.07, plateFront(0.17, 0.07) - 0.02);
      monocle.rotation.y = Math.atan(1.1 * 0.17);
      head.add(monocle);
      let z = 0;
      for (const [radius, length] of [[0.095, 0.05], [0.08, 0.05], [0.066, 0.045]] as const) {
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 32, 1, true), accentM);
        tube.rotation.x = Math.PI / 2;
        tube.position.z = z + length / 2;
        monocle.add(tube);
        const lip = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.008, 8, 32), accentM);
        lip.position.z = z + length;
        monocle.add(lip);
        z += length;
      }
      lens(0, 0, 0.062, 0.6, monocle, 0.15);
    } else {
      eye(0.17, 0.07, 0.1, 0.056, 0.12, g.type === "intendant" ? 0.02 : 0.012);
    }
  }
  if (g.type === "oracle") {
    socket(0, 0.25, 0.04, 0.04);
    lens(0, 0.25, 0.035, 0.34);
    rim(0, 0.25, 0.04, 0.04);
    const haloM = new THREE.MeshBasicMaterial({ color: optic.clone(), transparent: true, opacity: 0.6 });
    lit.push(haloM);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.006, 8, 96), haloM);
    halo.position.set(0, 0.84, -0.1);
    halo.rotation.x = Math.PI / 2 - 0.35;
    root.add(halo);
    ticks.push((t, dt, w) => { halo.position.y = 0.84 + Math.sin(t * 1.1) * 0.025; halo.rotation.z += dt * (0.3 + w); haloM.opacity = 0.3 + w * 0.45; });
  }
  if (g.type === "archiviste") {
    for (const [x, y, radius] of [[-0.35, 0.17, 0.034], [-0.38, 0.03, 0.028], [-0.33, -0.1, 0.024]] as const) {
      const pod = onPlate(x, y, -0.01);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(radius + 0.012, radius + 0.016, 0.05, 24), accentM);
      tube.rotation.x = Math.PI / 2;
      tube.position.z = 0.025;
      pod.add(tube);
      lens(0, 0, radius, radius * 8, pod, 0.052);
    }
  }
  if (g.type === "logisticien") {
    const mast = new THREE.Group();
    mast.position.set(0.55, 0.12, -0.04);
    head.add(mast);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.014, 0.42, 8), darkM);
    rod.position.y = 0.21;
    mast.add(rod);
    const gyro = new THREE.Group();
    gyro.position.y = 0.46;
    mast.add(gyro);
    const rings = [0.075, 0.055].map((radius, i) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.008, 8, 40), accentM);
      ring.rotation.x = i ? 1.2 : 0.3;
      gyro.add(ring);
      return ring;
    });
    lens(0, 0, 0.02, 0.22, gyro, 0);
    ticks.push((_t, dt, w) => { rings[0]!.rotation.y += dt * (0.8 + w * 4); rings[1]!.rotation.z += dt * (1.1 + w * 5); });
  }

  // Oreilles : l'engrenage Cogitator de chaque côté
  const ears = [-1, 1].map((side) => {
    const group = new THREE.Group();
    group.position.set(side * 0.52, 0.02, -0.04);
    group.rotation.y = (side * Math.PI) / 2;
    head.add(group);
    const gear = new THREE.Mesh(gearGeometry(g.teeth, 0.1, 0.13, 0.045, 0.045), accentM);
    group.add(gear);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.06, 24), darkM);
    cap.rotation.x = Math.PI / 2;
    group.add(cap);
    const led = new THREE.Mesh(new THREE.CircleGeometry(0.02, 20), addLit());
    led.position.z = 0.032;
    group.add(led);
    return gear;
  });

  // Crête : un rail du front à la nuque, un voyant par compétence
  const crest = new THREE.Group();
  crest.position.set(0, 0.04, -0.05);
  crest.rotation.y = -Math.PI / 2;
  head.add(crest);
  const A0 = 0.98, ARC = 1.9, CR = 0.6;
  const rail = new THREE.Mesh(new THREE.TorusGeometry(CR, 0.026, 10, 64, ARC), accentM);
  rail.rotation.z = A0;
  crest.add(rail);
  const leds: Array<{ material: THREE.MeshBasicMaterial; halo: THREE.Sprite; i: number }> = [];
  for (let i = 0; i < g.leds; i++) {
    const a = A0 + ARC * ((i + 1) / (g.leds + 1));
    const material = new THREE.MeshBasicMaterial({ color: optic.clone() });
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8), material);
    led.position.set(Math.cos(a) * (CR + 0.026), Math.sin(a) * (CR + 0.026), 0);
    crest.add(led);
    const halo = glow(optic.clone(), 0.12);
    halo.position.copy(led.position).multiplyScalar(1.03);
    crest.add(halo);
    leds.push({ material, halo, i });
  }

  // Antennes : une par sous-agent
  const tips: Array<{ material: THREE.MeshBasicMaterial; halo: THREE.Sprite; k: number }> = [];
  for (let k = 0; k < g.antennas; k++) {
    const x = (k - (g.antennas - 1) / 2) * 0.16;
    const antenna = new THREE.Group();
    antenna.position.set(x, 0.42, -0.32);
    antenna.rotation.set(-0.55, 0, -x * 1.2);
    head.add(antenna);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.34, 8), darkM);
    rod.position.y = 0.17;
    antenna.add(rod);
    antenna.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.03, 16), accentM));
    const material = new THREE.MeshBasicMaterial({ color: optic.clone() });
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), material);
    tip.position.y = 0.35;
    antenna.add(tip);
    const halo = glow(optic.clone(), 0.16);
    halo.position.y = 0.35;
    antenna.add(halo);
    tips.push({ material, halo, k });
  }

  // Cou et col
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.22, 0.4, 32), darkM);
  neck.position.y = -0.66;
  root.add(neck);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 12, 40), accentM);
  collar.position.y = -0.52;
  collar.rotation.x = Math.PI / 2;
  root.add(collar);
  for (const side of [-1, 1]) {
    const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.34, 12), accentM);
    piston.position.set(side * 0.2, -0.56, -0.1);
    piston.rotation.z = side * 0.35;
    root.add(piston);
  }

  const faceLight = new THREE.PointLight(optic.clone(), 0.3, 1.2, 0);
  faceLight.position.set(0, 0.07, 0.75);
  head.add(faceLight);

  const tint = new THREE.Color();
  function update(t: number, dt: number, s: AvatarState) {
    const w = s.work;
    const e = s.err;
    tint.copy(optic).lerp(RED, e);
    const flicker = e > 0.5 && Math.random() < 0.12 ? 0.2 : 1;
    const pulse = (0.8 + 0.15 * Math.sin(t * 1.5) + w * (0.35 + 0.15 * Math.sin(t * 11))) * flicker;
    const level = Math.max(0.25, Math.min(1.25, pulse));
    for (const m of lit) m.color.copy(tint).multiplyScalar(level);
    for (const { sprite, base } of glows) {
      sprite.material.color.copy(tint);
      sprite.material.opacity = Math.min(1, 0.25 + 0.4 * pulse);
      sprite.scale.setScalar(base * (0.7 + 0.4 * pulse));
    }
    faceLight.color.copy(tint);
    faceLight.intensity = (0.25 + w * 0.8) * flicker;
    for (const { material, halo, i } of leds) {
      const chase = w > 0.05 ? Math.max(0, Math.sin(t * 7 - i * 0.9)) : 0;
      const b = 0.35 + 0.15 * Math.sin(t * 1.2 + i) + w * chase;
      material.color.copy(tint).multiplyScalar(b);
      halo.material.color.copy(tint);
      halo.material.opacity = Math.min(1, b * 0.8);
    }
    for (const { material, halo, k } of tips) {
      const on = w > 0.05 ? (Math.sin(t * 6 + k * 2) > 0 ? 1 : 0.25) : 0.5 + 0.3 * Math.sin(t * 1.4 + k);
      material.color.copy(tint).multiplyScalar(on);
      halo.material.color.copy(tint);
      halo.material.opacity = on * 0.8;
    }
    ears.forEach((gear, i) => { gear.rotation.z += dt * (0.15 + w * 3) * (i ? 1 : -1); });
    if (scanner) {
      const x = 0.24 * Math.sin(t * (0.7 + w * 3));
      scanner.eye.position.set(x, 0.07, plateFront(x, 0.07) - 0.004);
      scanner.halo.position.set(x, 0.07, plateFront(x, 0.07) + 0.056);
    }
    if (monocle) monocle.scale.z = 1 + w * 0.35 * (0.5 + 0.5 * Math.sin(t * 2.2));
    const twitch = e > 0.5 && Math.random() < 0.05 ? (Math.random() - 0.5) * 0.12 : 0;
    head.rotation.x = 0.03 * Math.sin(t * 0.7) + w * 0.02 * Math.sin(t * 4.3) + twitch;
    head.rotation.z = 0.025 * Math.sin(t * 0.5) + twitch * 0.5;
    for (const tick of ticks) tick(t, dt, w);
  }

  function dispose() {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (material) (Array.isArray(material) ? material : [material]).forEach((m) => m.dispose());
    });
  }

  return { root, update, dispose };
}
