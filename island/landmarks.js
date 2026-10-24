// 慧文政績島｜鳳山景色地標
// 原生 ES module，不 import 任何模組；three.js 由主程式以 kit.THREE 傳入。
// 每座地標：底部 y=0、置中於原點、水平半徑 4 以內、高度 3–8、10–40 個 mesh。

export const LANDMARK_INFO = {
  P01: { name: "捷運鳳山西站", note: "高雄捷運橘線 O11，副站名高雄市議會，是鳳山往來市區的起點。" },
  P02: { name: "鳳山車站", note: "鐵路地下化後的新站大樓，金色拱門、站前廣場與無障礙轉乘動線成為鳳山的新門戶。" },
  P03: { name: "曹公圳水岸", note: "道光年間曹謹開鑿的灌溉水圳，至今仍是鳳山農田與城市排水的重要動脈。" },
  P04: { name: "鳳山中華街觀光夜市", note: "鳳山中華街上的老夜市，攤位燈籠一路排開，是在地人宵夜與逛街的去處。" },
  P05: { name: "鳳山第一公有零售市場（兵仔市）", note: "中山路上的老市場，清晨的菜攤、吆喝聲與塑膠籃是鳳山最日常的風景。" },
  P06: { name: "鳳儀書院", note: "全臺現存規模最大的書院，燕尾脊下收藏鳳山兩百年的文教記憶。" },
  P07: { name: "黃埔新村", note: "臺灣最早的眷村之一，水泥磚造的紅門平房與巷弄，如今成為青年創業與文化體驗的基地。" },
  P08: { name: "大東文化藝術中心", note: "白色帳篷屋頂與漏斗柱下，藏著全臺首座藝術圖書館與親子閱讀空間。" },
  P09: { name: "鳳山醫院", note: "陪伴鳳山人的區域醫院，從急診、門診到社區照護都在這裡。" },
  P10: { name: "衛武營國家藝術文化中心", note: "全球最大單一屋頂綜合劇院，白色波浪屋頂下是開放給所有人的文化客廳。" },
  P11: { name: "鳳山中山公園", note: "鳳山老牌公園，老樹、池塘與大草皮是在地人遛狗散步的日常綠洲。" },
  P12: { name: "國立鳳山高中", note: "1939 年創校的鳳山名校，淺灰米色的校舍與大操場承載許多鳳山人的青春。" },
  P13: { name: "五甲國小", note: "五甲生活圈的社區小學，校門口的通學步道與放學人潮，是守護孩子最日常的現場。" },
  X1: { name: "鳳山國小", note: "1896 年創校的百年老校，紅磚拱廊與大榕樹是校園最經典的畫面。" },
  X2: { name: "鳳山運動園區", note: "高雄市首座國民運動中心，田徑場、體育館與游泳池讓全年齡都能動起來。" },
  X3: { name: "東便門與東福橋", note: "鳳山縣新城僅存的小東門，門外的東福橋至今仍是居民步行往返市中心的捷徑。" },
  X4: { name: "鳳山行政中心（公所）", note: "鳳山的市政服務中心，從調解、社福到里鄰事務都在這裡一站處理。" },
  LCG: { name: "五甲龍成宮", note: "五甲地區的信仰中心，紅瓦燕尾脊的大廟，廟埕是社區活動與節慶的聚集地。" },
  Q1: { name: "高雄市議會", note: "高雄市最高民意機關，白色列柱與山牆正對著鳳山的天空。" },
};

// ── 柔和色票 ──────────────────────────────────────────────────
const C = {
  cream: "#f5ecd9", paper: "#fbf7ec", white: "#fffaf0",
  stone: "#cfc6b4", stoneDark: "#a9a193", concrete: "#d8d2c6",
  brick: "#b45f4a", brickDark: "#8f4738", brickLight: "#c97a5f",
  tile: "#7d8386", tileDark: "#5f6669", tileRed: "#a95542",
  wood: "#7a4e35", woodDark: "#543726", woodLight: "#9a6a4a",
  red: "#b03a2e", redDark: "#8e2f26", gold: "#d9a441", goldLight: "#f0cf7a",
  green: "#5d9c5a", greenDark: "#3f7a4a", greenLight: "#9fd08a",
  water: "#7cc3d0", waterDark: "#5aa7b8", waterLight: "#b7e3e8",
  orange: "#e08a3c", pink: "#e48f9e", purple: "#8f84cf", blue: "#4f9fc4",
  glass: "#a9d3d8", glassDark: "#5f8f96", gray: "#6f7b7e",
};

// ── 幾何小工具 ────────────────────────────────────────────────

// 三角形山牆／山花：底寬 w、高 h、厚 d，底部在 y。
function pediment(g, kit, w, h, d, x, y, z, color) {
  const T = kit.THREE;
  const s = new T.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(0, h);
  s.closePath();
  const geo = new T.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
  geo.translate(0, 0, -d / 2);
  const m = kit.mesh(geo, color);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

// 有圓拱開口的牆：牆寬 w、高 h、厚 d，拱寬 aw、起拱高 spring。
function archWall(g, kit, w, h, d, aw, spring, color, x, y, z, opts) {
  const T = kit.THREE;
  const s = new T.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, h);
  s.lineTo(-w / 2, h);
  s.closePath();
  const hole = new T.Path();
  hole.moveTo(-aw / 2, 0);
  hole.lineTo(-aw / 2, spring);
  hole.absarc(0, spring, aw / 2, Math.PI, 0, true);
  hole.lineTo(aw / 2, 0);
  hole.closePath();
  s.holes.push(hole);
  const geo = new T.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 8 });
  geo.translate(0, 0, -d / 2);
  const m = kit.mesh(geo, color, opts);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

