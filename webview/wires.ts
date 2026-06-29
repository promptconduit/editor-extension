// Spawn edges as arced tubes carrying a travelling energy band (the signature
// look). Each wire appears when its child node spawns and pulses parent→child.
import * as THREE from "three";
import { wireVertex, wireFragment } from "./shaders";
import { COLORS } from "./theme";
import type { GraphEdge } from "../src/visualizer/types";

export class WireView {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private spawnAt = 0;

  constructor(from: THREE.Vector3, to: THREE.Vector3) {
    // Bow the wire outward at its midpoint so it arcs rather than cutting straight.
    const mid = from.clone().lerp(to, 0.5);
    const lift = new THREE.Vector3(0, from.distanceTo(to) * 0.18 + 0.6, 0);
    mid.add(lift);
    const curve = new THREE.CatmullRomCurve3([from.clone(), mid, to.clone()]);
    const geo = new THREE.TubeGeometry(curve, 48, 0.045, 8, false);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBase: { value: new THREE.Color(COLORS.wireBase) },
        uPulse: { value: new THREE.Color(COLORS.wirePulse) },
        uSpeed: { value: 0.5 },
        uActivity: { value: 0 },
        uDir: { value: 1 },
      },
      vertexShader: wireVertex,
      fragmentShader: wireFragment,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.visible = false;
  }

  setSpawnTime(p: number): void {
    this.spawnAt = p;
  }

  /** Briefly brighten the wire when its child is doing work. */
  pulse(activity: number): void {
    this.mat.uniforms.uActivity.value = Math.min(1.5, activity);
  }

  update(pt: number, t: number): void {
    const visible = pt >= this.spawnAt;
    this.mesh.visible = visible;
    if (!visible) return;
    this.mat.uniforms.uTime.value = t;
    // Activity decays toward rest each frame; pulse() tops it back up.
    this.mat.uniforms.uActivity.value *= 0.96;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

export function buildWires(
  edges: GraphEdge[],
  pos: (id: string) => THREE.Vector3 | undefined,
): { edge: GraphEdge; view: WireView }[] {
  const out: { edge: GraphEdge; view: WireView }[] = [];
  for (const e of edges) {
    const a = pos(e.from);
    const b = pos(e.to);
    if (a && b) out.push({ edge: e, view: new WireView(a, b) });
  }
  return out;
}
