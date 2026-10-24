import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { createInteraction } from "./interaction.js";
import { addBackdrop } from "./backdrop.js";
import { addWeather } from "./weather.js";
import { createIslandCards } from "./dot-code-2/dot-code-2.js";
import { createRailparkLife } from "./railpark-life.mjs";
const railparkControllers = new Map();
function bindRailpark(instance) {
  if (!instance?.getObjectByName("RailparkSwingPivot")) return instance;
  railparkControllers.set(instance, createRailparkLife(instance));
  return instance;
}
let dotCards = null;
import { createLonglongDialogue } from "./dot-longlong-dialogue.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { addSceneExtras } from "./dot-scene-extras.js";
import { addRiver } from "./river.js";
import { addTraffic } from "./dot-traffic.js";
import {createActors,createStreetMotion,createSimulatedGreeting,turn as smoothTurn} from './dot-motion.js';
import {createIslandLife,createTicker} from './dot-island-life.js';
const actors=createActors();
let life=null;
let feel=null;

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const mobile = () => innerWidth <= 760;

// ── 島嶼配置：pointy-top 六角格 axial 座標。中央是高雄市議會（質詢島），其他島環繞 ──
// 內圈：日常最常碰到的政見島；外圈依主題分區（北交通、東商圈文史〔鳳山溪對岸〕、西公園平權、南校園兒少），
// 刻意留幾格海面，讓島群不要太密。
const R = 10;
const LAYOUT = {
  Q1: [[0, 0]],                                 // 中央：高雄市議會
  W1: [[-1, 0]],                                // 議會旁：性別友善島（鳳山婦幼青少年活動中心）
  P02: [[0, -1], [0, -2]], P05: [[1, -1]], P09: [[1, 0]], P08: [[0, 1]], P12: [[-1, 1]],
  P01: [[1, -2]], P04: [[2, -2]], P06: [[2, -1], [3, -1], [3, -2]], P10: [[2, 0]], P07: [[3, 0]],
  P03: [[-1, -1], [-2, -1]], X2: [[-2, 0], [-3, 1], [-3, 0], [-3, 2]], X3: [[-2, 1]],
  P11: [[1, 1]], P13: [[0, 2]], X1: [[-1, 2]], X4: [[-1, 3]],
  LCG: [[2, 1]],  // 五甲龍成宮：鳳山溪出海口東側
};
const AXIS_COLOR = { A1: "#4f9fc4", A2: "#e4994a", A3: "#e48f9e", A4: "#8f84cf", AX: "#6fae6a", AQ: "#075548" };
const GRASS = { A1: "#cfe8d8", A2: "#f2e3bf", A3: "#f6dcd8", A4: "#e2def3", AX: "#d3e9c4", AQ: "#d9ece5" };
const LAYERS = ["政績", "會勘"];

const SPACING = 1.42;  // 格與格之間留一段水道（HEART 的做法），橋只跨水道
const hexToWorld = (q, r) => new THREE.Vector3(R * Math.sqrt(3) * (q + r / 2), 0, R * 1.5 * r).multiplyScalar(SPACING);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 資料 ────────────────────────────────────────────────────────
const data = await fetch("./island-data.json", { cache: "no-cache" }).then((r) => r.json());
// 鳳山景色地標（landmarks.js）；載不到就用預設造型
const scenery = await import("./landmarks.js").catch(() => null);