// 貼在牆面上的半圓拱線條。
function archRing(g, kit, r, tube, x, y, z, color) {
  const T = kit.THREE;
  const m = kit.mesh(new T.TorusGeometry(r, tube, 5, 14, Math.PI), color);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

// 雙坡屋頂，脊線沿 x；牆色 wall 有值時補上山牆三角。
function gableRoof(g, kit, w, d, x, y, z, h, tile, ridge, wall) {
  const ow = w + 0.3;
  const od = d + 0.35;
  const ang = Math.atan2(h, od / 2);
  const len = Math.hypot(od / 2, h) + 0.06;
  const t = 0.12;
  const back = kit.box(ow, t, len, tile, x, y + h / 2 - t / 2, z - od / 4);
  kit.turn(back, "x", -ang);
  const front = kit.box(ow, t, len, tile, x, y + h / 2 - t / 2, z + od / 4);
  kit.turn(front, "x", ang);
  g.add(back, front);
  g.add(kit.box(ow + 0.12, 0.14, 0.2, ridge, x, y + h - 0.04, z));
  // 燕尾：脊端向上翹起
  for (const s of [-1, 1]) {
    const tip = kit.box(0.55, 0.09, 0.18, ridge, x + s * (ow / 2 + 0.02), y + h + 0.04, z);
    kit.turn(tip, "z", s * 0.52);
    g.add(tip);
  }
  if (wall) {
    pediment(g, kit, w, h, 0.12, x, y, z + d / 2 - 0.02, wall);
    pediment(g, kit, w, h, 0.12, x, y, z - d / 2 + 0.02, wall);
  }
}

// 簡化雙坡屋頂（2 片屋面＋1 根脊），用於低矮房舍。
function simpleGable(g, kit, w, d, x, y, z, h, tile, ridge) {
  const ow = w + 0.2;
  const od = d + 0.25;
  const ang = Math.atan2(h, od / 2);
  const len = Math.hypot(od / 2, h) + 0.04;
  const t = 0.1;
  const back = kit.box(ow, t, len, tile, x, y + h / 2 - t / 2, z - od / 4);
  kit.turn(back, "x", -ang);
  const front = kit.box(ow, t, len, tile, x, y + h / 2 - t / 2, z + od / 4);
  kit.turn(front, "x", ang);
  g.add(back, front);
  g.add(kit.box(ow + 0.05, 0.12, 0.16, ridge, x, y + h - 0.03, z));
}

// 四坡屋頂（低多邊形金字塔），可加脊飾。
function hipRoof(g, kit, w, d, x, y, z, h, tile, ridge) {
  const T = kit.THREE;
  const hw = w / 2, hd = d / 2;
  const verts = [-hw, 0, -hd, hw, 0, -hd, hw, 0, hd, -hw, 0, hd, 0, h, 0];
  const idx = [0, 4, 1, 1, 4, 2, 2, 4, 3, 3, 4, 0];
  const geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = kit.mesh(geo, tile, { side: T.DoubleSide });
  m.position.set(x, y, z);
  g.add(m);
  if (ridge) g.add(kit.cyl(0.05, 0.05, 0.2, 4, ridge, x, y + h, z));
}

// 面向前方的圓盤（鐘面、標誌）。
function disc(g, kit, r, color, x, y, z, thick = 0.05) {
  const T = kit.THREE;
  const m = kit.mesh(new T.CylinderGeometry(r, r, thick, 16), color);
  m.position.set(x, y, z);
  kit.turn(m, "x", Math.PI / 2);
  g.add(m);
  return m;
}

// 鳳儀書院的 Q 版人物：身體＋頭＋帽子。
function figure(g, kit, x, z, cloth, hat) {
  const T = kit.THREE;
  g.add(kit.cyl(0.09, 0.14, 0.35, 6, cloth, x, 0.2, z));
  const head = kit.mesh(new T.SphereGeometry(0.105, 8, 6), "#efc7a4");
  head.position.set(x, 0.63, z);
  g.add(head);
  g.add(kit.cone(0.13, 0.12, 6, hat, x, 0.7, z));
}

// 中山公園的狗：身體、頭、尾巴、兩隻耳朵。
function dog(g, kit, x, z, color) {
  const T = kit.THREE;
  g.add(kit.box(0.42, 0.2, 0.2, color, x, 0.18, z));
  const head = kit.mesh(new T.SphereGeometry(0.14, 8, 6), color);
  head.position.set(x + 0.28, 0.43, z);
  g.add(head);
  const tail = kit.box(0.3, 0.05, 0.05, color, x - 0.28, 0.36, z);
  kit.turn(tail, "z", 0.5);
  g.add(tail);
  for (const s of [-1, 1]) {
    const ear = kit.cone(0.05, 0.12, 4, color, x + 0.28, 0.52, z + s * 0.08);
    g.add(ear);
  }
}

// 廟口夜市攤：兩根柱子＋雨遮＋攤台。
function stall(g, kit, x, z, color) {
  g.add(kit.cyl(0.03, 0.03, 0.95, 4, C.woodDark, x - 0.42, 0.2, z - 0.28));
  g.add(kit.cyl(0.03, 0.03, 0.95, 4, C.woodDark, x + 0.42, 0.2, z - 0.28));
  const aw = kit.box(1.05, 0.06, 0.8, color, x, 1.1, z);
  kit.turn(aw, "x", -0.16);
  g.add(aw);
  g.add(kit.box(0.85, 0.32, 0.5, C.cream, x, 0.2, z));
}

// ── 地標建構子 ────────────────────────────────────────────────

function buildP01(g, kit) {
  g.add(kit.box(4, 0.2, 3, C.concrete));
  // 橘線站體與玻璃門面
  g.add(kit.box(3.2, 1.5, 1.8, C.orange, 0, 0.2, -0.4));
  g.add(kit.box(3.0, 0.9, 0.06, C.glassDark, 0, 0.35, 0.52));
  for (let i = 0; i < 3; i++) g.add(kit.box(0.72, 0.85, 0.05, C.glass, -0.86 + i * 0.86, 0.35, 0.56));
  // 橘色門楣，讓捷運站的識別更清楚
  g.add(kit.box(3.2, 0.32, 0.08, C.orange, 0, 1.3, 0.55));
  // 灰色懸挑雨遮
  g.add(kit.box(3.8, 0.14, 2.2, C.stoneDark, 0, 1.75, -0.2));
  for (const x of [-1.5, 1.5]) for (const z of [-0.9, 0.6]) g.add(kit.cyl(0.07, 0.07, 1.55, 5, C.gray, x, 0.2, z));
  // 後方較高的站務大樓
  g.add(kit.box(1.35, 3.2, 1.2, C.cream, 1.0, 0.2, -1.1));
  for (let i = 0; i < 3; i++) g.add(kit.box(1.0, 0.18, 0.05, C.gray, 1.0, 0.55 + i * 0.85, -0.49));
  // 入口與下行階梯
  g.add(kit.box(1.3, 1.0, 0.08, C.glassDark, 0, 0.2, 0.53));
  for (let i = 0; i < 3; i++) g.add(kit.box(1.6 - i * 0.1, 0.12, 0.28, C.concrete, 0, 0.08 + i * 0.1, 1.0 + i * 0.22));
  // O11 圖騰柱
  g.add(kit.cyl(0.05, 0.05, 2.0, 4, C.gray, -1.75, 0.2, 1.1));
  g.add(kit.box(0.5, 0.5, 0.1, C.orange, -1.75, 2.0, 1.1));
  g.add(kit.box(0.3, 0.3, 0.04, C.white, -1.75, 2.1, 1.16));
  disc(g, kit, 0.12, C.orange, -1.75, 2.25, 1.19);
  kit.tree(g, -1.7, -1.1, 0.8, C.green);
  kit.tree(g, 1.7, 1.1, 0.7, C.greenDark);
}

function buildP02(g, kit) {
  g.add(kit.box(4, 0.2, 3.2, C.greenLight));
  // 鳳山溪與東福橋
  g.add(kit.box(2.6, 0.1, 1.0, C.waterDark, -0.6, 0.2, 1.1));
  g.add(kit.box(2.6, 0.28, 0.18, C.stone, -0.6, 0.08, 0.6));
  g.add(kit.box(2.6, 0.28, 0.18, C.stone, -0.6, 0.08, 1.6));
  g.add(kit.box(1.7, 0.12, 0.9, C.stone, 0, 0.42, 1.1));
  g.add(kit.box(0.22, 0.4, 0.9, C.stoneDark, -0.6, 0.12, 1.1));
  g.add(kit.box(0.22, 0.4, 0.9, C.stoneDark, 0.6, 0.12, 1.1));
  for (const s of [-1, 1]) g.add(kit.box(1.7, 0.32, 0.06, C.stoneDark, 0, 0.54, 1.1 + s * 0.45));
  // 紅磚步道穿過城門
  g.add(kit.box(3.6, 0.06, 0.7, C.brickLight, 0, 0.2, -0.2));
  // 城牆與圓拱門洞
  archWall(g, kit, 3.4, 2.2, 0.8, 1.25, 0.9, C.stone, 0, 0.2, -0.6);
  archRing(g, kit, 0.625, 0.08, 0, 1.1, -0.18, C.stoneDark);
  g.add(kit.box(1.1, 1.5, 0.5, C.woodDark, 0, 0.2, -1.0));
  // 城垛與磚頂
  g.add(kit.box(3.5, 0.25, 0.9, C.brick, 0, 2.4, -0.6));
  for (let i = 0; i < 5; i++) g.add(kit.box(0.45, 0.45, 0.85, C.brick, -1.4 + i * 0.7, 2.65, -0.6));
  // 咾咕石牆基
  for (let i = 0; i < 4; i++) g.add(kit.box(0.7, 0.3, 0.06, C.stoneDark, -1.2 + i * 0.8, 0.25, -0.18));
  // 門額
  g.add(kit.box(0.9, 0.35, 0.06, C.brickDark, 0, 2.0, -0.17));
  g.add(kit.box(0.7, 0.2, 0.03, C.goldLight, 0, 2.07, -0.13));
  // 東福祠
  g.add(kit.box(1.0, 0.8, 0.8, C.red, 1.25, 0.2, 0.35));
  g.add(kit.box(0.8, 0.5, 0.04, C.woodDark, 1.25, 0.4, 0.77));
  hipRoof(g, kit, 1.15, 0.95, 1.25, 1.0, 0.35, 0.35, C.tileRed, C.gold);
  kit.tree(g, -1.7, 1.5, 0.8, C.green);
  kit.tree(g, 1.7, -1.1, 0.9, C.greenDark);
}

function buildP03(g, kit) {
  g.add(kit.box(4, 0.2, 3.2, C.greenLight));
  // 曹公圳由後方流向前景，兩側是石砌護岸
  g.add(kit.box(1.4, 0.14, 3.2, C.waterDark, 0.4, 0.2, 0));
  g.add(kit.box(0.12, 0.04, 3.0, C.waterLight, 0.25, 0.3, 0));
  g.add(kit.box(0.12, 0.04, 3.0, C.waterLight, 0.55, 0.3, 0));
  g.add(kit.box(0.22, 0.4, 3.2, C.stone, -0.4, 0.2, 0));
  g.add(kit.box(0.22, 0.4, 3.2, C.stone, 1.2, 0.2, 0));
  // 橫跨水圳的石拱橋
  archWall(g, kit, 2.0, 0.9, 0.55, 1.3, 0.2, C.stone, 0.4, 0.2, 0.5);
  g.add(kit.box(2.2, 0.12, 0.8, C.stone, 0.4, 1.1, 0.5));
  for (const s of [-1, 1]) g.add(kit.box(2.2, 0.3, 0.06, C.stoneDark, 0.4, 1.22, 0.5 + s * 0.34));
  g.add(kit.box(0.9, 0.18, 0.3, C.stone, 0.4, 0.2, 1.05));
  // 水閘門
  g.add(kit.box(0.25, 1.8, 0.35, C.stoneDark, -0.2, 0.2, -1.0));
  g.add(kit.box(0.25, 1.8, 0.35, C.stoneDark, 1.0, 0.2, -1.0));
  g.add(kit.box(1.3, 0.18, 0.4, C.wood, 0.4, 1.9, -1.0));
  g.add(kit.box(0.7, 1.2, 0.08, C.gray, 0.4, 0.3, -1.0));
  const wheel = kit.cyl(0.18, 0.18, 0.1, 8, C.gold, 0.4, 2.0, -1.0);
  kit.turn(wheel, "x", Math.PI / 2);
  g.add(wheel);
  // 左岸的曹公祠
  g.add(kit.box(1.6, 0.25, 1.0, C.stone, -1.2, 0.2, -0.9));
  g.add(kit.box(1.45, 0.9, 0.7, C.paper, -1.2, 0.45, -0.9));
  g.add(kit.box(1.45, 0.25, 0.75, C.brick, -1.2, 0.45, -0.9));
  g.add(kit.box(0.45, 0.55, 0.05, C.woodDark, -1.2, 0.55, -0.52));
  gableRoof(g, kit, 1.55, 0.8, -1.2, 1.35, -0.9, 0.65, C.tileRed, C.gold, C.paper);
  g.add(kit.box(0.55, 0.18, 0.05, C.brickDark, -1.2, 1.1, -0.5));
  g.add(kit.box(0.45, 0.1, 0.03, C.goldLight, -1.2, 1.15, -0.47));
  // 右岸水田
  for (let i = 0; i < 3; i++) g.add(kit.box(0.9, 0.15, 0.26, C.green, 1.55, 0.2, -0.2 - i * 0.3));
  kit.tree(g, 1.6, -1.3, 1.8, C.green);
  kit.tree(g, -1.7, 1.2, 0.8, C.greenDark);
}

function buildP04(g, kit) {
  g.add(kit.box(4, 0.15, 3.4, C.tileDark));
  g.add(kit.box(1.0, 0.05, 3.2, "#8a8f93", 0, 0.15, 0));  // 中間走道
  // 入口牌樓
  for (const x of [-1.5, 1.5]) g.add(kit.box(0.2, 2.6, 0.2, C.red, x, 0.15, 1.5));
  g.add(kit.box(3.4, 0.45, 0.25, C.red, 0, 2.6, 1.5));
  g.add(kit.box(2.0, 0.3, 0.05, C.goldLight, 0, 2.68, 1.64));
  // 兩排攤位
  const colors = [C.orange, C.blue, C.pink, C.red, C.green, C.purple];
  for (let i = 0; i < 4; i++) for (const s of [-1, 1]) {
    const z = -1.2 + i * 0.8, col = colors[(i * 2 + (s > 0 ? 1 : 0)) % colors.length];
    g.add(kit.box(1.0, 0.7, 0.65, C.white, s * 1.15, 0.15, z));
    const roof = kit.box(1.15, 0.08, 0.8, col, s * 1.1, 1.1, z);
    roof.rotation.z = s * 0.25;
    g.add(roof);
    for (const x of [-0.45, 0.45]) g.add(kit.box(0.05, 1.0, 0.05, C.gray, s * 1.15 + x, 0.15, z + 0.3));
  }
  // 燈籠串
  for (let i = 0; i < 6; i++) {
    const l = kit.mesh(new kit.THREE.SphereGeometry(0.13, 8, 6), i % 2 ? C.red : C.goldLight, { emissive: i % 2 ? "#ff3a2a" : "#ffc93c", emissiveIntensity: 0.6 });
    l.position.set(0, 1.9, -1.3 + i * 0.5);
    g.add(l);
  }
  g.add(kit.box(0.03, 0.03, 3.0, C.gray, 0, 2.0, 0.0));
  figure(g, kit, -0.15, 0.4, C.blue, C.goldLight);
  figure(g, kit, 0.2, -0.3, C.pink, C.gray);
}

function buildP05(g, kit) {
  g.add(kit.box(4, 0.2, 3, C.concrete));
  // 市場主體
  g.add(kit.box(3.2, 1.5, 1.6, C.cream, 0, 0.2, -0.5));
  g.add(kit.box(3.4, 0.15, 1.9, C.tileDark, 0, 1.7, -0.5));
  // 綠色招牌帶
  g.add(kit.box(3.3, 0.35, 0.1, C.greenDark, 0, 1.35, 0.32));
  g.add(kit.box(2.6, 0.12, 0.04, C.white, 0, 1.48, 0.38));
  // 三個開放攤位
  for (const x of [-0.95, 0, 0.95]) {
    g.add(kit.box(0.7, 1.0, 0.06, C.woodDark, x, 0.4, 0.32));
    g.add(kit.box(0.8, 0.12, 0.08, C.redDark, x, 1.25, 0.34));
  }
  for (const x of [-1.45, 1.45]) g.add(kit.cyl(0.07, 0.07, 1.3, 5, C.gray, x, 0.2, 0.3));
  // 前方棚攤
  for (let i = 0; i < 3; i++) {
    const x = -1.2 + i * 1.2;
    g.add(kit.cyl(0.03, 0.03, 0.9, 4, C.woodDark, x - 0.35, 0.2, 1.1));
    g.add(kit.cyl(0.03, 0.03, 0.9, 4, C.woodDark, x + 0.35, 0.2, 1.1));
    const aw = kit.box(0.95, 0.06, 0.7, i % 2 ? C.orange : C.blue, x, 1.05, 1.1);
    kit.turn(aw, "x", -0.18);
    g.add(aw);
    g.add(kit.box(0.75, 0.3, 0.45, C.wood, x, 0.2, 1.1));
  }
  // 菜籃
  const crateColors = [C.green, C.orange, C.red, C.green];
  for (let i = 0; i < 4; i++) g.add(kit.box(0.28, 0.2, 0.28, crateColors[i], -1.4 + i * 0.55, 0.2, 1.55));
  // 屋頂水塔
  g.add(kit.cyl(0.25, 0.25, 0.7, 6, C.stone, 1.2, 1.85, -0.8));
  g.add(kit.box(0.12, 0.6, 0.12, C.gray, 1.2, 2.55, -0.8));
}

function buildP06(g, kit) {
  g.add(kit.box(4, 0.2, 3.6, C.stone));
  // 頭門
  g.add(kit.box(3.0, 1.1, 0.7, C.brick, 0, 0.2, 1.4));
  for (const x of [-0.85, 0, 0.85]) g.add(kit.box(0.45, 0.65, 0.06, C.woodDark, x, 0.3, 1.77));
  gableRoof(g, kit, 3.2, 0.8, 0, 1.3, 1.4, 0.8, C.tile, C.brickDark, C.paper);
  // 講堂（書院最高的一座）
  g.add(kit.box(2.4, 1.6, 0.9, C.paper, 0, 0.2, 0.1));
  g.add(kit.box(2.4, 0.25, 0.95, C.brick, 0, 0.2, 0.1));
  g.add(kit.box(0.45, 0.8, 0.06, C.wood, 0, 0.35, 0.58));
  gableRoof(g, kit, 2.6, 1.0, 0, 1.8, 0.1, 0.85, C.tile, C.brickDark, null);
  // 廳事
  g.add(kit.box(2.0, 0.95, 0.8, C.paper, 0, 0.2, -1.2));
  gableRoof(g, kit, 2.2, 0.8, 0, 1.15, -1.2, 0.5, C.tile, C.brickDark, null);
  // 兩廊
  for (const s of [-1, 1]) {
    g.add(kit.box(0.25, 0.8, 2.2, C.brick, s * 1.55, 0.2, 0.0));
    g.add(kit.box(0.4, 0.12, 2.3, C.tileDark, s * 1.55, 1.0, 0.0));
  }
  // 照壁
  g.add(kit.box(2.4, 0.8, 0.18, C.paper, 0, 0.2, 2.2));
  // 書院前的 Q 版人物
  figure(g, kit, -0.75, 1.0, C.blue, C.gold);
  figure(g, kit, 0.75, 1.0, C.pink, C.gold);
  kit.tree(g, -1.8, -1.2, 1.6, C.green);
}

function buildP07(g, kit) {
  g.add(kit.box(4, 0.2, 3, C.greenLight));
  g.add(kit.box(3.6, 0.06, 0.8, C.concrete, 0, 0.2, 0.4));
  // 後排三戶日式房舍
  for (let i = 0; i < 3; i++) {
    const x = -1.2 + i * 1.2;
    g.add(kit.box(0.95, 0.7, 1.2, C.woodLight, x, 0.2, -0.5));
    simpleGable(g, kit, 1.1, 1.35, x, 0.9, -0.5, 0.45, C.tileDark, C.woodDark);
  }
  // 前排兩戶
  for (const x of [-1.0, 1.0]) {
    g.add(kit.box(0.85, 0.6, 1.0, C.paper, x, 0.2, 0.95));
    simpleGable(g, kit, 1.0, 1.15, x, 0.8, 0.95, 0.4, C.tileDark, C.woodDark);
  }
  // 竹籬笆
  for (let i = 0; i < 3; i++) g.add(kit.box(1.1, 0.55, 0.05, C.wood, -1.3 + i * 1.3, 0.2, 1.55));
  // 村口門柱與木牌
  for (const s of [-1, 1]) g.add(kit.box(0.18, 2.6, 0.18, C.woodDark, s * 1.35, 0.2, 1.45));
  g.add(kit.box(3.0, 0.42, 0.18, C.wood, 0, 2.5, 1.45));
  g.add(kit.box(2.2, 0.24, 0.05, C.goldLight, 0, 2.6, 1.56));
  simpleGable(g, kit, 3.0, 0.5, 0, 2.92, 1.45, 0.3, C.tileDark, C.woodDark);
  // 青年工作室旗幟
  kit.flag(g, 1.35, 0.95, 0.2, C.orange, 1.1);
  kit.tree(g, -1.7, -1.0, 1.6, C.green);
  kit.tree(g, 1.7, -0.9, 1.0, C.greenDark);
}

function buildP08(g, kit) {
  g.add(kit.box(4, 0.2, 3, C.concrete));
  // 玻璃演藝廳
  g.add(kit.box(2.8, 1.5, 1.6, C.glass, 0, 0.2, -0.2));
  for (let i = 0; i < 4; i++) g.add(kit.box(0.06, 1.5, 0.06, C.stoneDark, -0.9 + i * 0.6, 0.2, 0.61));
  // 白色棚頂
  g.add(kit.box(3.8, 0.16, 2.6, C.white, 0, 3.0, -0.2));
  for (const s of [-1, 1]) {
    const e = kit.box(0.8, 0.1, 2.6, C.white, s * 1.95, 2.85, -0.2);
    kit.turn(e, "z", s * 0.18);
    g.add(e);
  }
  // 四根漏斗柱
  for (const x of [-1.3, 1.3]) for (const z of [-0.9, 0.5]) {
    g.add(kit.cyl(0.1, 0.1, 2.0, 6, C.white, x, 0.2, z));
    g.add(kit.cyl(0.55, 0.12, 0.7, 8, C.white, x, 2.2, z));
  }
  // 側牆菱形開窗
  for (let i = 0; i < 4; i++) {
    const d = kit.box(0.25, 0.25, 0.05, C.stoneDark, 1.42, 0.5 + i * 0.35, 0.3);
    kit.turn(d, "z", Math.PI / 4);
    g.add(d);
  }
  // 大東招牌
  g.add(kit.box(0.9, 0.3, 0.06, C.goldLight, 0, 2.0, 1.2));
  kit.tree(g, -1.7, 1.2, 0.8, C.green);
  kit.tree(g, 1.7, -1.2, 0.8, C.greenDark);
}

function buildP09(g, kit) {
  g.add(kit.box(3.8, 0.2, 3, C.concrete));
  // 白色醫療大樓
  g.add(kit.box(2.2, 3.4, 1.7, C.white, 0, 0.2, -0.5));
  for (let i = 0; i < 3; i++) g.add(kit.box(1.9, 0.25, 0.05, C.glassDark, 0, 0.7 + i * 0.85, 0.36));
  // 低層門診翼
  g.add(kit.box(1.2, 1.8, 1.2, C.cream, 1.3, 0.2, 0.0));
  g.add(kit.box(1.0, 0.25, 0.05, C.glass, 1.3, 1.0, 0.62));
  // 入口雨遮與柱子
  g.add(kit.box(2.0, 0.15, 1.0, C.white, 0, 1.3, 0.75));
  for (const x of [-0.8, 0.8]) g.add(kit.cyl(0.08, 0.08, 1.1, 6, C.gray, x, 0.2, 1.1));
  // 綠色十字
  g.add(kit.box(0.55, 0.16, 0.06, C.green, 0, 2.5, 0.38));
  g.add(kit.box(0.16, 0.55, 0.06, C.green, 0, 2.3, 0.38));
  // 救護車
  g.add(kit.box(0.8, 0.35, 0.45, C.white, -1.2, 0.2, 1.2));
  g.add(kit.box(0.45, 0.28, 0.45, C.white, -1.55, 0.5, 1.2));
  g.add(kit.box(0.82, 0.08, 0.47, C.red, -1.2, 0.45, 1.2));
  for (const x of [-1.45, -0.95]) g.add(kit.cyl(0.1, 0.1, 0.08, 8, C.gray, x, 0.12, 1.44));
  // 無障礙坡道
  const ramp = kit.box(1.2, 0.1, 0.8, C.concrete, 0.9, 0.2, 1.4);
  kit.turn(ramp, "z", -0.12);
  g.add(ramp);
  g.add(kit.box(1.2, 0.05, 0.05, C.gray, 0.9, 0.85, 1.75));
  g.add(kit.cyl(0.03, 0.03, 0.6, 4, C.gray, 0.35, 0.3, 1.75));
  g.add(kit.cyl(0.03, 0.03, 0.6, 4, C.gray, 1.45, 0.3, 1.75));
  kit.tree(g, -1.6, -1.1, 0.8, C.green);
}

function buildP10(g, kit) {
  g.add(kit.box(4, 0.2, 3.2, C.concrete));
  // 玻璃量體
  g.add(kit.box(3.6, 1.4, 2.2, C.glass, 0, 0.2, 0));
  for (let i = 0; i < 5; i++) g.add(kit.box(0.05, 1.4, 0.05, C.glassDark, -1.6 + i * 0.8, 0.2, 1.12));
  // 屋頂與玻璃量體之間的白色細柱
  for (const x of [-1.5, 1.5]) for (const z of [-0.9, 0.9]) g.add(kit.cyl(0.07, 0.07, 1.1, 5, C.white, x, 1.6, z));
  // 白色波浪屋頂（自訂低多邊形曲面）
  const T = kit.THREE;
  const nx = 10, nz = 7, w = 4.2, d = 2.8;
  const pos = [], idx = [];
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const px = -w / 2 + (i / nx) * w;
    const pz = -d / 2 + (j / nz) * d;
    const py = 2.75 + 0.22 * Math.sin((i / nx) * Math.PI * 2) + 0.12 * Math.cos((j / nz) * Math.PI * 2)
      + 0.16 * Math.sin((i / nx) * Math.PI) * Math.sin((j / nz) * Math.PI);
    pos.push(px, py, pz);
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, dd = c + 1;
    idx.push(a, c, b, b, c, dd);
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const roof = kit.mesh(geo, C.white, { side: T.DoubleSide });
  roof.position.set(0, 0, 0);
  g.add(roof);
  // 屋頂上的兩個天井
  g.add(kit.box(0.7, 0.05, 0.5, C.waterDark, -0.8, 2.72, 0.2));
  g.add(kit.box(0.6, 0.05, 0.5, C.waterDark, 0.9, 2.65, -0.3));
  // 草坪圓丘
  const gardens = [[-1.6, 1.6, C.green], [1.6, 1.6, C.greenDark], [-1.6, -1.6, C.greenLight], [1.6, -1.6, C.green]];
  for (const [x, z, col] of gardens) {
    const garden = kit.cyl(0.65, 0.7, 0.12, 10, col, x, 0.2, z);
    garden.scale.z = 0.7;
    g.add(garden);
  }
  kit.tree(g, -1.8, 0.0, 0.6, C.green);
  kit.tree(g, 1.8, 0.0, 0.6, C.greenDark);
  g.add(kit.box(0.8, 0.25, 0.06, C.white, 0, 1.7, 1.15));
}

function buildP11(g, kit) {
  g.add(kit.box(4, 0.2, 3.2, C.greenLight));
  // 池塘
  g.add(kit.cyl(1.35, 1.4, 0.2, 12, C.stone, -0.7, 0.2, 0.4));
  g.add(kit.cyl(1.15, 1.15, 0.08, 12, C.water, -0.7, 0.35, 0.4));
  // 涼亭
  g.add(kit.box(1.2, 0.2, 1.2, C.stone, 0.4, 0.2, -0.8));
  for (const x of [-0.3, 1.1]) for (const z of [-1.3, -0.3]) g.add(kit.cyl(0.06, 0.06, 1.2, 6, C.redDark, x, 0.4, z));
  hipRoof(g, kit, 1.5, 1.5, 0.4, 1.6, -0.8, 0.7, C.tileRed, C.gold);
  g.add(kit.cone(0.06, 0.25, 4, C.gold, 0.4, 2.3, -0.8));
  // 步道
  for (let i = 0; i < 3; i++) g.add(kit.box(1.0, 0.05, 0.5, C.concrete, -0.4 + i * 0.8, 0.2, 1.0));
  // 兒童遊具
  g.add(kit.box(0.5, 0.7, 0.5, C.orange, 1.4, 0.2, 0.8));
  const slide = kit.box(0.5, 0.08, 1.0, C.blue, 1.4, 0.55, 1.2);
  kit.turn(slide, "x", -0.3);
  g.add(slide);
  g.add(kit.cyl(0.04, 0.04, 1.0, 4, C.gray, 1.7, 0.2, 0.0));
  g.add(kit.cyl(0.04, 0.04, 1.0, 4, C.gray, 2.1, 0.2, 0.0));
  g.add(kit.box(0.5, 0.05, 0.05, C.gray, 1.9, 1.16, 0.0));
  // 毛孩
  dog(g, kit, -1.4, 1.1, C.woodLight);
  // 長椅
  g.add(kit.box(0.6, 0.1, 0.25, C.wood, -0.2, 0.4, 1.3));
  g.add(kit.box(0.6, 0.1, 0.25, C.wood, 0.8, 0.4, 1.3));
  kit.tree(g, -1.7, -1.0, 1.6, C.green);
  kit.tree(g, 1.5, -1.2, 1.0, C.greenDark);
  kit.tree(g, 0.2, 0.9, 0.8, C.green);
}

function buildP12(g, kit) {
  g.add(kit.box(4, 0.2, 3, C.greenLight));
  // 操場
  g.add(kit.box(3.2, 0.06, 0.8, C.brickLight, 0, 0.2, 1.1));
  g.add(kit.box(2.8, 0.05, 0.5, C.green, 0, 0.27, 1.1));
  // 紅磚教學大樓
  g.add(kit.box(2.8, 2.2, 1.3, C.brick, 0, 0.2, -0.6));
  for (let i = 0; i < 2; i++) g.add(kit.box(2.6, 0.12, 0.05, C.white, 0, 0.75 + i * 0.75, 0.06));
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) g.add(kit.box(0.42, 0.36, 0.04, C.glassDark, -0.7 + c * 0.7, 0.62 + r * 0.75, 0.07));
  // 中央塔樓
  g.add(kit.box(0.8, 2.8, 0.8, C.brickDark, 0, 0.2, -0.2));
  g.add(kit.box(0.95, 0.15, 0.95, C.tileDark, 0, 3.0, -0.2));
  // 校門
  for (const s of [-1, 1]) g.add(kit.box(0.25, 2.4, 0.25, C.brick, s * 1.4, 0.2, 1.3));
  g.add(kit.box(3.2, 0.45, 0.2, C.cream, 0, 2.5, 1.3));
  g.add(kit.box(1.2, 0.25, 0.05, C.greenDark, 0, 2.6, 1.42));
  kit.tree(g, -1.7, 0.2, 0.9, C.green);
  kit.tree(g, 1.7, 0.2, 0.9, C.greenDark);
  kit.flag(g, 0, 3.15, 0.2, C.gold, 0.8);
}

