// Orchestration Theater — the browser-side three.js scene. Receives a Scene from
// the host, lays it out (session → agent → sub-agents), drives a playback clock,
// and renders glowing wireframe nodes, pulsing spawn wires, and instanced
// tool-call packets flying to a data cloud, all under a bloom pass. Hover a node
// for its GitHub issue/PR. The host owns data + network; this file owns pixels.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

import type { HostMessage, WebviewMessage, PlaybackMode } from "../src/visualizer/protocol";
import type { Scene as SceneData, GraphNode, ToolClass } from "../src/visualizer/types";
import { buildSchedule, PlaybackClock } from "../src/visualizer/schedule";
import { COLORS } from "./theme";
import { layoutNodes, NodeView } from "./nodes";
import { buildWires, WireView } from "./wires";
import { ToolPackets } from "./particles";
import { DataCloud } from "./dataCloud";
import { HoverCard } from "./hoverCard";
import { Transport } from "./transport";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void };
const vscode = acquireVsCodeApi();
const post = (msg: WebviewMessage): void => vscode.postMessage(msg);

window.addEventListener("error", (e) => post({ type: "log", level: "error", msg: String(e.message) }));

// ---- renderer / scene / camera -------------------------------------------------
const app = document.getElementById("app")!;

// Scene/camera need no GL context — build them unconditionally so the data layer
// and DOM chrome work even where WebGL is unavailable (e.g. headless CI).
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.bg);
scene.fog = new THREE.FogExp2(COLORS.bg, 0.014);
const sceneRoot = new THREE.Group();
scene.add(sceneRoot);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(2, 5, 22);

// The renderer/controls/composer DO need a GL context. Degrade gracefully if
// creation fails (no GPU / software GL disabled): the HUD, transport, and hover
// still work; we just don't draw the 3D scene.
let renderer: THREE.WebGLRenderer | undefined;
let controls: OrbitControls | undefined;
let composer: EffectComposer | undefined;
let glReady = false;

try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  app.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.4;
  controls.minDistance = 7;
  controls.maxDistance = 70;
  controls.target.set(4, 1, -1);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(
    new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.1, 0.5, 0.55),
  );
  glReady = true;
} catch (err) {
  post({ type: "log", level: "warn", msg: `WebGL unavailable: ${String(err)}` });
  showNoGl();
}

const frameClock = new THREE.Clock();
const hover = new HoverCard((url) => post({ type: "open_external", url }));

// ---- mutable scene state -------------------------------------------------------
let nodes = new Map<string, NodeView>();
let wires: { view: WireView; childId: string }[] = [];
let edgeByChild = new Map<string, WireView>();
let packets: ToolPackets | undefined;
let dataCloud: DataCloud | undefined;
let playback: PlaybackClock | undefined;
let nodeTargets: THREE.Object3D[] = [];
let transportRef: Transport | undefined;
let reducedMotion = false;
let running = true;
let sceneReadyPosted = false;

// ---- raycast hover -------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hoverDirty = false;
let lastRay = 0;

app.addEventListener("pointermove", (e) => {
  const rect = app.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  hoverDirty = true;
});
app.addEventListener("pointerleave", () => hover.hide());

function updateHover(t: number): void {
  if (!hoverDirty || t - lastRay < 0.05) return; // ~20fps cap
  lastRay = t;
  hoverDirty = false;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(nodeTargets, false);
  const hit = hits.find((h) => h.object.visible && h.object.parent?.visible);
  if (!hit) {
    hover.hide();
    return;
  }
  const id = hit.object.userData.nodeId as string;
  const view = nodes.get(id);
  if (!view) {
    hover.hide();
    return;
  }
  const p = view.worldPos(new THREE.Vector3()).project(camera);
  const x = (p.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-p.y * 0.5 + 0.5) * window.innerHeight;
  hover.show(view.node, x, y);
}

// ---- load a scene --------------------------------------------------------------
function clearScene(): void {
  for (const v of nodes.values()) {
    sceneRoot.remove(v.group);
    v.dispose();
  }
  for (const w of wires) {
    sceneRoot.remove(w.view.mesh);
    w.view.dispose();
  }
  if (packets) {
    sceneRoot.remove(packets.mesh);
    packets.dispose();
  }
  if (dataCloud) {
    scene.remove(dataCloud.group);
    dataCloud.dispose();
  }
  nodes = new Map();
  wires = [];
  edgeByChild = new Map();
  nodeTargets = [];
}

