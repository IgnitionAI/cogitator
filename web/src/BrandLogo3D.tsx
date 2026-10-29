import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

/** Fallback mark when WebGL is unavailable: the static favicon. */
function BrandLogoFallback() {
  return <img src="/favicon.png" alt="" className="brand-logo" width={26} height={26} />;
}

function hasWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** Procedural reflection probe: a small violet-to-black equirect, so the metal reads as metal. */
function Environment() {
  const scene = useThree((state) => state.scene);
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    // A 128x64 studio probe: bright top softbox, violet and warm side lights.
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const base = ctx.createLinearGradient(0, 0, 0, 64);
    base.addColorStop(0, "#9aa2cf");
    base.addColorStop(0.3, "#252838");
    base.addColorStop(0.55, "#12131b");
    base.addColorStop(0.8, "#4b3aa8");
    base.addColorStop(1, "#0b0c12");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 128, 64);
    const softbox = (x: number, y: number, radius: number, color: string) => {
      const spot = ctx.createRadialGradient(x, y, 0, x, y, radius);
      spot.addColorStop(0, color);
      spot.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = spot;
      ctx.fillRect(0, 0, 128, 64);
    };
    softbox(62, 10, 46, "#ffffff");
    softbox(16, 34, 30, "#8f86ff");
    softbox(114, 26, 26, "#ffd9a0");
    const source = new THREE.CanvasTexture(canvas);
    source.mapping = THREE.EquirectangularReflectionMapping;
    source.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(gl);
    const target = pmrem.fromEquirectangular(source);
    scene.environment = target.texture;
    invalidate();
    return () => {
      scene.environment = null;
      target.dispose();
      pmrem.dispose();
      source.dispose();
    };
  }, [scene, gl, invalidate]);
  return null;
}

const PLASMA_VERTEX = /* glsl */ `
varying vec3 vPos;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vPos = position;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(viewPosition.xyz);
  vNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * viewPosition;
}
`;

const PLASMA_FRAGMENT = /* glsl */ `
precision highp float;
uniform float uTime;
varying vec3 vPos;
varying vec3 vNormal;
varying vec3 vView;

float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
                mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y);
  float b = mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
                mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y);
  return mix(a, b, f.z);
}

float fbm(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * vnoise(p);
    p *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec3 p = normalize(vPos + 1e-4);
  float angle = uTime * 0.7 + 2.6 * length(p.xy);
  float c = cos(angle);
  float s = sin(angle);
  vec3 swirl = vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);

  float n = fbm(swirl * 2.6 + vec3(0.0, 0.0, uTime * 0.25));
  float n2 = fbm(swirl * 6.5 - vec3(uTime * 0.18));

  vec3 col = mix(vec3(0.03, 0.03, 0.13), vec3(0.24, 0.19, 0.88), smoothstep(0.22, 0.78, n));
  col = mix(col, vec3(0.76, 0.82, 1.0), pow(smoothstep(0.46, 0.98, n2), 2.0));
  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  col += vec3(0.62, 0.66, 1.0) * pow(facing, 6.0) * 0.5;
  col += vec3(0.38, 0.32, 0.95) * pow(1.0 - facing, 2.2);
  col *= 0.72 + 0.68 * n;
  gl_FragColor = vec4(col, 1.0);
}
`;

const GLOW_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GLOW_FRAGMENT = /* glsl */ `
precision highp float;
uniform float uTime;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float glow = pow(smoothstep(1.0, 0.0, d), 3.0);
  float pulse = 0.9 + 0.1 * sin(uTime * 1.7);
  vec3 col = mix(vec3(0.32, 0.27, 0.95), vec3(0.86, 0.88, 1.0), glow) * glow * pulse;
  gl_FragColor = vec4(col, glow * 0.8 * pulse);
}
`;