function buildP13(g, kit) {
  g.add(kit.box(4, 0.2, 3.2, C.greenLight));
  // 跑道與操場
  g.add(kit.box(2.2, 0.05, 1.3, C.brickLight, 0.7, 0.2, 0.55));
  g.add(kit.box(1.8, 0.05, 0.9, C.green, 0.7, 0.25, 0.55));
  // L 形三層白色校舍，欄杆用彩色
  g.add(kit.box(3.4, 2.4, 0.9, C.white, 0, 0.2, -1.05));
  g.add(kit.box(0.9, 2.4, 1.5, C.white, -1.25, 0.2, -0.05));
  const rails = [C.orange, C.blue, C.pink];
  for (let f = 0; f < 3; f++) {
    g.add(kit.box(3.4, 0.14, 0.08, rails[f], 0, 0.62 + f * 0.75, -0.58));
    g.add(kit.box(0.08, 0.14, 1.5, rails[f], -0.78, 0.62 + f * 0.75, -0.05));
    for (let c = 0; c < 4; c++) g.add(kit.box(0.45, 0.32, 0.04, C.glass, -1.05 + c * 0.75, 0.32 + f * 0.75, -0.59));
  }
  g.add(kit.box(3.6, 0.14, 1.0, C.tileRed, 0, 2.6, -1.05));
  g.add(kit.box(1.0, 0.14, 1.7, C.tileRed, -1.25, 2.6, -0.05));
  // 校門與校名
  for (const x of [0.2, 1.8]) g.add(kit.box(0.22, 1.5, 0.22, C.brick, x, 0.2, 1.45));
  g.add(kit.box(1.85, 0.32, 0.2, C.cream, 1.0, 1.55, 1.45));
  g.add(kit.box(0.9, 0.18, 0.04, C.greenDark, 1.0, 1.62, 1.56));
  // 校門外的通學斑馬線
  g.add(kit.box(1.6, 0.04, 0.5, C.tileDark, 1.0, 0.2, 1.9));
  for (let i = 0; i < 5; i++) g.add(kit.box(0.14, 0.05, 0.42, C.white, 0.45 + i * 0.28, 0.21, 1.9));
  // 溜滑梯
  g.add(kit.box(0.4, 0.8, 0.4, C.orange, -1.2, 0.2, 1.1));
  g.add(kit.turn(kit.box(0.3, 0.06, 1.0, C.blue, -1.2, 0.55, 1.55), "x", 0.55));
  // 放學的孩子與導護
  figure(g, kit, 0.6, 1.2, C.blue, C.goldLight);
  figure(g, kit, 1.0, 1.15, C.pink, C.goldLight);
  figure(g, kit, 1.4, 1.2, C.orange, C.goldLight);
  figure(g, kit, 1.9, 1.75, C.goldLight, C.orange);
  kit.tree(g, 1.7, -0.4, 1.0, C.greenDark);
  kit.flag(g, -1.6, 0.2, 0.9, C.gold, 2.2);
}