// Colab 生成的精細模型（models/manifest.json）；有模型就用，沒有就用程式造型
const glbModels = { landmarks: {}, templates: {}, character: {}, props: {}, people: {}, town: {}, vehicles: {}, boats: {}, bridges: {}, surroundings: {} };
{
  // 各生成流程各寫一份清單，避免互相覆蓋；這裡合併讀取
  const parts = await Promise.all(["manifest", "manifest-landmarks", "manifest-templates", "manifest-characters", "manifest-gpt", "manifest-people", "manifest-city", "manifest-landmarks2", "manifest-templates2", "manifest-surroundings"]
    .map((n) => fetch(`./models/${n}.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  const manifest = {};
  for (const part of parts.filter(Boolean)) for (const [kind, list] of Object.entries(part)) Object.assign(manifest[kind] ||= {}, list);
  if (Object.keys(manifest).length) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const jobs = [];
    // 載入進度：每個模型最多等 20 秒，逾時就用程式造型代替，不卡住整座島
    const bar = $("#loading-bar"), txt = $("#loading-text");
    let done = 0, total = 0;
    const tick = () => { done++; if (bar) bar.style.width = `${Math.round((done / total) * 100)}%`; if (txt) txt.textContent = `小島建造中… ${done}／${total}`; };
    const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("逾時")), 20000))]);
    for (const kind of ["landmarks", "templates", "character", "props", "people", "town", "vehicles", "boats", "bridges", "surroundings"]) {
      for (const [id, m] of Object.entries(manifest[kind] || {})) {
        total++;
        jobs.push(withTimeout(loader.loadAsync(`./models/${m.file}`)).then((gltf) => {
          gltf.scene.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = true;
            o.receiveShadow = true;
            // 生成模型常把 metallic 設成 1，沒有環境貼圖時會發黑，改成非金屬
            for (const m of [].concat(o.material || [])) { m.metalness = 0; m.roughness = Math.max(m.roughness ?? 1, 0.75); }
          });
          actors.remember(kind,id,gltf);
      glbModels[kind][id] = gltf.scene;
          gltf.scene.userData.clips = gltf.animations || [];  // 走路等動畫片段
        }).catch((err) => console.warn("模型載入失敗", id, err)).finally(tick));
      }
    }
    await Promise.all(jobs);
  }
}
const mixers = [];
const glbClone = (kind,id,scale=1) => bindRailpark(actors.clone(kind,id,scale));
// 陳慧文站路口：揮手動畫（glTF 的 wave 片段）每隔幾秒揮一次，點一下馬上揮
let cornerWave = null;
function setupCornerWave(root, clips) {
  const clip = clips.find((c) => c.name.toLowerCase() === "wave");
  if (!clip) return;
  const mixer = new THREE.AnimationMixer(root.children[0] || root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = false;
  cornerWave = { root, mixer, action, wait: 1.5,
    play() { action.reset().play(); this.wait = 7; },
    update(dt, still) { if (still) return; this.wait -= dt; if (this.wait <= 0) this.play(); mixer.update(dt); } };
}
const islands = data.islands.filter((i) => LAYOUT[i.id]);
const islandById = Object.fromEntries(islands.map((i) => [i.id, i]));
const axisById = Object.fromEntries(data.axes.map((a) => [a.id, a]));
const itemsByIsland = {};
data.items.forEach((it, n) => { (itemsByIsland[it.i] ||= []).push(n); });
const interp = data.interpellations || null;

// ── 場景 ────────────────────────────────────────────────────────
const canvas = $("#scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile() });
renderer.setPixelRatio(Math.min(devicePixelRatio, mobile() ? 1.25 : 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color("#bfe3e2");

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 1000);
camera.position.set(70, 95, 120);
camera.zoom = 1;

// 地標正面轉向預設鏡頭方位的七成：正面為主，仍看得到一點側面
const FACE_CAMERA = Math.atan2(camera.position.x, camera.position.z) * 0.7;
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minZoom = 0.7;
controls.maxZoom = 5;
controls.minPolarAngle = 0.45;
controls.maxPolarAngle = 1.1;
controls.screenSpacePanning = false;

const hemi = new THREE.HemisphereLight("#fffdf2", "#7fb8b3", 1.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight("#fff3dc", 2.2);
sun.position.set(-60, 120, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(mobile() ? 1024 : 2048, mobile() ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -135, right: 135, top: 135, bottom: -135, near: 1, far: 400 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const sea = new THREE.Mesh(new THREE.CircleGeometry(400, 64), new THREE.MeshStandardMaterial({ color: "#a9d9d8", roughness: 1 }));
sea.rotation.x = -Math.PI / 2;
sea.position.y = -1.6;
sea.receiveShadow = true;
scene.add(sea);

const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true, ...opts }));
  return matCache.get(key);
}
function mesh(geo, color, opts) {
  const m = new THREE.Mesh(geo, mat(color, opts));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
const box = (w, h, d, color, x = 0, y = 0, z = 0, opts) => {
  const m = mesh(new THREE.BoxGeometry(w, h, d), color, opts);
  m.position.set(x, y + h / 2, z);
  return m;
};
const cyl = (rt, rb, h, seg, color, x = 0, y = 0, z = 0, opts) => {
  const m = mesh(new THREE.CylinderGeometry(rt, rb, h, seg), color, opts);
  m.position.set(x, y + h / 2, z);
  return m;
};
const turn = (m, axis, a) => ((m.rotation[axis] = a), m);
const cone = (r, h, seg, color, x = 0, y = 0, z = 0) => {
  const m = mesh(new THREE.ConeGeometry(r, h, seg), color);
  m.position.set(x, y + h / 2, z);
  return m;
};

// 亮燈窗戶：完成的建築窗戶發光
function windows(g, w, h, d, y0, rows, done) {
  const color = done ? "#ffd75e" : "#9fb7bf";
  const opts = done ? { emissive: "#ffc93c", emissiveIntensity: 0.9 } : {};
  const cols = Math.max(1, Math.round(w / 0.7));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = -w / 2 + (c + 0.5) * (w / cols);
    const win = box(0.32, 0.36, 0.05, color, x, y0 + r * (h / rows) + 0.2, d / 2 + 0.02, opts);
    win.castShadow = false;
    g.add(win);
  }
}
function tree(g, x, z, s = 1, color = "#5d9c5a") {
  g.add(cyl(0.12 * s, 0.15 * s, 0.6 * s, 5, "#8a6a4a", x, 0, z));
  g.add(cone(0.6 * s, 1.5 * s, 6, color, x, 0.5 * s, z));
}
function flag(g, x, y, z, color = "#f3d36a", h = 2.2) {
  g.add(cyl(0.05, 0.05, h, 4, "#4b5a56", x, y, z));
  const f = box(0.9, 0.5, 0.04, color, x + 0.47, y + h - 0.6, z);
  f.castShadow = false;
  g.add(f);
}

// ── 建築模板 ─────────────────────────────────────────────────────
const TEMPLATES = {
  office(g, done) {
    g.add(box(2, 3.2, 1.8, "#f4efe4"));
    g.add(box(2.2, 0.25, 2, "#c9bfae", 0, 3.2));
    windows(g, 2, 3, 1.8, 0.2, 3, done);
  },
  school(g, done) {
    g.add(box(3, 1.8, 1.6, "#f1e2c9"));
    g.add(box(0.9, 2.6, 0.9, "#e7d3b2", 0, 0, 0.1));
    g.add(turn(cone(0.75, 0.7, 4, "#c4553f", 0, 2.6, 0.1), "y", Math.PI / 4));
    windows(g, 3, 1.6, 1.6, 0.2, 2, done);
    g.add(box(2.6, 0.04, 1.2, "#d38b5d", 0, 0, 1.6));
  },
  station(g, done) {
    g.add(box(3.4, 0.4, 1.6, "#d8d2c6"));
    g.add(box(3.4, 0.15, 1.8, "#3f7f8a", 0, 1.6));
    for (const x of [-1.5, 1.5]) g.add(box(0.15, 1.2, 0.15, "#6b7b80", x, 0.4, 0));
    g.add(box(3.8, 0.12, 0.25, "#6b6b6b", 0, 0, 1.2));
    g.add(box(1.4, 0.8, 0.7, done ? "#ffd75e" : "#e9e4d8", 0, 0.4, -0.2, done ? { emissive: "#ffc93c", emissiveIntensity: 0.6 } : {}));
  },
  bridge(g, done) {
    g.add(box(4, 0.04, 1.4, "#7cc3d0", 0, 0, 0));
    for (const x of [-1.4, 1.4]) g.add(box(0.4, 0.7, 1, "#b9b2a6", x, 0, 0));
    g.add(box(4, 0.25, 1.1, "#8c8a86", 0, 0.7, 0));
    for (const z of [-0.5, 0.5]) g.add(box(4, 0.3, 0.06, done ? "#f3d36a" : "#d9d3c7", 0, 0.95, z, done ? { emissive: "#ffc93c", emissiveIntensity: 0.5 } : {}));
  },
  water(g, done) {
    g.add(cyl(1.4, 1.5, 0.3, 10, "#d9d0bd"));
    g.add(cyl(1.15, 1.15, 0.32, 10, "#6fbcd0", 0, 0.02));
    g.add(box(0.8, 0.9, 0.7, "#eae3d4", 1.3, 0, -0.9));
    windows(g, 0.8, 0.7, 0.7, 0.1, 1, done);
  },
  park(g, done) {
    g.add(cyl(1.6, 1.6, 0.12, 12, "#9fd08a"));
    tree(g, -0.8, -0.5, 1, "#4f9a55");
    tree(g, 0.9, -0.3, 0.8, "#6fb15e");
    tree(g, 0.1, 0.8, 0.9, "#4f9a55");
    g.add(box(0.8, 0.25, 0.3, "#c08b5c", -0.4, 0.12, 0.3));
    if (done) g.add(cyl(0.08, 0.08, 1.4, 4, "#4b5a56", 1, 0.1, 0.9), cyl(0.18, 0.18, 0.18, 6, "#ffd75e", 1, 1.5, 0.9, { emissive: "#ffc93c", emissiveIntensity: 1 }));
  },
  market(g, done) {
    g.add(box(2.6, 1.4, 1.6, "#f3e7d3"));
    for (let i = 0; i < 6; i++) g.add(turn(box(0.44, 0.12, 0.8, i % 2 ? "#ffffff" : "#e4994a", -1.1 + i * 0.44, 1.2, 1.1), "x", -0.35));
    g.add(box(2.8, 0.2, 1.8, "#c9bfae", 0, 1.4));
    windows(g, 2.6, 1, 1.6, 0.15, 1, done);
  },
  care(g, done) {
    g.add(box(2.2, 1.6, 1.8, "#ffffff"));
    g.add(turn(cone(1.7, 0.9, 4, "#e48f9e", 0, 1.6), "y", Math.PI / 4));
    g.add(box(0.5, 0.14, 0.04, "#2f9e6f", 0, 1, 0.93), box(0.14, 0.5, 0.04, "#2f9e6f", 0, 0.82, 0.93));
    windows(g, 2.2, 0.5, 1.8, 0.2, 1, done);
  },
  culture(g, done) {
    g.add(box(2.4, 1.2, 1.8, "#efe0c8"));
    g.add(turn(cone(1.9, 0.6, 4, "#a8483a", 0, 1.2), "y", Math.PI / 4));
    g.add(box(1.4, 0.7, 1.1, "#efe0c8", 0, 1.6));
    g.add(turn(cone(1.2, 0.6, 4, "#a8483a", 0, 2.3), "y", Math.PI / 4));
    windows(g, 2.4, 0.9, 1.8, 0.15, 1, done);
  },
  road(g, done) {
    g.add(box(3.6, 0.06, 1.4, "#5f6669"));
    for (let i = 0; i < 5; i++) g.add(box(0.18, 0.07, 1, "#f5f1e6", -0.9 + i * 0.45, 0, 0));
    g.add(cyl(0.05, 0.05, 1.8, 4, "#4b5a56", 1.6, 0, -0.9));
    g.add(box(0.35, 0.12, 0.2, done ? "#ffd75e" : "#cfd8d6", 1.45, 1.8, -0.9, done ? { emissive: "#ffc93c", emissiveIntensity: 1 } : {}));
  },
};

// 島中央地標：政見島＝承諾塔、政績島＝里程碑、質詢島＝議事堂
function landmark(island) {
  const g = new THREE.Group();
  const accent = AXIS_COLOR[island.axis];
  if (island.kind === "interpellation") {
    g.add(box(5, 0.5, 3.6, "#e9e4d8"));
    g.add(box(4.4, 2.4, 3, "#f7f3ea", 0, 0.5));
    for (let i = 0; i < 6; i++) g.add(cyl(0.16, 0.16, 2.2, 8, "#ffffff", -1.9 + i * 0.76, 0.5, 1.7));
    g.add(box(4.8, 0.3, 3.6, "#cfc6b4", 0, 2.9));
    const dome = mesh(new THREE.SphereGeometry(1.2, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), "#075548");
    dome.position.y = 3.2;
    g.add(dome);
    flag(g, 0, 4.3, 0, "#f3d36a", 1.6);
    return g;
  }
  if (island.kind === "achievement") {
    g.add(cyl(1.6, 1.8, 0.5, 6, "#e9e4d8"));
    g.add(box(1, 4.2, 1, accent, 0, 0.5));
    g.add(turn(cone(0.75, 0.9, 4, "#f3d36a", 0, 4.7), "y", Math.PI / 4));
    return g;
  }
  g.add(cyl(2, 2.3, 0.6, 6, "#e9e4d8"));
  g.add(box(2.2, 3.6, 2.2, "#fffaf0", 0, 0.6));
  g.add(box(2.5, 0.35, 2.5, accent, 0, 4.2));
  g.add(box(1.5, 1.4, 1.5, "#fffaf0", 0, 4.55));
  g.add(turn(cone(1.25, 1.3, 4, accent, 0, 5.95), "y", Math.PI / 4));
  windows(g, 2.2, 3.2, 2.2, 0.5, 3, true);
  flag(g, 0, 7.2, 0, "#f3d36a", 1.8);
  return g;
}

// ── 建島（參考 HEART：島與島之間留水道，外圈環島道路、內圈建築格位，橋只接道路）──
const world = new THREE.Group();
scene.add(world);
const pickables = [];
const islandCenter = {};
const flagshipGroups = [];
const spotLabels = [];  // 島上第二格的實景地標名牌（美麗島雜誌社等）
// 第二格實景地標的介紹（名稱、地址、一句話）
const SPOT_INFO = {
  formosa: { name: "美麗島雜誌社", addr: "新興區中山一路53號", note: "1979 年美麗島事件的起點，高雄民主運動的歷史現場，也是賴瑞隆長年關注的轉型正義記憶。" },
  railpark: { name: "臺鐵高雄機廠舊址親子遊樂區", addr: "輜汽路（臺鐵高雄機廠舊址）", note: "舊廠房改造成鐵道主題遊戲區，天車、桁架下有滑梯、鳥巢鞦韆與腳踏軌道車。" },
  "chengcing-lake": { name: "澄清湖", addr: "鳥松區大埤路32號", note: "高雄的大水缸，中興塔與九曲橋是幾代人的郊遊記憶，環湖步道串起鳳山與鳥松。" },
  "chengcing-baseball": { name: "澄清湖棒球場", addr: "鳥松區大埤路113號", note: "兩萬席的國際棒球場，整修後重新成為南臺灣職棒與國際賽的主場。" },
  "guoling-park": { name: "果嶺公園", addr: "鳥松區澄清湖畔（原高爾夫球場）", note: "原高爾夫球場開放成市民公園，起伏的果嶺草坡、老樹與木球場地保留下來。" },
};
const walkers = [];
const cars = [];

const allCells = Object.values(LAYOUT).flat().map(([q, r]) => hexToWorld(q, r));
const mid = hexToWorld(0, 0);  // 以中央的議會為原點
const cellPos = (q, r) => hexToWorld(q, r).sub(mid);

// 六角環：pointy-top，頂點朝 ±z；u ∈ [0, 6) 沿邊走一圈
const SQ3 = Math.sqrt(3);
const hexCorner = (rad, k) => new THREE.Vector3(Math.sin((k * Math.PI) / 3) * rad, 0, Math.cos((k * Math.PI) / 3) * rad);
const hexPoint = (c, rad, u) => {
  const k = Math.floor(u) % 6, f = u - Math.floor(u);
  return hexCorner(rad, k).lerp(hexCorner(rad, k + 1), f).add(c);
};
function hexRing(rOut, rIn) {
  const pos = [], idx = [];
  for (let k = 0; k < 6; k++) {
    const o = hexCorner(rOut, k), i = hexCorner(rIn, k);
    pos.push(o.x, 0, o.z, i.x, 0, i.z);
    const n = k * 2, m = ((k + 1) % 6) * 2;
    idx.push(n, m, n + 1, n + 1, m, m + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const insideHex = (x, z, rad) => Math.abs(x) <= rad * SQ3 / 2 && Math.abs(z) + Math.abs(x) / SQ3 <= rad;

// 地面材質：依主軸色加細小斑點，像草地／鋪面
const groundTex = {};
function groundMat(axis) {
  if (!groundTex[axis]) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const g2 = cv.getContext("2d");
    g2.fillStyle = GRASS[axis];
    g2.fillRect(0, 0, 128, 128);
    const r2 = rng(axis.charCodeAt(1) * 97);
    for (let i = 0; i < 900; i++) {
      g2.fillStyle = r2() < 0.5 ? "rgba(255,255,255,0.18)" : "rgba(60,90,60,0.10)";
      g2.fillRect(r2() * 128, r2() * 128, 2, 2);
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4, 4);
    t.colorSpace = THREE.SRGBColorSpace;
    groundTex[axis] = new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 });
  }
  return groundTex[axis];
}

const TOP = 0.5, ROAD_IN = 0.75 * R, ROAD_OUT = 0.9 * R, ROAD_MID = 0.825 * R, INNER = 0.72 * R;
const topGeo = new THREE.CircleGeometry(R, 6).rotateX(-Math.PI / 2).rotateY(Math.PI / 6);
const cliffGeo = new THREE.CylinderGeometry(R, R * 1.04, 3.6, 6, 1);
const roadGeo = hexRing(ROAD_OUT, ROAD_IN), walkGeo = hexRing(R * 0.985, ROAD_OUT), curbGeo = hexRing(ROAD_IN, ROAD_IN - 0.25);
const shallowGeo = hexRing(R * 1.16, R * 0.99);
const asphalt = mat("#6b7276"), paving = mat("#eadfca"), curbMat = mat("#d6cbb7");
const shallowMat = new THREE.MeshBasicMaterial({ color: "#cdeee9", transparent: true, opacity: 0.6, depthWrite: false });
const dashGeo = new THREE.BoxGeometry(0.9, 0.03, 0.16);
const dashMat = mat("#f6f1e2");

// 每格的建築格位：棋盤錯位排列，只放在內圈；第一格中央留給地標
function cellSlots(c, hero) {
  const out = [], step = 2.55;
  for (let zi = -3; zi <= 3; zi++) for (let xi = -3; xi <= 3; xi++) {
    const x = (xi + (Math.abs(zi) % 2 ? 0.5 : 0)) * step, z = zi * step * 0.92;
    if (!insideHex(x, z, ROAD_IN - 1.35)) continue;  // 不壓到環島道路
    if (hero && Math.hypot(x, z) < 4.4) continue;     // 中央留給地標
    out.push(new THREE.Vector3(c.x + x, 0, c.z + z));
  }
  return out.sort((a, b) => a.distanceTo(c) - b.distanceTo(c));
}

function townBlock(g, rand, accent) {
  const n = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const w = 0.7 + rand() * 0.45, d = 0.7 + rand() * 0.45, h = 0.7 + Math.floor(rand() * 4) * 0.7;
    const x = (i % 2 ? 0.5 : -0.5) + (rand() - 0.5) * 0.15, z = (i < 2 ? -0.5 : 0.5) + (rand() - 0.5) * 0.15;
    const col = ["#fbf5ea", "#f4ead8", "#eef3ee", "#f6e6dc", "#e9eef4"][Math.floor(rand() * 5)];
    g.add(box(w, h, d, col, x, 0, z));
    if (h < 1.2) g.add(turn(cone(Math.max(w, d) * 0.72, 0.5, 4, accent, x, h, z), "y", Math.PI / 4));
    else {
      g.add(box(w + 0.06, 0.1, d + 0.06, "#cfc6b4", x, h, z));
      for (let f = 0; f < Math.round(h / 0.75); f++) {
        const win = box(w * 0.7, 0.18, 0.04, "#9fb7bf", x, 0.35 + f * 0.75, z + d / 2 + 0.01);
        win.castShadow = false;
        g.add(win);
      }
    }
  }
}

for (const island of islands) {
  const cells = LAYOUT[island.id].map(([q, r]) => cellPos(q, r));
  const rand = rng([...island.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  islandCenter[island.id] = cells.reduce((a, v) => a.clone().add(v), new THREE.Vector3()).divideScalar(cells.length);
  const accent = AXIS_COLOR[island.axis];

  cells.forEach((c, ci) => {
    const cellKey = LAYOUT[island.id][ci].join(",");
    const cliff = new THREE.Mesh(cliffGeo, mat("#e6d6b4"));
    cliff.position.set(c.x, TOP - 1.8, c.z);
    const band = new THREE.Mesh(hexRing(R * 1.005, R * 0.9), mat(accent));
    band.position.set(c.x, TOP - 0.02, c.z);
    const top = new THREE.Mesh(topGeo, groundMat(island.axis));
    top.position.set(c.x, TOP, c.z);
    const road = new THREE.Mesh(roadGeo, asphalt);
    road.position.set(c.x, TOP + 0.03, c.z);
    const walk = new THREE.Mesh(walkGeo, paving);
    walk.position.set(c.x, TOP + 0.07, c.z);
    const curb = new THREE.Mesh(curbGeo, curbMat);
    curb.position.set(c.x, TOP + 0.08, c.z);
    const shallow = new THREE.Mesh(shallowGeo, shallowMat);
    shallow.position.set(c.x, -0.95, c.z);
    for (const m of [cliff, top, road, walk, curb]) { m.receiveShadow = true; m.userData = { island: island.id }; }
    cliff.castShadow = true;
    world.add(cliff, band, top, road, walk, curb, shallow);
    pickables.push(cliff, top);
    // 車道虛線
    for (let u = 0; u < 6; u += 0.25) {
      const p0 = hexPoint(c, ROAD_MID, u), p1 = hexPoint(c, ROAD_MID, u + 0.01);
      const dash = new THREE.Mesh(dashGeo, dashMat);
      dash.position.set(p0.x, TOP + 0.05, p0.z);
      dash.rotation.y = -Math.atan2(p1.z - p0.z, p1.x - p0.x);
      world.add(dash);
    }
    // 環島道路上的車與人行道上的居民
    for (let k = 0; k < 2; k++) {
      const vehicleIds = Object.keys(glbModels.vehicles);
      let car;
      if (vehicleIds.length) car = glbClone("vehicles", vehicleIds[Math.floor(rand() * vehicleIds.length)], 0.6);
      else {
        car = new THREE.Group();
        const col = ["#e4994a", "#4f9fc4", "#f3d36a", "#e48f9e", "#ffffff"][Math.floor(rand() * 5)];
        car.add(box(1.3, 0.38, 0.7, col, 0, 0.12, 0), box(0.7, 0.3, 0.62, "#dfeef2", -0.05, 0.5, 0));
        for (const [x, z] of [[-0.42, -0.36], [0.42, -0.36], [-0.42, 0.36], [0.42, 0.36]]) g2wheel(car, x, z);
      }
      world.add(car);
      cars.push({ obj: car, c, key: cellKey, u: rand() * 6, speed: (0.12 + rand() * 0.06) * (k ? -1 : 1), lane: k ? ROAD_MID + 0.35 : ROAD_MID - 0.35 });
    }
    const peopleIds = Object.keys(glbModels.people);
    for (let w = 0; w < 3; w++) {
      let p;
      if (peopleIds.length) p = glbClone("people", peopleIds[Math.floor(rand() * peopleIds.length)], 0.8);
      else p = walkingPerson(rand);
      p.traverse((m) => (m.castShadow = true));
      world.add(p);
      walkers.push({ key:cellKey, p, limbs: p.userData.limbs, c, u: rand() * 6, s: (0.03 + rand() * 0.03) * (rand() < 0.5 ? -1 : 1), rad: R * 0.94 });
    }
  });

  // 地標放在第一格中央
  const kit = { THREE, box, cyl, cone, turn, mesh, mat, flag, tree };
  let lm = null;
  try { lm = scenery?.buildLandmark?.(island.id, kit) || null; } catch (err) { console.warn("地標建立失敗", island.id, err); }
  if (lm) lm.scale.setScalar(1.35);
  lm = glbClone("landmarks", island.id, 1.15) || lm || landmark(island);
  lm.position.set(cells[0].x, TOP, cells[0].z);
  lm.rotation.y = FACE_CAMERA;  // 林 dot 的地標以正面最精細，轉向預設鏡頭
  lm.traverse((o) => { o.userData = { island: island.id, landmark: true }; });
  // 林 dot 依 Google 地圖做的周邊實景（街道、量體、綠地），鋪在地標周圍
  const sur = glbClone("surroundings", island.id, 1.0);
  if (sur) { sur.position.set(cells[0].x, TOP, cells[0].z); sur.traverse((o) => { o.receiveShadow = true; o.userData = { island: island.id }; }); world.add(sur); }
  world.add(lm);
  pickables.push(lm);

  // 第二格中央的主題物件：質詢島放美麗島雜誌社、人行交通島放陳慧文站路口（模型存在才放）
  // 各島第二格以後的實景地標（格序、模型類別、模型、縮放、名稱）
  const CENTERPIECE = {
    P02: [[1, "character", "huiwen-corner", 1.25, "陳慧文站路口｜點一下打招呼"]],
    P06: [[1, "landmarks", "railpark", 1.75, "臺鐵高雄機廠舊址親子遊樂區"], [2, "landmarks", "formosa", 1.0, "美麗島雜誌社"]],
    X2: [[1, "landmarks", "chengcing-lake", 1.55, "澄清湖"], [2, "landmarks", "chengcing-baseball", 1.55, "澄清湖棒球場"], [3, "landmarks", "guoling-park", 1.55, "果嶺公園"]],
  };
  const taken = new Set();
  for (const [ci, kind, id, scale, name] of CENTERPIECE[island.id] || []) {
    const cpModel = cells[ci] ? glbClone(kind, id, scale) : null;
    if (!cpModel) continue;
    cpModel.position.set(cells[ci].x, TOP, cells[ci].z);
    cpModel.rotation.y = FACE_CAMERA;
    cpModel.traverse((o) => { o.castShadow = true; o.receiveShadow = true; o.userData = { island: island.id, figure: name, spot: kind === "landmarks" ? id : undefined }; });
    if (kind === "landmarks") spotLabels.push({ text: name, island: island.id, spotId: id, pos: new THREE.Vector3(cells[ci].x, TOP + 7.5, cells[ci].z) });
    world.add(cpModel);
    pickables.push(cpModel);
    taken.add(ci);
    if (id === "huiwen-corner") setupCornerWave(cpModel, glbModels.character[id]?.userData.clips || []);
  }
  const slots = cells.flatMap((c, ci) => cellSlots(c, ci === 0 || taken.has(ci)));
  let used = 0;

  if (island.kind === "interpellation" && interp?.threads) {
    // 質詢島：每條跨時間串連一根柱子，追問次數越多越高
    interp.threads.slice(0, slots.length).forEach((t, k) => {
      const g = new THREE.Group();
      const h = 0.8 + (t.steps?.length || 1) * 0.6;
      g.add(cyl(0.7, 0.8, 0.3, 8, "#e9e4d8"), cyl(0.36, 0.4, h, 8, "#f7f3ea", 0, 0.3, 0), cyl(0.58, 0.58, 0.2, 8, "#075548", 0, 0.3 + h));
      g.position.set(slots[k].x, TOP, slots[k].z);
      g.traverse((o) => { o.userData = { island: island.id, thread: k }; });
      world.add(g);
      pickables.push(g);
    });
    used = Math.min(slots.length, interp.threads.length);
  } else {
    island.flagships.forEach((n, k) => {
      const slot = slots[k];
      if (!slot) return;
      const it = data.items[n];
      const g = new THREE.Group();
      const variants = Object.keys(glbModels.templates).filter((v) => v === it.k || v.startsWith(`${it.k}-`)).sort();
      // 不放通用建築（看起來像多餘的房子）；周邊實景之後由林 dot 依 Google 地圖逐島建模
      void variants;
      g.position.set(slot.x, TOP, slot.z);
      g.rotation.y = Math.round((Math.atan2(cells[0].x - slot.x, cells[0].z - slot.z) / (Math.PI / 2))) * (Math.PI / 2);
      g.traverse((o) => { o.userData = { island: island.id, item: n }; });
      world.add(g);
      pickables.push(g);
      flagshipGroups.push({ group: g, done: !!it.d, island: island.id, item: n });
    });
    used = Math.min(slots.length, island.flagships.length);
  }

  // 其餘格位只放綠地、樹與街景小物件，不放無關的建築，讓地標與政績建物更清楚；約四成格位留空
  const propIds = Object.keys(glbModels.props);
  for (const slot of slots.slice(used)) {
    const g = new THREE.Group();
    const roll = rand();
    const treeIds = propIds.filter((k) => k.startsWith("tree"));
    if (roll < 0.4) continue;
    if (roll < 0.8) {
      g.add(cyl(1.3, 1.3, 0.06, 10, "#a9d68f"));
      if (treeIds.length) {
        for (const [x, z] of [[-0.5, -0.3], [0.6, 0.4]]) {
          const t = glbClone("props", treeIds[Math.floor(rand() * treeIds.length)], 0.45 + rand() * 0.15);
          t.position.set(x, 0, z);
          g.add(t);
        }
      } else {
        tree(g, -0.5, -0.3, 0.8 + rand() * 0.3);
        tree(g, 0.6, 0.4, 0.7 + rand() * 0.3, "#4f9a55");
      }
    } else if (propIds.length) g.add(glbClone("props", propIds[Math.floor(rand() * propIds.length)], 0.5));
    else tree(g, 0, 0, 0.9);
    g.position.set(slot.x, TOP, slot.z);
    g.rotation.y = Math.floor(rand() * 4) * (Math.PI / 2);
    g.traverse((o) => { o.userData = { island: island.id }; });
    world.add(g);
  }
}

// 會走路的人：腿與手臂各一組，繞髖、肩擺動
function walkingPerson(rand) {
  const g = new THREE.Group();
  const shirt = ["#075548", "#e4994a", "#4f9fc4", "#e48f9e", "#8f84cf", "#f3d36a"][Math.floor(rand() * 6)];
  const pants = ["#2f3d55", "#5b4a3c", "#3f4a4f"][Math.floor(rand() * 3)];
  const skin = "#f2c9a0", hair = ["#2b211b", "#5a3a26", "#d9d4cc"][Math.floor(rand() * 3)];
  const limb = (w, h, col, x, y) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const m = box(w, h, w, col, 0, -h, 0);
    pivot.add(m);
    g.add(pivot);
    return pivot;
  };
  const legs = [limb(0.13, 0.32, pants, -0.08, 0.34), limb(0.13, 0.32, pants, 0.08, 0.34)];
  g.add(box(0.34, 0.36, 0.22, shirt, 0, 0.32, 0));
  const arms = [limb(0.09, 0.3, shirt, -0.22, 0.66), limb(0.09, 0.3, shirt, 0.22, 0.66)];
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), mat(skin));
  head.position.y = 0.84;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(hair));
  cap.position.y = 0.86;
  g.add(head, cap);
  g.userData.limbs = { legs, arms };
  return g;
}

function g2wheel(car, x, z) {
  const w = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.1, 8), mat("#2d3134"));
  w.rotation.x = Math.PI / 2;
  w.position.set(x, 0.15, z);
  car.add(w);
}

// 橋：連接相鄰兩格環島道路的邊中點，跨過中間的水道
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const cellIsland = new Map();
for (const isl of islands) for (const [q, r] of LAYOUT[isl.id]) cellIsland.set(`${q},${r}`, isl.id);
const bridgePairs = [];
const seenPair = new Set();
for (const [key, id] of cellIsland) {
  const [q, r] = key.split(",").map(Number);
  for (const [dq, dr] of DIRS) {
    const nid = cellIsland.get(`${q + dq},${r + dr}`);
    if (!nid) continue;
    const pk = [key, `${q + dq},${r + dr}`].sort().join("|");
    if (seenPair.has(pk)) continue;
    seenPair.add(pk);
    bridgePairs.push({ a: [q, r], b: [q + dq, r + dr], ids: [id, nid] });
  }
}
function bridgeEnds(a, b) {
  const ca = cellPos(...a), cb = cellPos(...b);
  const dir = cb.clone().sub(ca).normalize();
  const reach = ROAD_MID * SQ3 / 2;
  return { pa: ca.clone().add(dir.clone().multiplyScalar(reach)), pb: cb.clone().sub(dir.clone().multiplyScalar(reach)), dir };
}
function roadBridge(a, b) {
  const { pa, pb } = bridgeEnds(a, b);
  const len = pa.distanceTo(pb), yaw = -Math.atan2(pb.z - pa.z, pb.x - pa.x);
  const bridgeIds = Object.keys(glbModels.bridges);
  if (bridgeIds.length) {
    const g = new THREE.Group();
    const m = glbModels.bridges[bridgeIds[(a[0] * 7 + a[1] * 3 + 99) % bridgeIds.length]].clone(true);
    m.scale.set(len / 6, 1, 1);  // 模型橋長 6 單位，沿 x 拉到實際跨距
    g.add(m);
    const mid2 = pa.clone().add(pb).multiplyScalar(0.5);
    g.position.set(mid2.x, 0, mid2.z);
    g.rotation.y = yaw;
    world.add(g);
    return g;
  }
  const g = new THREE.Group();
  const N = 10;
  for (let s = 0; s < N; s++) {
    const t = (s + 0.5) / N, lift = Math.sin(t * Math.PI) * 0.55;
    const seg = box(len / N + 0.05, 0.22, 2.0, "#7a8085", (t - 0.5) * len, TOP + lift - 0.1, 0);
    seg.rotation.z = Math.cos(t * Math.PI) * 0.17;
    g.add(seg);
    for (const z of [-1.05, 1.05]) g.add(box(len / N + 0.05, 0.3, 0.1, "#f4efe4", (t - 0.5) * len, TOP + lift + 0.12, z));
  }
  for (const x of [-len / 2 + 0.6, len / 2 - 0.6]) g.add(cyl(0.22, 0.28, 2.4, 8, "#cfc6b4", x, -1.9, 0));
  const m = pa.clone().add(pb).multiplyScalar(0.5);
  g.position.set(m.x, 0, m.z);
  g.rotation.y = yaw;
  world.add(g);
  return g;
}

// ── 場景細節：島間步道橋、岸邊、海浪、船、雲、日夜 ──────────────────
const backdrop = addBackdrop({ THREE, scene, box, cyl, cone, tree, rng });
let weather = null;
const extras = addSceneExtras({ THREE, scene, world, islands, LAYOUT, hexToWorld, mid, R, mat, box, cyl, cone, tree, sun, hemi, rng, boatModels: glbModels.boats });
const riverInfo = addRiver({ THREE, world, cellPos, R, SPACING, mat, box, cyl, bridgeEnds, TOP, models: glbModels.landmarks });
for (const bp of bridgePairs) if (!riverInfo.skipPairs.has([bp.a, bp.b].map((x) => x.join(",")).sort().join("|"))) roadBridge(bp.a, bp.b);
pickables.push(...riverInfo.pickables);

// ── Q 版慧文巡島：依序走過每座島，在地標前停一下 ─────────────────────
// 有 Colab 生成的 huiwen.glb 就用；沒有就用小Q配色拼的人偶（淺藍外套、白內搭、深藍褲、紫鞋、棕短髮）
function huiwenFigure() {
  const g = new THREE.Group();
  g.add(cyl(0.16, 0.18, 0.18, 8, "#7b5ea7", -0.16, 0), cyl(0.16, 0.18, 0.18, 8, "#7b5ea7", 0.16, 0));
  g.add(cyl(0.15, 0.17, 0.6, 8, "#24345c", -0.16, 0.15), cyl(0.15, 0.17, 0.6, 8, "#24345c", 0.16, 0.15));
  g.add(cyl(0.42, 0.5, 0.95, 10, "#9cc8e8", 0, 0.7));
  g.add(box(0.32, 0.6, 0.06, "#ffffff", 0, 0.95, 0.42));
  const head = mesh(new THREE.SphereGeometry(0.62, 16, 12), "#f6d2b8");
  head.position.y = 2.15;
  const hair = mesh(new THREE.SphereGeometry(0.67, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), "#5a3a26");
  hair.position.y = 2.2;
  hair.rotation.x = -0.25;
  g.add(head, hair);
  for (const x of [-0.22, 0.22]) {
    const eye = mesh(new THREE.SphereGeometry(0.07, 8, 6), "#4a2c1a");
    eye.position.set(x, 2.15, 0.56);
    const cheek = mesh(new THREE.SphereGeometry(0.09, 8, 6), "#f2a49a");
    cheek.position.set(x * 1.55, 2.0, 0.5);
    g.add(eye, cheek);
  }
  return g;
}
const huiwen = new THREE.Group();
{
  const model = glbModels.character.huiwen;
  if (model) { const m = model.clone(true); huiwen.add(m); } else huiwen.add(huiwenFigure());
  huiwen.scale.setScalar(model ? 0.9 : 0.75);
  huiwen.traverse((o) => { o.castShadow = true; o.userData = { huiwen: true }; });
  world.add(huiwen);
  pickables.push(huiwen);
}
// 2025 年 Q 圖版本固定站在質詢島的議會前（模型還沒生成時不顯示）
if (glbModels.character["huiwen-2025"] && islandCenter.Q1) {
  const q = new THREE.Group();
  q.add(glbModels.character["huiwen-2025"].clone(true));
  q.scale.setScalar(0.9);
  const first = LAYOUT.Q1[0], cell = hexToWorld(first[0], first[1]).sub(mid);
  q.position.set(cell.x - 0.5 * ROAD_MID * 0.866 * 0.9, TOP + 0.08, cell.z + 0.866 * ROAD_MID * 0.866 * 0.9);
  q.traverse((o) => { o.castShadow = true; o.userData = { huiwen: true, island: "Q1" }; });
  world.add(q);
  pickables.push(q);
}
// 陳其邁、許智傑在島上隨意走動：沿環島道路逛一段，走到橋頭就過橋到隔壁的島（模型生成後才出現）
const wanderers = [];
function addWanderer(id, label, startCell, scale = 0.85) {
  const src = glbModels.character[id];
  if (!src) return;
  const g = new THREE.Group();
  g.add(src.clone(true));
  g.scale.setScalar(scale);
  g.traverse((o) => { o.castShadow = true; o.userData = { figure: label }; });
  world.add(g);
  pickables.push(g);
  wanderers.push({ g, cell: startCell, u: Math.random() * 6, target: null, cross: null, speed: 0.06 + Math.random() * 0.03, rand: rng(id.length * 7919) });
}
addWanderer("chenqimai", "陳其邁｜高雄市長", LAYOUT.Q1[0]);
addWanderer("xuzhijie", "許智傑｜立法委員", LAYOUT.P02[0]);
// 百變隆隆 16 角：散在各島隨意走動，點一下出現漫畫對話框
let longlongDialogue = null;
const longlongTags = [];  // 百變隆隆頭上的小名牌
try {
  const res = await fetch("./longlong-dialogue.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("角色資料載入失敗");
  const cues = await res.json();
  longlongDialogue = createLonglongDialogue({ THREE, camera, canvas, cues });
  const cells = [...Object.values(LAYOUT)].flat();
  cues.cues.forEach((c, i) => {
    const before = wanderers.length;
    addWanderer(c.id, `百變隆隆｜${c.name}`, cells[(i * 5) % cells.length], 1.0);
    if (wanderers.length > before) {
      const w = wanderers[wanderers.length - 1];
      longlongDialogue.register(w.g, c.id);
      const tag = document.createElement("button");
      tag.type = "button";
      tag.className = "ll-tag";
      tag.textContent = `隆隆・${c.name}`;
      tag.addEventListener("click", () => longlongDialogue.show(c.id));
      $("#labels").append(tag);
      longlongTags.push({ el: tag, g: w.g });
    }
  });
} catch (err) { console.warn("百變隆隆互動暫未載入", err); }
const edgeU = (from, to) => {
  const d = cellPos(...to).sub(cellPos(...from));
  return ((Math.atan2(d.x, d.z) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 3);
};
function stepWanderers(dt) {
  const talking = longlongDialogue?.activeObject;
  for (const w of wanderers) {
    if (w.g === talking) {  // 楓之谷式：被點到的角色停下來面向鏡頭講話
      w.g.rotation.y = smoothTurn(w.g.rotation.y, Math.atan2(camera.position.x - w.g.position.x, camera.position.z - w.g.position.z), dt);
      continue;
    }
    if (w.cross) {  // 過橋中
      w.cross.t = Math.min(1, w.cross.t + dt * 0.35);
      const p = w.cross.pa.clone().lerp(w.cross.pb, w.cross.t);
      w.g.position.set(p.x, TOP + 0.08 + Math.sin(w.cross.t * Math.PI) * 0.55, p.z);
      w.g.rotation.y = smoothTurn(w.g.rotation.y,Math.atan2(w.cross.pb.x-w.cross.pa.x,w.cross.pb.z-w.cross.pa.z),dt);
      if (w.cross.t >= 1) { w.cell = w.cross.to; w.u = edgeU(w.cell, w.cross.from); w.cross = null; w.target = null; }
      continue;
    }
    if (!w.target) {  // 隨機挑一座相鄰的格，或在原地多逛一圈
      const options = bridgePairs.filter((bp) => bp.a.join() === w.cell.join() || bp.b.join() === w.cell.join());
      if(!options.length)continue;
      const bp = options[Math.floor(w.rand() * options.length)];
      const to = bp.a.join() === w.cell.join() ? bp.b : bp.a;
      w.target = { to, u: edgeU(w.cell, to), laps: w.rand() < 0.3 ? 1 : 0 };
    }
    const diff = ((w.target.u - w.u + 9) % 6) - 3;  // 走最短方向
    const step = Math.sign(diff || 1) * w.speed * dt;
    if (Math.abs(diff) < Math.abs(step) * 1.5 && !w.target.laps) {
      const { pa, pb } = bridgeEnds(w.cell, w.target.to);
      w.cross = { pa, pb, t: 0, from: w.cell, to: w.target.to };
      continue;
    }
    if (Math.abs(diff) < Math.abs(step) * 1.5) w.target.laps--;
    w.u = (w.u + step + 6) % 6;
    const c = cellPos(...w.cell), p = hexPoint(c, ROAD_MID, w.u), n = hexPoint(c, ROAD_MID, (w.u + Math.sign(step) * 0.02 + 6) % 6);
    w.g.position.set(p.x, TOP + 0.08 + Math.abs(Math.sin(clock.elapsedTime * 7)) * 0.06, p.z);
    w.g.rotation.y = smoothTurn(w.g.rotation.y,Math.atan2(n.x-p.x,n.z-p.z),dt);
  }
}
// ── 交通：車道線、斑馬線、智慧號誌、高架捷運 ───────────────────────
const traffic = addTraffic({
  THREE, world, bridgePairs, cellPos, edgeU, hexPoint, hexRing, R, TOP, ROAD_IN, ROAD_OUT, ROAD_MID, mat, box, cyl,
  cells: [...cellIsland.keys()].map((k) => ({ p: cellPos(...k.split(",").map(Number)) })),
});
// 鳳山醫院（照顧不離職島）周邊的救護車：閃警示燈，不受號誌限制
const sirenRed = mat("#ff3b3b", { emissive: "#ff1a1a", emissiveIntensity: 1.5 });
const sirenBlue = mat("#3b7bff", { emissive: "#1a5cff", emissiveIntensity: 1.5 });
{
  const key = LAYOUT.P09[0].join(","), c = cellPos(...LAYOUT.P09[0]);
  let amb = glbModels.vehicles.ambulance ? glbClone("vehicles", "ambulance", 0.6) : null;
  if (!amb) {
    amb = new THREE.Group();
    amb.add(box(1.6, 0.7, 0.8, "#ffffff", 0, 0.12, 0), box(1.62, 0.12, 0.82, "#e0453a", 0, 0.45, 0), box(0.5, 0.35, 0.74, "#cfe6ee", 0.62, 0.55, 0));
    for (const [x, z] of [[-0.5, -0.4], [0.5, -0.4], [-0.5, 0.4], [0.5, 0.4]]) g2wheel(amb, x, z);
  }
  const siren = box(0.3, 0.12, 0.3, "#ff3b3b", 0, 0.95, 0);
  amb.add(siren);
  world.add(amb);
  cars.push({ obj: amb, c, key, u: 1, speed: 0.22, lane: ROAD_MID - 0.35, siren });
}

const tourStops = islands.map((i) => {
  const first = LAYOUT[i.id][0];
  const cell = cellPos(first[0], first[1]);
  return new THREE.Vector3(cell.x + 0.5 * R * 0.94 * 0.866, TOP + 0.08, cell.z + 0.866 * R * 0.94 * 0.866);  // 地標前方的人行道
});
const tour = { i: 0, t: 0, wait: 2.5 };
let longlong = null;
if (glbModels.character.longlong) {
  longlong = new THREE.Group();
  longlong.add(glbModels.character.longlong.clone(true));
  longlong.scale.setScalar(0.9);
  longlong.traverse((o) => { o.castShadow = true; o.userData = { longlong: true }; });
  world.add(longlong);
  pickables.push(longlong);
}
huiwen.position.copy(tourStops[0]);
if (new URLSearchParams(location.search).has("debug")) Object.assign(window, { __huiwen: huiwen, __camera: camera });
function stepTour(dt) {
  if (tour.wait > 0) {
    tour.wait -= dt;
    huiwen.position.y = TOP + 0.08 + Math.abs(Math.sin(performance.now() / 300)) * 0.05;
    return;
  }
  const a = tourStops[tour.i], b = tourStops[(tour.i + 1) % tourStops.length];
  const dist = a.distanceTo(b);
  tour.t = Math.min(1, tour.t + (dt * 5) / dist);
  huiwen.position.lerpVectors(a, b, tour.t);
  huiwen.position.y = TOP + 0.08 + Math.abs(Math.sin(tour.t * dist * 1.6)) * 0.18;
  huiwen.rotation.y = smoothTurn(huiwen.rotation.y,Math.atan2(b.x-a.x,b.z-a.z),dt);
  if (tour.t >= 1) { tour.i = (tour.i + 1) % tourStops.length; tour.t = 0; tour.wait = 3; }
}
function followLonglong() {
  if (!longlong) return;
  const side = new THREE.Vector3(Math.cos(huiwen.rotation.y), 0, -Math.sin(huiwen.rotation.y)).multiplyScalar(1.8);
  longlong.position.copy(huiwen.position).add(side);
  longlong.rotation.y = huiwen.rotation.y;
}

// ── 島名標籤（中文）──────────────────────────────────────────────
const labelsEl = $("#labels");
const labelEls = {};
for (const island of islands) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = island.id === "Q1" ? "isl-label isl-center" : "isl-label";
  el.innerHTML = `<b style="background:${AXIS_COLOR[island.axis]}">${island.kind === "pledge" ? island.id.slice(1).replace(/^0/, "") : island.kind === "interpellation" ? "質" : "績"}</b>${esc(island.id === "Q1" ? "高雄市議會・質詢島" : island.name)}`;
  el.addEventListener("click", () => openIsland(island.id, true));
  labelsEl.append(el);
  labelEls[island.id] = el;
}
// 鳳山溪與跨溪橋的名牌：點溪看鳳山溪相關政績，點橋看那座橋的圖卡
const itemByTitle = (prefix) => data.items.findIndex((it) => it.t.startsWith(prefix));
const BRIDGE_ITEM = { dingbao: itemByTitle("頂寶橋"), haibang: itemByTitle("海邦橋") };
function openRiver() { Object.assign(state, { view: "project", project: "fengshanriver", limit: 40 }); setPanel(true); render(); body.scrollTop = 0; }
const extraLabels = [...riverInfo.labels, ...spotLabels.map((s) => ({ text: s.text, pos: s.pos, kind: "spot", id: s.text, island: s.island }))].map((l) => {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "isl-label river-label";
  el.innerHTML = `<b style="background:${l.kind === "river" ? "#3f9cc0" : l.kind === "spot" ? "#c0573f" : "#8a8f93"}">${l.kind === "river" ? "溪" : l.kind === "spot" ? "景" : "橋"}</b>${esc(l.text)}`;
  el.addEventListener("click", () => (l.kind === "river" ? openRiver() : l.kind === "spot" ? openIsland(l.island, true, null, spotFor(l.island, spotLabels.find((x) => x.text === l.text)?.spotId)) : BRIDGE_ITEM[l.id] >= 0 && openCard(BRIDGE_ITEM[l.id])));
  labelsEl.append(el);
  return { el, pos: l.pos, kind: l.kind, id: l.id, island: l.island };
});
const tmp = new THREE.Vector3();
// 選到一座島時，島上的重點政績在建物上方冒出編號名牌（HEART 的細項標示做法），點了開圖卡
let itemPins = [];
function showItemPins(id) {
  for (const p of itemPins) p.el.remove();
  itemPins = [];
  if (!id) return;
  flagshipGroups.filter((f) => f.island === id).slice(0, mobile() ? 4 : 6).forEach((f, k) => {
    const it = data.items[f.item];
    const el = document.createElement("button");
    el.type = "button";
    el.className = "item-pin";
    const short = it.t.length > 10 ? it.t.slice(0, 10) + "…" : it.t;
    el.innerHTML = `<b>${k + 1}</b>${esc(short)}`;
    el.title = it.t;
    el.addEventListener("click", () => openCard(f.item));
    labelsEl.append(el);
    const pos = new THREE.Vector3();
    f.group.getWorldPosition(pos);
    pos.y += 4.2;
    itemPins.push({ el, pos });
  });
}
function placeLabels() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const talking = longlongDialogue?.activeObject;
  for (const t of longlongTags) {
    tmp.copy(t.g.position); tmp.y += 4.2; tmp.project(camera);
    const off = tmp.z > 1 || Math.abs(tmp.x) > 1.05 || Math.abs(tmp.y) > 1.05;
    t.el.hidden = off || t.g === talking;
    if (!off) { t.el.style.left = `${(tmp.x * 0.5 + 0.5) * w}px`; t.el.style.top = `${(-tmp.y * 0.5 + 0.5) * h}px`; }
  }
  // 名牌互相錯開：由下往上排，撞到已放好的就往上挪
  const placed = [];
  const pins = itemPins.map((p) => { tmp.copy(p.pos).project(camera); return { el: p.el, x: (tmp.x * 0.5 + 0.5) * w, y: (-tmp.y * 0.5 + 0.5) * h, wd: p.el.offsetWidth || 120 }; })
    .sort((a, b) => b.y - a.y);
  // 撞到就先左右錯開，再往上疊；避免全部疊成一直排、頂到工具列
  const hit = (p) => placed.some((q) => Math.abs(q.y - p.y) < 24 && Math.abs(q.x - p.x) < (q.wd + p.wd) / 2 + 4);
  for (const p of pins) {
    const ox = p.x, oy = p.y, dx = p.wd / 2 + 10;
    outer: for (let row = 0; row < 5; row++) for (const sx of [0, dx, -dx]) {
      p.x = ox + sx; p.y = oy - row * 26;
      if (!hit(p)) break outer;
    }
    placed.push(p);
    p.el.style.left = `${p.x}px`;
    p.el.style.top = `${p.y}px`;
  }
  for (const { el, pos } of extraLabels) {
    tmp.copy(pos).project(camera);
    el.style.left = `${(tmp.x * 0.5 + 0.5) * w}px`;
    el.style.top = `${(-tmp.y * 0.5 + 0.5) * h}px`;
  }
  for (const island of islands) {
    const first = LAYOUT[island.id][0];
    tmp.copy(cellPos(first[0], first[1]));
    tmp.y = island.kind === "pledge" ? 10 : 7;
    tmp.project(camera);
    const el = labelEls[island.id];
    el.style.left = `${(tmp.x * 0.5 + 0.5) * w}px`;
    el.style.top = `${(-tmp.y * 0.5 + 0.5) * h}px`;
  }
}

// ── 活動宣布：首頁橫幅（資料由 data/events.json 匯出），活動結束自動消失 ──
let upcoming = [];
try {
  const ev = await fetch("./dot-code-2/events.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : { events: [] }));
  upcoming = (ev.events || []).filter((e) => e.published && e.status === "published" && islandById[e.island] && Date.parse(e.endDate || e.date) >= Date.now())
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
} catch {}
const eventTime = (d) => new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d));
function eventBanner() {
  return upcoming.slice(0, 2).map((e) => `<button type="button" class="event-banner" data-act="island" data-id="${esc(e.island)}"><span>活動宣布</span><b>${esc(e.title)}</b><small>${esc(eventTime(e.date))}｜${esc(e.place)}</small></button>`).join("");
}

