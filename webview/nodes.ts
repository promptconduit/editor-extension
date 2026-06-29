// Node meshes: a low-poly solid core with a Fresnel rim (glows into bloom) plus
// an additive wireframe overlay. Agents are larger icosahedra; sub-agents are
// smaller octahedra. Each spawns in (scale 0→1 with overshoot) when its playback
// time arrives, then bobs gently. The core meshes are the only raycast targets.
import * as THREE from "three";
import { rimVertex, rimFragment } from "./shaders";
import { nodeColor } from "./theme";
import type { GraphNode } from "../src/visualizer/types";

const SPAWN_MS = 650;

function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export class NodeView {
  readonly group = new THREE.Group();
  readonly core: THREE.Mesh;
  readonly id: string;
  readonly node: GraphNode;
  private rimMat: THREE.ShaderMaterial;
  private wire: THREE.LineSegments;
  private baseY: number;
  private phase: number;
  private spawnAt = 0; // playback ms when this node appears

  constructor(node: GraphNode, position: THREE.Vector3) {
    this.id = node.id;
    this.node = node;
    this.group.position.copy(position);
    this.baseY = position.y;
    this.phase = hashPhase(node.id);

    const radius = node.kind === "subagent" ? 0.55 : node.kind === "agent" ? 1.0 : 0.8;
    const geo =
      node.kind === "subagent"
        ? new THREE.OctahedronGeometry(radius, 0)
        : new THREE.IcosahedronGeometry(radius, 0);
    const color = new THREE.Color(nodeColor(node.kind));

    this.rimMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: color },
        uIntensity: { value: 1.0 },
      },
      vertexShader: rimVertex,
      fragmentShader: rimFragment,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.core = new THREE.Mesh(geo, this.rimMat);
    this.core.userData.nodeId = node.id;

    this.wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );

    this.group.add(this.core, this.wire);
    this.group.scale.setScalar(0.0001);
  }

  setSpawnTime(p: number): void {
    this.spawnAt = p;
  }

  worldPos(target: THREE.Vector3): THREE.Vector3 {
    return this.group.getWorldPosition(target);
  }

  update(pt: number, t: number, reducedMotion: boolean): void {
    const since = pt - this.spawnAt;
    const visible = since >= 0;
    this.group.visible = visible;
    if (!visible) return;

    const k = since < SPAWN_MS ? easeOutBack(Math.max(0, since) / SPAWN_MS) : 1;
    this.group.scale.setScalar(Math.max(0.0001, k));

    if (reducedMotion) {
      this.rimMat.uniforms.uIntensity.value = 1.0;
      return;
    }
    // Gentle bob + breathing rim, de-phased per node.
    this.group.position.y = this.baseY + Math.sin(t * 0.8 + this.phase) * 0.12;
    this.core.rotation.y = t * 0.15 + this.phase;
    this.core.rotation.x = t * 0.08;
    this.wire.rotation.copy(this.core.rotation);
    this.rimMat.uniforms.uIntensity.value = 0.9 + Math.sin(t * 1.6 + this.phase) * 0.25;
  }

  dispose(): void {
    this.core.geometry.dispose();
    this.rimMat.dispose();
    this.wire.geometry.dispose();
    (this.wire.material as THREE.Material).dispose();
  }
}

/**
 * Lay out the graph: session above, lead agent at the origin, sub-agents on a
 * fibonacci-sphere shell around the agent. Returns a NodeView per node id.
 */
export function layoutNodes(nodes: GraphNode[]): Map<string, NodeView> {
  const views = new Map<string, NodeView>();
  const subs = nodes.filter((n) => n.kind === "subagent");
  const subPos = fibonacciShell(subs.length, 6.5);

  let si = 0;
  for (const n of nodes) {
    let pos: THREE.Vector3;
    if (n.kind === "session") pos = new THREE.Vector3(0, 6.5, 0);
    else if (n.kind === "agent") pos = new THREE.Vector3(0, 0, 0);
    else pos = subPos[si++] ?? new THREE.Vector3(0, 0, 0);
    views.set(n.id, new NodeView(n, pos));
  }
  return views;
}

// Points on a sphere shell, biased to the forward hemisphere so they face the
// camera's default framing rather than hiding behind the agent.
function fibonacciShell(n: number, radius: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0.2 : 1 - (i / Math.max(1, n - 1)) * 1.4; // -0.4..1
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push(new THREE.Vector3(Math.cos(theta) * r, y * 0.7, Math.sin(theta) * r).multiplyScalar(radius));
  }
  return out;
}

function hashPhase(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000 * Math.PI * 2;
}