function buildX1(g, kit) {
  g.add(kit.box(4, 0.2, 3, C.greenLight));
  // 紅磚校舍
  g.add(kit.box(3.0, 1.8, 1.2, C.brick, 0, 0.2, -0.6));
  g.add(kit.box(3.0, 0.12, 0.05, C.white, 0, 1.4, 0.0));
  hipRoof(g, kit, 3.2, 1.4, 0, 2.0, -0.6, 0.5, C.tileDark);
  // 紅磚拱廊
  for (let i = 0; i < 3; i++) {
    archWall(g, kit, 0.95, 1.25, 0.16, 0.55, 0.55, C.cream, -0.95 + i * 0.95, 0.2, 0.2);
    g.add(kit.box(0.55, 0.9, 0.05, C.woodDark, -0.95 + i * 0.95, 0.25, 0.05));
  }
  g.add(kit.box(3.0, 0.12, 0.5, C.tileDark, 0, 1.45, 0.2));
  // 中央鐘塔
  g.add(kit.box(0.8, 2.8, 0.8, C.brickDark, 0, 0.2, -0.4));
  hipRoof(g, kit, 0.95, 0.95, 0, 3.0, -0.4, 0.4, C.tileDark);
  disc(g, kit, 0.18, C.white, 0, 2.6, 0.02);
  // 校門
  for (const s of [-1, 1]) g.add(kit.box(0.25, 2.2, 0.25, C.brick, s * 1.3, 0.2, 1.2));
  g.add(kit.box(2.9, 0.4, 0.2, C.cream, 0, 2.3, 1.2));
  g.add(kit.box(1.4, 0.22, 0.05, C.greenDark, 0, 2.4, 1.32));
  kit.tree(g, 1.6, 1.3, 1.4, C.greenDark);
  kit.tree(g, -1.7, 1.3, 0.9, C.green);
  kit.flag(g, 0, 3.4, 0.0, C.gold, 0.7);
}