// ── 地標 3D 縮圖：離屏小畫布，每個模型只畫一次 ──
const thumbCache = new Map();
let thumbCtx = null;
async function thumbnail(kind, id) {
  const key = `${kind}/${id}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const src = glbModels[kind]?.[id];
  if (!src) { thumbCache.set(key, null); return null; }
  if (!thumbCtx) {
    const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    r.setSize(260, 220, false); r.setPixelRatio(1); r.outputColorSpace = THREE.SRGBColorSpace;
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight("#ffffff", "#9ab", 1.9));
    const d = new THREE.DirectionalLight("#fff3dc", 2.0); d.position.set(-5, 10, 7); sc.add(d);
    thumbCtx = { r, sc, cam: new THREE.PerspectiveCamera(28, 260 / 220, 0.1, 500) };
  }
  const { r, sc, cam } = thumbCtx;
  const m = src.clone(true);
  sc.add(m);
  const box = new THREE.Box3().setFromObject(m), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
  const dist = (size * 0.6) / Math.tan(THREE.MathUtils.degToRad(14));
  cam.position.copy(c).add(new THREE.Vector3(0.75, 0.55, 1).normalize().multiplyScalar(dist));
  cam.lookAt(c);
  r.render(sc, cam);
  const url = r.domElement.toDataURL("image/png");
  sc.remove(m);
  thumbCache.set(key, url);
  return url;
}

// ── 相機與版面 ──────────────────────────────────────────────────
const FRUSTUM = 138;
let panelOpen = true;
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  const f = mobile() ? FRUSTUM * 1.25 : FRUSTUM;
  camera.left = (-f * aspect) / 2; camera.right = (f * aspect) / 2;
  camera.top = f / 2; camera.bottom = -f / 2;
  // 清單打開時，把畫面中心移到沒被清單遮住的區域
  const panel = $("#panel").getBoundingClientRect();
  if (panelOpen && !mobile()) camera.setViewOffset(w, h, (panel.width + 16) / 2, 0, w, h);
  else if (panelOpen && mobile()) camera.setViewOffset(w, h, 0, Math.min(panel.height, h * 0.5) / 2, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

let tween = null;
function focusOn(target, zoom) { life?.flyTo(target,zoom); }
const home = () => focusOn(new THREE.Vector3(0, 0, 0), 1);

// ── 點選與提示 ──────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tooltip = $("#tooltip");
let lastHit = null;
function pick(ev) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pickables, true).find((h) => h.object.visible);
  lastHit = hit || null;
  return hit?.object.userData;
}
let downAt = null;
canvas.addEventListener("pointerdown", (e) => {
  downAt = e.isPrimary === false ? null : [e.clientX, e.clientY];
  tooltip.classList.remove("show");
  longlongDialogue?.pointerDown(e);
});
canvas.addEventListener("pointercancel", () => { downAt = null; longlongDialogue?.pointerCancel(); });
canvas.addEventListener("pointerup", (e) => {
  if (longlongDialogue?.pointerUp(e, pickables)) { downAt = null; return; }
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > (e.pointerType === "mouse" ? 6 : 10)) return;
  const u = pick(e);
  if (!u && mobile() && panelOpen && sheetState !== "peek") { setSheet("peek"); return; }
  if (u) feel?.ripple(lastHit?.point, u.item != null ? "#f3c64f" : "#ffffff");
  if (e.pointerType !== "mouse" && lastHit) { feel?.hover(lastHit.object); setTimeout(() => feel?.hover(null), 650); }
  if (u?.item != null) { openIsland(u.island, true, u.item); openCard(u.item); }
  else if (u?.thread != null) {const th=interp.threads[u.thread];life?.showConnections(['Q1',th?.island]);if(th?.island)openIsland(th.island,true); }
  else if (u?.river) openRiver();
  else if (u?.bridge && BRIDGE_ITEM[u.bridge] >= 0) openCard(BRIDGE_ITEM[u.bridge]);
  else if (u?.spot || u?.landmark) openIsland(u.island, true, null, spotFor(u.island, u.spot));
  else if (u?.island) openIsland(u.island, true);
});
let hoverFrame = 0;
canvas.addEventListener("pointermove", (e) => {
  longlongDialogue?.pointerMove(e);
  if (e.pointerType !== "mouse" || e.buttons || hoverFrame) return;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    const u = pick(e);
    feel?.hover(lastHit?.object || null);
    life?.hoverIsland(u?.island||null);
    // 名牌只在滑過或選到時出現（中央議會一直在）
    for (const [id, el] of Object.entries(labelEls)) el.classList.toggle("hover", u?.island === id);
    for (const x of extraLabels) x.el.classList.toggle("hover", (x.kind === "river" && !!u?.river) || (x.kind === "bridge" && u?.bridge === x.id) || (x.kind === "spot" && u?.figure === x.id));
    let html = "";
    if (u?.item != null) {
      const it = data.items[u.item];
      html = esc(it.t);
    } else if (u?.thread != null) {
      const t = interp.threads[u.thread];
      html = esc(t.title);
    } else if (u?.figure) {
      html = esc(u.figure);
    } else if (u?.river) {
      html = "鳳山溪｜點一下看沿岸的政績";
    } else if (u?.bridge) {
      html = u.bridge === "dingbao" ? "頂寶橋" : "海邦橋";
    } else if (u?.longlong) {
      html = "百變隆隆｜陪慧文巡島";
    } else if (u?.huiwen) {
      html = "陳慧文｜正在巡島";
    } else if (u?.landmark) {
      const isl = islandById[u.island];
      const spot = scenery?.LANDMARK_INFO?.[u.island]?.name;
      html = `${spot ? `${esc(spot)}｜` : ""}${isl.pledge ? `2026 政見：${esc(isl.pledge)}` : esc(isl.name)}`;
    }
    tooltip.innerHTML = html;
    tooltip.classList.toggle("show", !!html);
    tooltip.style.left = `${e.clientX}px`;
    tooltip.style.top = `${e.clientY}px`;
  });
});
canvas.addEventListener("pointerleave", () => { tooltip.classList.remove("show"); feel?.hover(null); for (const el of document.querySelectorAll(".isl-label.hover")) el.classList.remove("hover"); });

// ── 清單與面板 ──────────────────────────────────────────────────
const body = $("#panel-body");
const state = { view: "home", tab: "islands", island: null, layer: "全部", village: null, project: null, query: "", limit: 40, focusItem: null };
const visibleItems = (idx) => idx;
const byWeight = (a, b) => data.items[b].w - data.items[a].w;
const projectById = Object.fromEntries((data.projects || []).map((p) => [p.id, p]));

function itemHTML(n, highlight) {
  const it = data.items[n];
  const title = `<button type="button" class="item-title" data-act="card" data-n="${n}">${esc(it.t)}</button>`;
  const where = it.all ? "全市" : it.v.length > 3 ? `${it.v.slice(0, 3).join("、")}等 ${it.v.length} 里` : it.v.join("、");
  const facts = factsOf(it, where);
  const steps = it.h.slice(-3);
  return `<article class="item${highlight ? " flag" : ""}" id="item-${n}">
    <h4>${title}</h4>
    ${facts.length ? `<div class="facts">${facts.join("")}</div>` : ""}
    ${steps.length ? `<ul class="mini-tl">${steps.map(([d, t]) => `<li><time>${esc(d)}</time>${esc(t)}</li>`).join("")}</ul>` : ""}
  </article>`;
}

function whereOf(it) {
  return it.all ? "全市" : it.v.length > 3 ? `${it.v.slice(0, 3).join("、")}等 ${it.v.length} 里` : it.v.join("、");
}

function factsOf(it, where = whereOf(it)) {
  return [
    where && `<span>${esc(where)}</span>`,
    it.b && `<span>經費 ${esc(it.b)}</span>`,
    it.c >= 3 && `<span>服務案件 ${it.c} 件</span>`,
    it.pc?.length && `<span>議員 ${esc(it.pc.join("、"))}</span>`,
    it.pv?.length && `<span>里長 ${esc(it.pv.join("、"))}</span>`,
    it.pl?.length && `<span>立委 ${esc(it.pl.join("、"))}</span>`,
    it.p && projectById[it.p] && `<button type="button" class="proj" data-act="project" data-id="${it.p}">專案：${esc(projectById[it.p].name)}</button>`,
  ].filter(Boolean);
}

// 圖卡：點項目打開的簡單說明，不連出網站
const cardEl = document.createElement("div");
cardEl.id = "card";
cardEl.hidden = true;
cardEl.setAttribute("role", "dialog");
cardEl.setAttribute("aria-modal", "true");
document.querySelector("#app").append(cardEl);
function openCard(n) {
  if (dotCards) return dotCards.openItem(n);
  const selectedItem=data.items[n];life?.showConnections(selectedItem?.p?data.items.filter(x=>x.p===selectedItem.p).map(x=>x.i):[selectedItem?.i]);
  const it = data.items[n], isl = islandById[it.i];
  const facts = factsOf(it);
  cardEl.innerHTML = `<div class="card-box" style="--accent:${isl ? AXIS_COLOR[isl.axis] : "#075548"}">
    <button type="button" class="card-close" data-card="close" aria-label="關閉">×</button>
    <p class="card-kicker">${esc(isl?.name || "鳳山各里")}</p>
    <h3>${esc(it.t)}</h3>
    ${facts.length ? `<div class="facts">${facts.join("")}</div>` : ""}
    ${it.s ? `<p class="card-sum">${esc(it.s)}</p>` : ""}
    ${it.h.length ? `<ol class="card-tl">${it.h.map(([d, t]) => `<li><time>${esc(d)}</time>${esc(t)}</li>`).join("")}</ol>` : ""}
    ${(it.n || []).length ? `<p class="card-label">新聞</p><ul class="card-list">${it.n.map(([d, t]) => `<li>${esc(d)} ${esc(t)}</li>`).join("")}</ul>` : ""}
  </div>`;
  cardEl.hidden = false;
  cardEl.querySelector(".card-close").focus();
}
function showCard({ accent = "#075548", kicker = "", title = "", facts = [], summary = "", blocks = [] }) {
  cardEl.innerHTML = `<div class="card-box" style="--accent:${accent}">
    <button type="button" class="card-close" data-card="close" aria-label="關閉">×</button>
    <p class="card-kicker">${esc(kicker)}</p><h3>${esc(title)}</h3>
    ${facts.length ? `<div class="facts">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : ""}
    ${summary ? `<p class="card-sum">${esc(summary)}</p>` : ""}
    ${blocks.filter((b) => b.items.length).map((b) => `<p class="card-label">${esc(b.label)}</p><ul class="card-list">${b.items.map((x) => `<li>${x}</li>`).join("")}</ul>`).join("")}
  </div>`;
  cardEl.hidden = false;
  cardEl.querySelector(".card-close").focus();
}
const hearings = data.hearings || [];
function openHearing(i) {
  const h = hearings[i], isl = islandById[h.island];
  showCard({
    accent: isl ? AXIS_COLOR[isl.axis] : "#075548", kicker: `公聽會｜${h.date}`, title: h.title,
    facts: [h.role, h.cohosts.length ? `共同主持 ${h.cohosts.join("、")}` : "", isl ? isl.name : ""].filter(Boolean),
    blocks: [
      { label: "慧文講了什麼", items: h.statements.map(esc) },
      { label: "慧文的主張", items: h.positions.map(esc) },
      { label: "市府回應", items: h.responses.map(esc) },
      { label: "後續", items: h.outcome ? [esc(h.outcome)] : [] },
    ],
  });
}
function openSession(i) {
  const x = interpSessions()[i], isl = islandById[x.island];
  showCard({
    accent: isl ? AXIS_COLOR[isl.axis] : "#075548", kicker: `質詢島｜${x.date}`,
    title: (x.targets || []).length ? x.targets.join("、") : "議會",
    facts: isl ? [isl.name] : [], summary: x.quote ? `「${x.quote}」` : x.summary || "",
    blocks: [{ label: "講了什麼", items: (x.points || []).map((pt) => `<b>${esc(pt.topic)}</b>${[pt.said, pt.asked && `要求：${pt.asked}`, pt.response && `回應：${pt.response}`].filter(Boolean).map(esc).join("<br>")}`) }],
  });
}
function hearingRows(list) {
  return list.map(({ h, i }) => `<article class="item"><h4><button type="button" class="item-title" data-act="hearing" data-n="${i}">${esc(h.title)}</button></h4>
    <div class="facts"><span>${esc(h.date)}</span><span>${esc(h.role)}</span></div>
    ${h.positions[0] ? `<ul class="mini-tl"><li>${esc(h.positions[0])}</li></ul>` : ""}</article>`).join("");
}
function hearingsHTML(id) {
  const list = hearings.map((h, i) => ({ h, i })).filter(({ h }) => h.island === id);
  return list.length ? `<p class="axis">公聽會</p>${hearingRows(list)}` : "";
}
function closeCard() { cardEl.hidden = true; }
cardEl.addEventListener("click", (e) => {
  if (e.target === cardEl || e.target.closest("[data-card=close]")) return closeCard();
  const t = e.target.closest("[data-act=project]");
  if (t) { closeCard(); Object.assign(state, { view: "project", project: t.dataset.id, limit: 40 }); life?.showConnections(data.items.filter(x=>x.p===t.dataset.id).map(x=>x.i)); setPanel(true); render(); body.scrollTop = 0; }
});
addEventListener("keydown", (e) => { if (e.key === "Escape" && !cardEl.hidden) closeCard(); });

function listHTML(idx, highlightFirst = 0) {
  const shown = idx.slice(0, state.limit);
  if (!shown.length) return `<p class="empty">沒有符合的項目。</p>`;
  return shown.map((n, k) => itemHTML(n, k < highlightFirst)).join("") +
    (idx.length > state.limit ? `<button type="button" class="more" data-act="more">再顯示更多</button>` : "");
}

function renderHome() {
  const total = data.items.length, cases = data.meta.serviceCases;
  let html = `<p class="p-kicker">做得到的承諾，看得見的改變。</p>
    <h2 class="p-title">一座島，一個承諾</h2>
    <p class="p-lead">中央是高雄市議會，四周每座島是一項承諾，島上站著已經做過的事。</p>${eventBanner()}
    <div class="stats"><div class="stat"><b>13</b><span>2026 政見</span></div><div class="stat"><b>${total.toLocaleString()}</b><span>筆政績</span></div>${cases ? `<div class="stat"><b>${cases.toLocaleString()}</b><span>件服務案件</span></div>` : ""}</div>
    <input class="search" type="search" placeholder="搜尋政績、地名、里名…" value="${esc(state.query)}" data-act="search" aria-label="搜尋">
    <div class="tabs" role="tablist"><button type="button" role="tab" data-act="tab" data-tab="islands" aria-selected="${state.tab === "islands"}">島嶼</button><button type="button" role="tab" data-act="tab" data-tab="villages" aria-selected="${state.tab === "villages"}">鳳山各里</button></div>`;
  if (state.tab === "islands") {
    for (const axis of data.axes) {
      const list = axis.islands.filter((id) => islandById[id]);
      if (!list.length) continue;
      html += `<p class="axis">${esc(axis.name)}</p>`;
      for (const id of list) {
        const isl = islandById[id];
        html += `<button type="button" class="isl-row" data-act="island" data-id="${id}">
          <span class="dot" style="background:${AXIS_COLOR[isl.axis]}">${isl.kind === "pledge" ? id.slice(1).replace(/^0/, "") : isl.kind === "interpellation" ? "質" : "績"}</span>
          <span class="name">${esc(isl.name)}<small>${esc(isl.pledge || (isl.kind === "interpellation" ? "在議會講了什麼，最後發展是什麼" : isl.note || "長期推動政見"))}</small></span>
</button>`;
      }
    }
    if (data.laiAchievements?.length) {
      html += `<p class="axis">認識賴瑞隆</p><button type="button" class="isl-row" data-act="lai"><span class="dot" style="background:#b8862b">賴</span><span class="name">賴瑞隆的政見與政績<small>${(data.laiPolicies || []).length} 項市長政見、${data.laiAchievements.length} 項立委政績，對照慧文在同一座島做的事</small></span></button>`;
    }
    html += `<p class="axis">鳳山各里</p><button type="button" class="isl-row" data-act="tab" data-tab="villages"><span class="dot" style="background:#9a8f7a">里</span><span class="name">鳳山 63 里<small>里內路平、水溝、路燈等小工程</small></span></button>`;
  } else {
    const counts = {};
    data.items.forEach((it) => it.v.forEach((v) => (counts[v] = (counts[v] || 0) + 1)));
    const vs = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    html += `<p class="p-lead">點你家那一里，看所有相關紀錄。</p><div class="village-grid">${vs.map(([v, c]) => `<button type="button" data-act="village" data-v="${esc(v)}">${esc(v)}</button>`).join("")}</div>`;
  }
  return html;
}

function renderSearch() {
  const q = state.query.trim();
  const idx = visibleItems(data.items.map((_, n) => n).filter((n) => {
    const it = data.items[n];
    return it.t.includes(q) || it.v.some((v) => v.includes(q));
  })).sort(byWeight);
  const isl = islands.filter((i) => i.name.includes(q) || (i.pledge || "").includes(q));
  return `<button type="button" class="back" data-act="home">← 回到全部</button>
    <input class="search" type="search" placeholder="搜尋政績、地名、里名…" value="${esc(state.query)}" data-act="search" aria-label="搜尋">
    ${isl.map((i) => `<button type="button" class="isl-row" data-act="island" data-id="${i.id}"><span class="dot" style="background:${AXIS_COLOR[i.axis]}">島</span><span class="name">${esc(i.name)}<small>${esc(i.pledge || "")}</small></span></button>`).join("")}
    ${listHTML(idx)}`;
}

function renderProject() {
  const p = projectById[state.project];
  const idx = data.items.map((_, n) => n).filter((n) => data.items[n].p === p.id).sort(byWeight);
  const isl = [...new Set(idx.map((n) => data.items[n].i))].filter((id) => islandById[id]);
  return `<button type="button" class="back" data-act="home">← 全部島嶼</button>
    <p class="p-kicker">專案</p><h2 class="p-title">${esc(p.name)}</h2>
    ${isl.length ? `<div class="chips">${isl.map((id) => `<button type="button" data-act="island" data-id="${id}">${esc(islandById[id].name)}</button>`).join("")}</div>` : ""}
    ${listHTML(idx)}`;
}

function renderVillage() {
  const idx = visibleItems(data.items.map((_, n) => n).filter((n) => data.items[n].v.includes(state.village)))
    .sort(byWeight);
  return `<button type="button" class="back" data-act="villages">← 鳳山各里</button>
    <p class="p-kicker">鳳山各里</p><h2 class="p-title">${esc(state.village)}</h2>
    ${listHTML(idx)}`;
}

function huiwenSummary(id) {
  const isl = islandById[id];
  const names = isl.flagships.slice(0, 3).map((n) => data.items[n].t);
  return `<div class="hw-sum"><b>慧文做了什麼</b><p>${names.length ? `${names.map(esc).join("、")}。` : ""}</p></div>`;
}
function laiFor(id) {
  return (data.laiAchievements || []).filter((a) => a.islands.includes(id));
}
function laiCards(list) {
  return list.map((a) => `<div class="link-card"><h4>${esc(a.title)}${a.year ? `<small>${esc(a.year)}</small>` : ""}</h4><p>${esc(a.detail)}</p></div>`).join("");
}
function laiPoliciesFor(id) {
  return (data.laiPolicies || []).filter((p) => p.islands.includes(id));
}
function laiPolicyCards(list) {
  return list.map((p) => `<div class="link-card lai-policy"><h4>${esc(p.title)}<small>市長政見</small></h4><p>${esc(p.summary)}</p></div>`).join("");
}
function laiHTML(id) {
  const list = laiFor(id), pols = laiPoliciesFor(id);
  if (!list.length && !pols.length) return "";
  return `${huiwenSummary(id)}<p class="axis">認識賴瑞隆</p>${laiPolicyCards(pols)}${laiCards(list)}`;
}
function renderLai() {
  let html = `<button type="button" class="back" data-act="home">← 全部島嶼</button>
    <p class="p-kicker">認識賴瑞隆</p><h2 class="p-title">賴瑞隆做了什麼</h2>`;
  html += `<p class="p-lead">賴瑞隆的市長政見與立委政績，對照慧文在同一座島做過的事。</p>`;
  for (const isl of islands) {
    const list = laiFor(isl.id), pols = laiPoliciesFor(isl.id);
    if (!list.length && !pols.length) continue;
    html += `<p class="axis"><button type="button" class="back" style="margin:0" data-act="island" data-id="${isl.id}">${esc(isl.name)} →</button></p>${huiwenSummary(isl.id)}${laiPolicyCards(pols)}${laiCards(list)}`;
  }
  const otherPol = (data.laiPolicies || []).filter((p) => !p.islands.some((id) => islandById[id]));
  if (otherPol.length) html += `<p class="axis">其他市長政見</p>${laiPolicyCards(otherPol)}`;
  const rest = data.laiAchievements.filter((a) => !a.islands.some((id) => islandById[id]));
  if (rest.length) html += `<p class="axis">其他政績</p>${laiCards(rest)}`;
  return html;
}

function interpSessions() {
  return [...(interp?.sessions || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function renderInterp(isl) {
  let html = `<button type="button" class="back" data-act="home">← 全部島嶼</button>${spotCardHTML()}
    <p class="p-kicker">議會</p><h2 class="p-title">${esc(isl.name)}</h2>
    <p class="p-lead">慧文在議會問了什麼，同一件事最後發展是什麼。</p>`;
  if (!interp) return html + `<p class="empty">質詢資料整理中。</p>`;
  const threads = interp.threads || [];
  html += threads.map((t) => `<section class="thread">
      <h4>${esc(t.title)}${t.island && islandById[t.island] ? ` <button type="button" class="back" style="margin:0 0 0 6px" data-act="island" data-id="${t.island}">→ ${esc(islandById[t.island].name)}</button>` : ""}</h4>
      <ol>${(t.steps || []).map((s) => `<li><time>${esc(s.date)}</time>${esc(s.point)}</li>`).join("")}</ol>
      ${t.note ? `<p class="outcome">${esc(t.note)}</p>` : ""}
    </section>`).join("");
  const sessions = interpSessions();
  const hosted = hearings.map((h, i) => ({ h, i })).filter(({ h }) => h.role !== "出席");
  if (hosted.length) html += `<p class="axis">主持的公聽會</p>${hearingRows(hosted)}`;
  html += `<p class="axis">歷次紀錄</p>` + sessions.slice(0, state.limit).map((s, i) => `<article class="item">
      <h4><button type="button" class="item-title" data-act="session" data-n="${i}">${esc(s.date)}${(s.targets || []).length ? `｜${esc(s.targets.join("、"))}` : ""}</button></h4>
      ${(s.points || []).length ? `<ul class="mini-tl">${s.points.slice(0, 3).map((pt) => `<li>${esc(pt.topic || pt.said)}</li>`).join("")}</ul>` : ""}
      ${(s.topics || []).length ? `<p>${(s.topics || []).map(esc).join("<br>")}</p>` : ""}
      ${s.summary && !(s.topics || []).length ? `<p>${esc(s.summary)}</p>` : ""}${s.quote ? `<p>「${esc(s.quote)}」</p>` : ""}
      </article>`).join("");
  if (sessions.length > state.limit) html += `<button type="button" class="more" data-act="more">再顯示更多</button>`;
  return html;
}

// 地標卡（點島上的意象圖後出現在島名上方）
function spotCardHTML() {
  const sp = state.spot;
  return sp ? `<div class="spot-card"><div class="spot-text"><p class="spot-kicker">地標</p><h3>${esc(sp.name)}</h3>${sp.addr ? `<p class="spot-addr">${esc(sp.addr)}</p>` : ""}<p class="spot-note">${esc(sp.note || "")}</p></div><img class="spot-thumb" data-thumb="${esc(sp.kind)}/${esc(sp.id)}" alt="${esc(sp.name)} 3D 模型"></div>` : "";
}
function renderIsland() {
  const isl = islandById[state.island];
  if (isl.kind === "interpellation") return renderInterp(isl);
  const all = itemsByIsland[isl.id] || [];
  const layers = LAYERS.filter((l) => all.filter((n) => data.items[n].layer === l).length >= 10);
  const flag = new Set(isl.flagships);
  let idx = visibleItems(all).filter((n) => state.layer === "全部" || data.items[n].layer === state.layer);
  idx.sort(byWeight);
  if (state.focusItem != null) idx = [state.focusItem, ...idx.filter((n) => n !== state.focusItem)];
  const axis = axisById[isl.axis];
  const spotCard = spotCardHTML();
  return `<button type="button" class="back" data-act="home">← 全部島嶼</button>${spotCard}
    <p class="p-kicker">${esc(axis?.name || "")}</p><h2 class="p-title">${esc(isl.name)}</h2>
    ${isl.pledge ? `<div class="pledge"><small>2026 政見</small><p>${esc(isl.pledge)}</p></div>` : `<div class="pledge"><small>長期推動政見</small><p>${esc(isl.note || isl.name)}</p></div>`}
    ${isl.highlight ? `<div class="highlight-card"><span>${esc(isl.highlight.tag)}</span><h3>${esc(isl.highlight.title)}</h3><p>${esc(isl.highlight.text)}</p></div>` : ""}
    ${laiHTML(isl.id)}
    ${hearingsHTML(isl.id)}
    ${layers.length > 1 ? `<div class="chips">${["全部", ...layers].map((l) => `<button type="button" data-act="layer" data-layer="${l}" aria-pressed="${state.layer === l}">${l === "會勘" ? "會勘紀錄" : l}</button>`).join("")}</div>` : ""}
    ${listHTML(idx, state.focusItem != null ? 1 : 0)}`;
}

function render() {
  const html = state.view === "project" ? renderProject() : state.view === "lai" ? renderLai() : state.view === "island" ? renderIsland() : state.view === "village" ? renderVillage() : state.view === "search" ? renderSearch() : renderHome();
  body.innerHTML = html;
  for (const [id, el] of Object.entries(labelEls)) {
    el.classList.toggle("active", state.view === "island" && state.island === id);
    el.classList.toggle("dim", state.view === "island" && state.island !== id);
  }
  for (const x of extraLabels) if (x.kind === "spot") x.el.classList.toggle("active", state.view === "island" && state.island === x.island);
  for (const img of body.querySelectorAll("img[data-thumb]")) { const [k, id] = img.dataset.thumb.split("/"); thumbnail(k, id).then((url) => { if (url) img.src = url; else img.remove(); }); }
  const input = body.querySelector(".search");
  if (input && state.view === "search") { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function spotFor(island, spotId) {
  if (spotId) return SPOT_INFO[spotId] ? { kind: "landmarks", id: spotId, ...SPOT_INFO[spotId] } : null;
  const info = scenery?.LANDMARK_INFO?.[island];
  return info ? { kind: "landmarks", id: island, ...info } : null;
}
function openIsland(id, fly, itemIdx = null, spot = null) {
  life?.selectIsland(id);
  Object.assign(state, { view: "island", island: id, layer: "全部", limit: 40, focusItem: itemIdx, spot });
  dotCards?.selectIsland(id);
  showItemPins(id);
  setPanel(true);
  render();
  body.scrollTop = 0;
  if (fly) focusOn(islandCenter[id], mobile() ? 2.1 : 2.4);
  // 點中央議會：亮線連到慧文質詢過的各島
  if (id === "Q1" && interp?.threads) life?.showConnections(["Q1", ...interp.threads.map((t) => t.island).filter(Boolean)]);
  try { history.replaceState(null, "", `?island=${id}`); } catch {}
}
function goHome() {
  Object.assign(state, { view: "home", island: null, limit: 40, focusItem: null });
  dotCards?.selectIsland(null);
  showItemPins(null);
  render();
  home();
  try { history.replaceState(null, "", location.pathname); } catch {}
}

body.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  if (act === "island") openIsland(t.dataset.id, true);
  else if (act === "home") goHome();
  else if (act === "card") openCard(Number(t.dataset.n));
  else if (act === "hearing") openHearing(Number(t.dataset.n));
  else if (act === "session") openSession(Number(t.dataset.n));
  else if (act === "project") { Object.assign(state, { view: "project", project: t.dataset.id, limit: 40 }); life?.showConnections(data.items.filter(x=>x.p===t.dataset.id).map(x=>x.i)); render(); body.scrollTop = 0; }
  else if (act === "lai") { state.view = "lai"; render(); body.scrollTop = 0; }
  else if (act === "tab") { Object.assign(state, { view: "home", tab: t.dataset.tab }); render(); }
  else if (act === "villages") { Object.assign(state, { view: "home", tab: "villages" }); render(); }
  else if (act === "village") { Object.assign(state, { view: "village", village: t.dataset.v, limit: 40 }); render(); body.scrollTop = 0; }
  else if (act === "layer") { Object.assign(state, { layer: t.dataset.layer, limit: 40 }); render(); }
  else if (act === "more") { state.limit += 40; const y = body.scrollTop; render(); body.scrollTop = y; }
});
// 搜尋：中文選字（注音、倉頡）組字中不重畫，選字完成後稍等再更新結果
let searchTimer = 0;
function runSearch(value) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = value;
    state.limit = 40;
    state.view = state.query.trim() ? "search" : "home";
    render();
  }, 220);
}
body.addEventListener("input", (e) => {
  if (e.target.dataset.act !== "search" || e.isComposing) return;
  runSearch(e.target.value);
});
body.addEventListener("compositionend", (e) => {
  if (e.target.dataset.act === "search") runSearch(e.target.value);
});

const SHEET = { peek: 128 };
let sheetState = "half";
function sheetHeight(state) { return state === "peek" ? SHEET.peek : state === "full" ? Math.round(innerHeight * 0.9) : Math.round(innerHeight * 0.5); }
function setSheet(state) {
  sheetState = state;
  document.documentElement.style.setProperty("--sheet-h", `${sheetHeight(state)}px`);
  document.body.classList.toggle("sheet-peek", state === "peek");
  requestAnimationFrame(resize);
}
function setPanel(open, state = "half") {
  panelOpen = open;
  document.body.classList.toggle("panel-closed", !open);
  $("#btn-list").setAttribute("aria-expanded", String(open));
  if (mobile() && open) setSheet(state);
  requestAnimationFrame(resize);
}
$("#btn-list").addEventListener("click", () => setPanel(!panelOpen));
// 把手：點一下在半開／只露標題之間切換；往下拖到底就收起，往上拖就全開
{
  const handle = $("#panel-handle");
  let drag = null;
  handle.addEventListener("pointerdown", (e) => { drag = { y: e.clientY, h: sheetHeight(sheetState), moved: false }; handle.setPointerCapture(e.pointerId); });
  handle.addEventListener("pointermove", (e) => {
    if (!drag || !mobile()) return;
    const h = Math.max(60, Math.min(innerHeight * 0.92, drag.h + (drag.y - e.clientY)));
    if (Math.abs(drag.y - e.clientY) > 6) drag.moved = true;
    document.documentElement.style.setProperty("--sheet-h", `${h}px`);
  });
  const release = (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY, h = drag.h + dy;
    drag = null;
    if (!mobile()) return;
    if (!drag && Math.abs(dy) <= 6) { setSheet(sheetState === "peek" ? "half" : "peek"); return; }
    if (h < 90) { setPanel(false); return; }
    setSheet(h > innerHeight * 0.7 ? "full" : h < innerHeight * 0.3 ? "peek" : "half");
  };
  handle.addEventListener("pointerup", release);
  handle.addEventListener("pointercancel", release);
}
$("#btn-home").addEventListener("click", goHome);


// ── 開場導覽 ────────────────────────────────────────────────────
// 開場只有一張卡：自己逛，或讓導覽從中央的議會帶一圈
function closeIntro() {
  $("#intro").hidden = true;
  try { localStorage.setItem("huiwen-island-intro", "1"); } catch {}
}
$("#intro-skip").addEventListener("click", closeIntro);
$("#btn-night").addEventListener("click", (e) => {
  const next = weather?.cycleMode();  // 自動 → 白天 → 夜晚 → 自動
  e.currentTarget.textContent = { auto: "日夜", day: "白天", night: "夜晚" }[next] || "日夜";
  e.currentTarget.setAttribute("aria-pressed", String(next !== "auto"));
});
$("#intro-tour").addEventListener("click", () => { closeIntro(); life?.startTour?.(); });
let seen = false;
try { seen = localStorage.getItem("huiwen-island-intro") === "1"; } catch {}
const startIsland = new URLSearchParams(location.search).get("island");
if (!seen && !startIsland) $("#intro").hidden = false;

// Task 7 additive integration; cards module may pass these same callbacks.
life=createIslandLife({scene,world,camera,controls,renderer,islandCenter,islandCells:Object.fromEntries(Object.entries(LAYOUT).map(([id,cells])=>[id,cells.map(c=>cellPos(...c))])),data,onIsland:openIsland,onItem:openCard});
const ticker=createTicker({element:$('#citylog'),items:data.items,onItem:openCard,reduced:()=>life.reduced});
const streetMotion=createStreetMotion({walkers,cars,traffic,hexPoint,TOP,actors,sirenRed,sirenBlue});
streetMotion.update(0,0,life.reduced);
extras.update(0,0);riverInfo.update(0);traffic.update(0,0);
for(const w of wanderers){const p=hexPoint(cellPos(...w.cell),ROAD_MID,w.u);w.g.position.set(p.x,TOP+.08,p.z);}followLonglong();

canvas.addEventListener('pointerleave',()=>life.hoverIsland(null));
// 滑鼠與觸控手感：懸停浮起、點擊漣漪、雙擊聚焦、平移範圍
feel=createInteraction({THREE,scene,camera,controls,canvas,pickables,TOP,reduced:()=>life.reduced,onDragStart:()=>life.flyTo(controls.target,camera.zoom,1e-3),onDoubleTap:(e)=>{pick(e);const p=lastHit?.point;if(p)focusOn(new THREE.Vector3(p.x,0,p.z),Math.min(5,Math.max(camera.zoom*1.7,2.2)));}});
{ const ld = $("#loading"); ld?.classList.add("done"); setTimeout(() => ld?.remove(), 700); }
// Rig-free simulated greeting: no extra arms and no GLB skeleton requirement.
const huiwenGreeting=createSimulatedGreeting(huiwen);
canvas.addEventListener('pointerup',e=>{if(!downAt || Math.hypot(e.clientX-downAt[0],e.clientY-downAt[1])>6)return;const u=pick(e);if(u?.huiwen)huiwenGreeting.trigger();if(u?.figure?.startsWith('陳慧文站路口'))cornerWave?.play();});
// ── 啟動 ────────────────────────────────────────────────────────
if (mobile()) setPanel(true, "peek");
resize();
controls.target.set(0, 0, 0);
render();
// 深層連結：等相機與控制器跑過第一幀再飛過去，否則會飛到錯的位置
if (startIsland && islandById[startIsland]) setTimeout(() => openIsland(startIsland, true), 80);  // 背景分頁不跑 rAF，用 timeout 比較穩

// 林 dot Task 8：圖卡、政績探索、比較、年份、分享圖卡、活動
try {
  dotCards = createIslandCards({ data, THREE, world, islandCenter, flagshipGroups, life,
    onSelectIsland: (id) => openIsland(id, true),
    onProject: (id) => { Object.assign(state, { view: "project", project: id, limit: 40 }); render(); } });
  if (state.island) dotCards.selectIsland(state.island);
} catch (err) { console.warn("圖卡模組暫未載入", err); dotCards = null; }
weather = addWeather({ THREE, scene, setNight: extras.setNight, rng });
const clock = new THREE.Clock();
let activeTime=0,frameAccumulator=0;
renderer.setAnimationLoop(()=>{
 let dt=Math.min(clock.getDelta(),.05);if(document.hidden){frameAccumulator=0;return;}
 frameAccumulator+=dt;if(mobile() && frameAccumulator<1/30)return;dt=Math.min(frameAccumulator,.1);frameAccumulator=0;
 const reducedNow=life.reduced;activeTime+=reducedNow?0:dt;
 for(const c of railparkControllers.values()){c.setReducedMotion?.(reducedNow);c.update(dt);}
 life.update(dt,activeTime);ticker.update(dt);
 extras.update(dt,activeTime);weather?.update(dt);traffic.update(reducedNow?0:dt,activeTime);
 if(!reducedNow){stepTour(dt);followLonglong();stepWanderers(dt);riverInfo.update(dt);}
 streetMotion.update(dt,activeTime,reducedNow);
 huiwenGreeting.update(dt,reducedNow);feel.update(dt);if(!reducedNow)backdrop.update(dt);cornerWave?.update(dt,reducedNow);
 dotCards?.update(dt);document.body.classList.toggle('touring',!!life.touring);controls.update();longlongDialogue?.update(dt);renderer.render(scene,camera);placeLabels();
});
window.addEventListener('pagehide',()=>{renderer.setAnimationLoop(null);life.dispose();ticker.dispose();dotCards?.dispose();streetMotion.dispose();huiwenGreeting.dispose();actors.dispose();},{once:true});