/** Cog outline: a smoothed square wave in polar coordinates gives readable teeth. */
function gearGeometry(teeth: number, rootRadius: number, tipRadius: number, holeRadius: number, depth: number) {
  const segments = teeth * 16;
  const points: THREE.Vector2[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const wave = Math.cos(teeth * angle);
    const radius = THREE.MathUtils.lerp(rootRadius, tipRadius, THREE.MathUtils.smoothstep(wave, -0.45, 0.45));
    points.push(new THREE.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius));
  }
  const shape = new THREE.Shape(points);
  const hole = new THREE.Path();
  hole.absarc(0, 0, holeRadius, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.07,
    bevelSize: 0.06,
    bevelSegments: 3,
    curveSegments: 24,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function Cog({ reduced }: { reduced: boolean }) {
  const group = useRef<THREE.Group>(null);
  const pointer = useRef({ x: 0, y: 0 });

  const uniforms = useMemo(() => ({ uTime: { value: 0 } }), []);
  const gear = useMemo(() => gearGeometry(8, 0.86, 1.06, 0.58, 0.32), []);
  useEffect(() => () => gear.dispose(), [gear]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointer.current = {
        x: (event.clientX / window.innerWidth) * 2 - 1,
        y: (event.clientY / window.innerHeight) * 2 - 1,
      };
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useFrame((state) => {
    if (reduced || !group.current) return;
    const t = state.clock.elapsedTime;
    uniforms.uTime.value = t;
    // Idle spin plus pointer parallax: the mark tilts toward the cursor.
    group.current.rotation.y = Math.sin(t * 0.55) * 0.55 + pointer.current.x * 0.35;
    group.current.rotation.x = Math.sin(t * 0.8) * 0.14 + pointer.current.y * 0.22;
    group.current.rotation.z = Math.sin(t * 0.35) * 0.06;
    group.current.position.y = Math.sin(t * 1.1) * 0.02;
  });

  return (
    <group ref={group}>
      <mesh geometry={gear}>
        <meshStandardMaterial color="#e9b457" metalness={1} roughness={0.18} envMapIntensity={2.4} />
      </mesh>
      {/* Same profile scaled down: leaves the gold rim and the inner bezel showing. */}
      <mesh geometry={gear} position={[0, 0, 0.02]} scale={[0.87, 0.87, 1.08]}>
        <meshStandardMaterial color="#161c2e" metalness={0.85} roughness={0.34} envMapIntensity={1.4} />
      </mesh>
      <mesh position={[0, 0, 0.2]}>
        <torusGeometry args={[0.44, 0.055, 20, 64]} />
        <meshStandardMaterial color="#f5d183" metalness={1} roughness={0.14} envMapIntensity={2.6} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.45, 64, 64]} />
        <shaderMaterial uniforms={uniforms} vertexShader={PLASMA_VERTEX} fragmentShader={PLASMA_FRAGMENT} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, -0.5]} scale={[3.4, 3.4, 1]}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial
          uniforms={uniforms}
          vertexShader={GLOW_VERTEX}
          fragmentShader={GLOW_FRAGMENT}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

export default function BrandLogo3D() {
  const wrap = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const reduced = usePrefersReducedMotion();
  const webgl = useMemo(hasWebGL, []);

  // The sidebar is off-canvas on mobile: stop the render loop when the mark is not on screen.
  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (!webgl) return <BrandLogoFallback />;

  return (
    <div ref={wrap} className="brand-3d" aria-hidden="true">
      <Canvas
        camera={{ position: [0, 0, 3.7], fov: 40 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
        frameloop={reduced || !visible ? "demand" : "always"}
      >
        <Environment />
        <ambientLight intensity={0.35} />
        <directionalLight position={[2.4, 3, 4]} intensity={2.4} color="#d3dbff" />
        <pointLight position={[-2.4, 0.6, 1.8]} intensity={6} color="#8b7bff" distance={9} />
        <Cog reduced={reduced} />
      </Canvas>
    </div>
  );
}