function buildX2(g, kit) {
  g.add(kit.box(4, 0.2, 3.2, C.greenLight));
  // 橢圓田徑場
  const track = kit.mesh(new kit.THREE.TorusGeometry(1.5, 0.18, 5, 24), C.brickLight);
  track.rotation.x = -Math.PI / 2;
  track.scale.y = 0.62;
  track.position.set(-0.2, 0.3, 0.2);
  g.add(track);
  const field = kit.cyl(1.2, 1.2, 0.08, 20, C.green, -0.2, 0.22, 0.2);
  field.scale.z = 0.62;
  g.add(field);
  // 看台
  for (let i = 0; i < 3; i++) g.add(kit.box(1.8, 0.25, 0.35, C.concrete, -0.2, 0.25 + i * 0.25, -1.0 - i * 0.25));
  g.add(kit.box(2.0, 0.1, 1.0, C.white, -0.2, 1.05, -1.35));
  // 運動中心
  g.add(kit.box(1.4, 1.6, 1.2, C.cream, 1.3, 0.2, -0.5));
  g.add(kit.box(1.2, 0.6, 0.05, C.glass, 1.3, 0.4, 0.12));
  g.add(kit.box(1.5, 0.12, 1.3, C.blue, 1.3, 1.8, -0.5));
  // 照明燈柱
  for (const x of [-1.8, 1.8]) {
    g.add(kit.cyl(0.05, 0.05, 2.8, 4, C.gray, x, 0.2, -1.4));
    g.add(kit.box(0.35, 0.15, 0.15, C.white, x, 3.0, -1.4, { emissive: "#fff3c4", emissiveIntensity: 0.5 }));
  }
  g.add(kit.box(0.25, 0.1, 0.2, C.white, -0.2, 0.38, 1.1));
  kit.tree(g, 1.7, 1.1, 0.8, C.green);
}

