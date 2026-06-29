// The glowing 3D "data cloud" tool calls reach out to. A drifting additive
// point nebula wrapped in a faint wireframe shell, with three sub-lobes (disk /
// globe / API) so the eye can read where each tool class is headed. Shell tool
// calls don't reach the cloud — they burst locally near the agent.
import * as THREE from "three";
import { COLORS } from "./theme";
import type { ToolClass } from "../src/visualizer/types";

const CENTER = new THREE.Vector3(13, 1.5, -3);

// Where each class' packets fly to. Shell stays local (a burst by the agent).
const LOBES: Record<ToolClass, THREE.Vector3> = {
  file: CENTER.clone().add(new THREE.Vector3(-2.6, -1.6, 0.4)),
  web: CENTER.clone().add(new THREE.Vector3(0.2, 2.6, -0.2)),
  cloud: CENTER.clone().add(new THREE.Vector3(2.6, -1.0, 1.0)),
  shell: new THREE.Vector3(2.4, 1.6, 1.2),
  spawn: CENTER.clone(),
  other: CENTER.clone(),
};

function sprite(): THREE.Texture {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(186,247,255,0.6)");
  g.addColorStop(1, "rgba(186,247,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class DataCloud {
  readonly group = new THREE.Group();
  private points: THREE.Points;
  private shell: THREE.LineSegments;
  private texture: THREE.Texture;
  private mat: THREE.PointsMaterial;

  constructor(count = 1400) {
    this.texture = sprite();
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Cluster toward the centre, with a few outliers — a soft nebula.
      const r = 3.4 * Math.cbrt(rand());
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.8;
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.mat = new THREE.PointsMaterial({
      size: 0.5,
      map: this.texture,
      color: COLORS.cloudCore,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, this.mat);

    const shellGeo = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(3.8, 1));
    this.shell = new THREE.LineSegments(
      shellGeo,
      new THREE.LineBasicMaterial({
        color: COLORS.cloudHalo,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );

    this.group.add(this.points, this.shell);
    this.group.position.copy(CENTER);
  }

  lobeFor(cls: ToolClass): THREE.Vector3 {
    return LOBES[cls] ?? CENTER;
  }

  update(t: number, reducedMotion: boolean): void {
    if (reducedMotion) return;
    this.points.rotation.y = t * 0.04;
    this.shell.rotation.y = -t * 0.03;
    this.shell.rotation.x = Math.sin(t * 0.15) * 0.1;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
    this.texture.dispose();
    this.shell.geometry.dispose();
    (this.shell.material as THREE.Material).dispose();
  }
}

// Deterministic-ish PRNG so the nebula looks the same each load (no Math.random
// dependence for visual stability across reloads).
let seed = 0x2f6e2b1;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
}
