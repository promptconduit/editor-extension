// Tool-call packets, all in one InstancedMesh (one draw call). Each call sends an
// outbound packet from its agent to the data-cloud lobe for its class, then a
// return packet when it completes (return size scales with response bytes).
// Position is a pure function of playback time, so scrubbing/seeking just works.
import * as THREE from "three";
import { toolColor } from "./theme";
import type { ToolCall } from "../src/visualizer/types";

const TRAVEL_MS = 750;
const CAP = 4096;

interface Packet {
  call: ToolCall;
  src: THREE.Vector3;
  lobe: THREE.Vector3;
  ctrl: THREE.Vector3;
  color: THREE.Color;
  startP: number; // outbound start (playback ms)
  endP: number; // return start (playback ms)
  returnScale: number;
}

function quad(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  const u = 1 - t;
  return out
    .copy(a)
    .multiplyScalar(u * u)
    .addScaledVector(c, 2 * u * t)
    .addScaledVector(b, t * t);
}

export class ToolPackets {
  readonly mesh: THREE.InstancedMesh;
  private packets: Packet[] = [];
  private dummy = new THREE.Object3D();
  private pos = new THREE.Vector3();

  constructor(capacity = CAP) {
    const geo = new THREE.OctahedronGeometry(0.16, 0);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  load(
    calls: ToolCall[],
    srcOf: (nodeId: string) => THREE.Vector3,
    lobeOf: (cls: ToolCall["cls"]) => THREE.Vector3,
    toolStart: Map<string, number>,
    toolEnd: Map<string, number>,
  ): void {
    this.packets = [];
    for (const call of calls) {
      const startP = toolStart.get(call.id);
      if (startP === undefined) continue;
      const src = srcOf(call.nodeId).clone();
      const lobe = lobeOf(call.cls).clone();
      const ctrl = src
        .clone()
        .lerp(lobe, 0.5)
        .add(new THREE.Vector3(0, src.distanceTo(lobe) * 0.22 + 1.0, 0));
      const sz = call.sizeBytes ?? 0;
      this.packets.push({
        call,
        src,
        lobe,
        ctrl,
        color: new THREE.Color(toolColor(call.cls)),
        startP,
        endP: toolEnd.get(call.id) ?? startP + TRAVEL_MS,
        returnScale: 1 + Math.min(1.6, Math.log10(1 + sz) / 3),
      });
    }
  }

  /** Render active packets for playback time `pt`; returns busy source node ids. */
  update(pt: number): Set<string> {
    const busy = new Set<string>();
    let n = 0;
    const cap = this.mesh.count !== undefined ? (this.mesh.instanceMatrix.count as number) : CAP;

    for (const p of this.packets) {
      // Outbound: src → lobe over TRAVEL_MS from the call's start.
      const out = (pt - p.startP) / TRAVEL_MS;
      if (out >= 0 && out < 1 && n < cap) {
        quad(p.src, p.ctrl, p.lobe, out, this.pos);
        this.place(n++, this.pos, 0.18 + Math.sin(out * Math.PI) * 0.12, p.color);
        busy.add(p.call.nodeId);
      }
      // Return: lobe → src over TRAVEL_MS from the call's end (data coming back).
      const back = (pt - p.endP) / TRAVEL_MS;
      if (back >= 0 && back < 1 && n < cap) {
        quad(p.lobe, p.ctrl, p.src, back, this.pos);
        this.place(n++, this.pos, (0.18 + Math.sin(back * Math.PI) * 0.12) * p.returnScale, p.color);
        busy.add(p.call.nodeId);
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return busy;
  }

  private place(i: number, position: THREE.Vector3, scale: number, color: THREE.Color): void {
    this.dummy.position.copy(position);
    this.dummy.scale.setScalar(scale);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.setColorAt(i, color);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