function buildX3(g, kit) {
  g.add(kit.box(4, 0.2, 3, C.concrete));
  // 土色站體與金色拱門
  archWall(g, kit, 3.4, 2.3, 1.1, 1.8, 1.0, C.brickLight, 0, 0.2, -0.4);
  archRing(g, kit, 0.9, 0.12, 0, 1.2, 0.18, C.gold);
  g.add(kit.box(1.7, 1.7, 0.1, C.glass, 0, 0.35, 0.0));
  for (let i = 0; i < 3; i++) g.add(kit.box(0.05, 1.7, 0.06, C.gold, -0.55 + i * 0.55, 0.35, 0.22));
  // 站名帶
  g.add(kit.box(1.9, 0.28, 0.08, C.woodDark, 0, 1.8, 0.18));
  g.add(kit.box(1.3, 0.1, 0.04, C.white, 0, 1.9, 0.23));
  // 站體上方大樓
  g.add(kit.box(1.6, 4.0, 1.1, C.cream, 0.7, 0.2, -1.0));
  for (let i = 0; i < 5; i++) g.add(kit.box(1.4, 0.18, 0.05, C.gray, 0.7, 0.65 + i * 0.7, -0.43));
  g.add(kit.box(0.35, 0.15, 0.05, C.red, 0, 1.45, 0.2));
  for (let i = 0; i < 2; i++) g.add(kit.box(2.0 - i * 0.2, 0.1, 0.25, C.concrete, 0, 0.2 + i * 0.1, 1.0 + i * 0.22));
  kit.tree(g, -1.7, 1.0, 0.8, C.green);
  kit.tree(g, 1.7, 1.0, 0.8, C.greenDark);
}