function loadScene(data: SceneData, mode: PlaybackMode, isDemo: boolean): void {
  clearScene();
  const { graph, timeline } = data;
  const schedule = buildSchedule(timeline);

  playback = new PlaybackClock(schedule);
  transportRef = new Transport(playback, mode === "live");
  buildHud(graph.nodes, isDemo);

  // Without a GL context there's nothing to draw — the HUD/transport above are
  // the whole experience. Mark ready so the host/tests know the load completed.
  if (!glReady) {
    markReady("nogl");
    return;
  }

  nodes = layoutNodes(graph.nodes);
  for (const v of nodes.values()) {
    v.setSpawnTime(schedule.nodeSpawn.get(v.id) ?? schedule.sessionStart);
    sceneRoot.add(v.group);
    nodeTargets.push(v.core);
  }

  const built = buildWires(graph.edges, (id) => nodes.get(id)?.group.position);
  for (const b of built) {
    b.view.setSpawnTime(schedule.nodeSpawn.get(b.edge.to) ?? 0);
    sceneRoot.add(b.view.mesh);
    wires.push({ view: b.view, childId: b.edge.to });
    edgeByChild.set(b.edge.to, b.view);
  }

  dataCloud = new DataCloud();
  scene.add(dataCloud.group);

  packets = new ToolPackets();
  packets.load(
    graph.toolCalls,
    (nodeId) => nodes.get(nodeId)?.group.position.clone() ?? new THREE.Vector3(),
    (cls: ToolClass) => dataCloud!.lobeFor(cls),
    schedule.toolStart,
    schedule.toolEnd,
  );
  sceneRoot.add(packets.mesh);
}

function buildHud(graphNodes: GraphNode[], isDemo: boolean): void {
  const hud = document.getElementById("hud")!;
  hud.replaceChildren();
  const session = graphNodes.find((n) => n.kind === "session");
  const agent = graphNodes.find((n) => n.kind === "agent");
  hud.appendChild(el("div", "title", "Orchestration Theater"));
  hud.appendChild(el("div", "session", agent?.label || session?.label || "Session"));
  const legend = document.createElement("div");
  legend.className = "legend";
  const items: [ToolClass | "agent" | "subagent", string][] = [
    ["file", "file"],
    ["web", "web"],
    ["cloud", "cloud · MCP"],
    ["shell", "shell"],
    ["subagent", "sub-agent"],
  ];
  for (const [key, label] of items) {
    const row = document.createElement("div");
    row.className = "row";
    const sw = document.createElement("span");
    sw.className = "sw";
    const color = (COLORS as Record<string, number>)[key] ?? COLORS.other;
    sw.style.color = `#${color.toString(16).padStart(6, "0")}`;
    sw.style.background = sw.style.color;
    row.append(sw, document.createTextNode(label));
    legend.appendChild(row);
  }
  hud.appendChild(legend);
  hud.classList.remove("hidden");
  document.getElementById("demo")!.classList.toggle("hidden", !isDemo);
}

// ---- render loop ---------------------------------------------------------------
function animate(): void {
  requestAnimationFrame(animate);
  const dt = frameClock.getDelta(); // consume every frame to avoid jumps after pause
  const t = frameClock.getElapsedTime();
  if (!running || !glReady) return;

  controls?.update();

  if (playback) {
    playback.tick(dt * 1000);
    const pt = playback.time;
    for (const v of nodes.values()) v.update(pt, t, reducedMotion);
    for (const w of wires) w.view.update(pt, t);
    dataCloud?.update(t, reducedMotion);
    if (packets) {
      for (const id of packets.update(pt)) edgeByChild.get(id)?.pulse(0.9);
    }
    transportRef?.update();
  }

  updateHover(t);
  composer?.render();
  markReady("1");
}

function markReady(state: string): void {
  if (sceneReadyPosted) return;
  sceneReadyPosted = true;
  document.body.setAttribute("data-scene-ready", state);
  post({ type: "scene_ready" });
}

function showNoGl(): void {
  const note = document.createElement("div");
  note.textContent = "3D rendering isn't available in this environment.";
  note.style.cssText =
    "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:13px;";
  document.getElementById("app")?.appendChild(note);
}

// ---- host messages -------------------------------------------------------------
window.addEventListener("message", (e: MessageEvent<HostMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case "load":
      reducedMotion = msg.reducedMotion || prefersReducedMotion();
      if (controls) controls.autoRotate = !reducedMotion;
      loadScene(msg.scene, msg.mode, msg.isDemo);
      break;
    case "graph_patch":
      loadScene(msg.scene, "live", false);
      break;
    case "transport":
      applyTransport(msg);
      break;
    case "visibility":
      running = msg.visible;
      break;
  }
});

function applyTransport(msg: Extract<HostMessage, { type: "transport" }>): void {
  if (!playback) return;
  if (msg.action === "play") playback.play();
  else if (msg.action === "pause") playback.pause();
  else if (msg.action === "seek" && msg.value !== undefined) playback.seekFrac(msg.value);
  else if (msg.action === "speed" && msg.value !== undefined) playback.setSpeed(msg.value);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer?.setSize(window.innerWidth, window.innerHeight);
  composer?.setSize(window.innerWidth, window.innerHeight);
});

function el(tag: string, cls: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}

animate();
post({ type: "ready" });