function buildX4(g, kit) {
  g.add(kit.box(4, 0.2, 3, C.concrete));
  // 區公所主樓
  g.add(kit.box(3.2, 2.4, 1.6, C.white, 0, 0.2, -0.6));
  g.add(kit.box(1.2, 1.6, 0.08, C.glassDark, 0, 0.2, 0.22));
  g.add(kit.box(3.0, 0.15, 0.9, C.white, 0, 1.9, 0.3));
  for (const x of [-1.2, -0.4, 0.4, 1.2]) g.add(kit.cyl(0.08, 0.08, 1.6, 8, C.stone, x, 0.2, 0.6));
  // 招牌
  g.add(kit.box(1.6, 0.3, 0.08, C.greenDark, 0, 1.55, 0.24));
  g.add(kit.box(1.0, 0.1, 0.04, C.white, 0, 1.65, 0.29));
  disc(g, kit, 0.16, C.gold, 0, 2.12, 0.76);
  // 無障礙坡道
  const ramp = kit.box(1.1, 0.12, 0.8, C.stone, 1.1, 0.2, 1.2);
  kit.turn(ramp, "z", -0.12);
  g.add(ramp);
  g.add(kit.box(1.1, 0.05, 0.05, C.gray, 1.1, 0.8, 1.55));
  g.add(kit.cyl(0.03, 0.03, 0.6, 4, C.gray, 0.6, 0.3, 1.55));
  g.add(kit.cyl(0.03, 0.03, 0.6, 4, C.gray, 1.6, 0.3, 1.55));
  // 服務台
  g.add(kit.box(0.5, 0.9, 0.4, C.blue, -1.5, 0.2, 1.0));
  g.add(kit.box(0.4, 0.25, 0.04, C.white, -1.5, 0.65, 1.21));
  kit.flag(g, 1.5, 2.6, -0.6, C.gold, 0.8);
  kit.tree(g, -1.7, 0.2, 0.9, C.green);
  kit.tree(g, 1.7, 0.2, 0.9, C.greenDark);
}

function buildQ1(g, kit) {
  // 台階與基座
  g.add(kit.box(4, 0.25, 3.2, C.concrete, 0, 0, 0));
  g.add(kit.box(3.6, 0.2, 2.8, C.white, 0, 0.25, 0.0));
  // 白色議事大樓
  g.add(kit.box(3.6, 2.0, 2.0, C.white, 0, 0.45, -0.7));
  // 兩側拱廊
  for (const s of [-1, 1]) {
    g.add(kit.box(0.9, 1.8, 1.8, C.white, s * 1.9, 0.45, -0.5));
    archRing(g, kit, 0.45, 0.08, s * 1.9, 0.9, 0.42, C.stone);
  }
  // 六柱門廊
  for (let i = 0; i < 6; i++) g.add(kit.cyl(0.13, 0.16, 1.9, 10, C.white, -1.5 + i * 0.6, 0.45, 0.6));
  g.add(kit.box(3.7, 0.35, 1.2, C.white, 0, 2.35, 0.6));
  // 山牆與金色門額
  pediment(g, kit, 3.7, 0.9, 1.0, 0, 2.7, 0.6, C.white);
  g.add(kit.box(1.9, 0.35, 0.06, C.white, 0, 2.4, 1.22));
  g.add(kit.box(1.6, 0.22, 0.04, C.gold, 0, 2.46, 1.26));
  disc(g, kit, 0.16, C.gold, 0, 2.9, 1.12);
  // 側翼窗
  for (const s of [-1, 1]) for (let i = 0; i < 2; i++) g.add(kit.box(0.35, 0.4, 0.04, C.glassDark, s * 1.9, 1.0 + i * 0.5, 0.42));
  // 屋頂旗幟
  kit.flag(g, -0.7, 3.3, -0.4, C.gold, 1.0);
  kit.flag(g, 0.7, 3.3, -0.4, C.blue, 1.0);
  kit.tree(g, -1.8, 1.6, 0.8, C.green);
  kit.tree(g, 1.8, 1.6, 0.8, C.greenDark);
}

// 五甲龍成宮：三川殿、燕尾脊紅瓦、龍柱、廟埕與香爐
function buildLCG(g, kit) {
  g.add(kit.box(4.2, 0.2, 3.6, C.stone));
  g.add(kit.box(3.6, 0.12, 1.4, "#d9cdb8", 0, 0.2, 1.0));  // 廟埕
  // 正殿與兩側護龍
  g.add(kit.box(3.0, 1.5, 1.7, C.brick, 0, 0.2, -0.6));
  gableRoof(g, kit, 3.3, 1.9, 0, 1.7, -0.6, 1.0, C.tileRed, C.gold, null);
  for (const s of [-1, 1]) {
    g.add(kit.box(0.8, 1.0, 1.4, C.brickLight, s * 1.85, 0.2, -0.5));
    simpleGable(g, kit, 0.9, 1.5, s * 1.85, 1.2, -0.5, 0.45, C.tileRed, C.gold);
  }
  // 三川殿前廊與龍柱
  g.add(kit.box(3.2, 0.2, 0.7, C.stone, 0, 0.2, 0.55));
  for (const x of [-1.2, -0.4, 0.4, 1.2]) {
    g.add(kit.cyl(0.11, 0.12, 1.4, 8, C.stoneDark, x, 0.4, 0.75));
    g.add(kit.cyl(0.14, 0.14, 0.12, 8, C.gold, x, 1.05, 0.75));
  }
  simpleGable(g, kit, 3.4, 0.9, 0, 1.8, 0.55, 0.6, C.tileRed, C.gold);
  for (const x of [-1.7, 1.7]) g.add(kit.cone(0.09, 0.4, 4, C.gold, x, 2.4, 0.55));  // 燕尾翹脊
  for (const x of [-0.8, 0, 0.8]) g.add(kit.box(0.5, 0.85, 0.06, C.redDark, x, 0.45, 0.25));  // 廟門
  // 香爐與燈籠
  g.add(kit.cyl(0.25, 0.3, 0.4, 8, C.gold, 0, 0.2, 1.3));
  for (const s of [-1, 1]) {
    const l = kit.mesh(new kit.THREE.SphereGeometry(0.15, 8, 6), C.red, { emissive: "#ff3a2a", emissiveIntensity: 0.5 });
    l.position.set(s * 0.9, 1.7, 0.95);
    g.add(l);
  }
  kit.tree(g, -1.8, 1.3, 1.2, C.greenDark);
  kit.tree(g, 1.8, 1.3, 1.1, C.green);
}

const BUILDERS = {
  P01: buildP01, P02: buildX3, P03: buildP03, P04: buildP04, P05: buildP05,
  P06: buildP06, P07: buildP07, P08: buildP08, P09: buildP09, P10: buildP10,
  P11: buildP11, P12: buildP12, P13: buildP13,
  X1: buildX1, X2: buildX2, X3: buildP02, X4: buildX4, Q1: buildQ1, LCG: buildLCG,
};

export function buildLandmark(id, kit) {
  const fn = BUILDERS[id];
  if (!fn || !kit || !kit.THREE) return null;
  const g = new kit.THREE.Group();
  fn(g, kit);
  return g;
}
