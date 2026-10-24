// 島上綠意：行道樹、灌木、花圃、遮陽傘與長椅。每一種只用一個 InstancedMesh（一次繪製）。
// 擺放前先從正上方畫一張「高度圖」（只畫地標、周邊實景、哨子等），只把東西放在平地上；
// 另外避開每格中央地標與正面、步道環（人走的地方）、政績名牌錨點、安心哨。手機上候選點少四成、上限也較低。
// addIslandDress(ctx) 回傳 { group, count, stats }。

export function addIslandDress({ THREE, scene, renderer, world, cells, blockers, avoid, R, TOP, rng, mobile }) {
  const rand = rng(20261101);
  const group = new THREE.Group();
  group.name = "island-dress";

  // ── 1. 俯視高度圖：哪裡已經有東西 ──────────────────────────────────
  const S = mobile ? 256 : 512, EXT = 100, LAYER = 7;
  for (const o of blockers) o?.traverse((m) => { if (m.isMesh) m.layers.enable(LAYER); });
  const cam = new THREE.OrthographicCamera(-EXT, EXT, EXT, -EXT, 1, 300);
  cam.position.set(0, 150, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0); cam.layers.set(LAYER);
  const hm = new THREE.ShaderMaterial({
    vertexShader: `varying float vY; void main(){ vec4 w = vec4(position, 1.0);
      #ifdef USE_INSTANCING
        w = instanceMatrix * w;
      #endif
      w = modelMatrix * w; vY = w.y; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `varying float vY; void main(){ gl_FragColor = vec4(clamp((vY - ${TOP.toFixed(3)}) / 8.0, 0.0, 1.0), 0.0, 0.0, 1.0); }`,
    side: THREE.DoubleSide,
  });
  const rt = new THREE.WebGLRenderTarget(S, S);
  const keep = { bg: scene.background, fog: scene.fog, ov: scene.overrideMaterial, rt: renderer.getRenderTarget(), auto: renderer.shadowMap.autoUpdate, need: renderer.shadowMap.needsUpdate, cc: renderer.getClearColor(new THREE.Color()), ca: renderer.getClearAlpha() };
  scene.background = null; scene.fog = null; scene.overrideMaterial = hm; renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear();
  renderer.render(scene, cam);
  const px = new Uint8Array(S * S * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, S, S, px);
  renderer.setRenderTarget(keep.rt); renderer.setClearColor(keep.cc, keep.ca);
  scene.background = keep.bg; scene.fog = keep.fog; scene.overrideMaterial = keep.ov; renderer.shadowMap.autoUpdate = keep.auto; renderer.shadowMap.needsUpdate = keep.need;
  rt.dispose(); hm.dispose();
  for (const o of blockers) o?.traverse((m) => { if (m.isMesh) m.layers.disable(LAYER); });
  // 像素 → 世界：畫面右＝+x、上＝-z；readPixels 第 0 列在最下面（+z）
  const toPx = (x, z) => [Math.floor(((x + EXT) / (2 * EXT)) * S), Math.floor(((EXT - z) / (2 * EXT)) * S)];
  // 腳下要平：範圍內最高點不超過 0.5（周邊實景的地面薄板、草皮、步道都算平地），就放在那個高度上
  const UNIT = 8 / 255;
  const ground = (x, z, rad) => {
    const [cx, cy] = toPx(x, z), rp = Math.ceil((rad / (2 * EXT)) * S);
    let hi = 0;
    for (let dy = -rp; dy <= rp; dy++) for (let dx = -rp; dx <= rp; dx++) {
      const ix = cx + dx, iy = cy + dy;
      if (ix < 0 || iy < 0 || ix >= S || iy >= S) continue;
      const v = px[(iy * S + ix) * 4];
      if (v > hi) hi = v;
    }
    return hi * UNIT <= 0.5 ? Math.max(0, hi - 1) * UNIT : null;
  };

  // ── 2. 每格挑空地 ──────────────────────────────────────────────────
  const SQ3 = Math.sqrt(3);
  const inHex = (x, z, rad) => Math.abs(x) <= (rad * SQ3) / 2 && Math.abs(z) + Math.abs(x) / SQ3 <= rad;
  const lists = { lawn: [], trunk: [], round: [], pine: [], bush: [], bed: [], bloom: [], bench: [], pole: [], umbrella: [] };
  const placed = [];
  const stats = { cand: 0, avoid: 0, ground: 0 };  // 候選點、被避讓、地面不平（除錯用）
  const free = (x, z, rad) => avoid.every((a) => Math.hypot(x - a.x, z - a.z) > a.r + rad) && placed.every((p) => Math.hypot(x - p.x, z - p.z) > p.r + rad + 0.05);
  const greens = ["#5fae4f", "#6dbb57", "#4f9e4c", "#7cc35a", "#8acb62"];
  const lawns = ["#8fcf6a", "#9ad673", "#86c862", "#a3da7c"];
  // 樹與灌木底下鋪一塊草皮（扁平圓片，一次繪製），讓島內出現綠色斑塊
  const lawnUnder = (x, z) => {
    const r = 1.0 + rand() * 0.6, gy = ground(x, z, r);
    if (gy == null) return;
    lists.lawn.push({ x, y: TOP + gy + 0.004 + rand() * 0.012, z, s: r, rot: rand() * Math.PI, color: lawns[Math.floor(rand() * lawns.length)] });
  };
  const pines = ["#3f8f4a", "#4f9e4c", "#5aa857"];
  const blooms = ["#ff6f91", "#ffd23f", "#ffffff", "#c77dff", "#ff9f43", "#ef476f"];
  const shades = ["#ff7b5c", "#ffd166", "#4fc3d9", "#ef476f", "#06d6a0", "#f78fb3"];
  const scale = mobile ? 0.55 : 1;
  for (const cell of cells) {
    const cap = { tree: Math.round(13 * scale), bush: Math.round(12 * scale), bed: Math.max(1, Math.round(3 * scale)), bench: mobile ? 1 : 2, umbrella: mobile ? 1 : 2 };
    const cand = [];
    // 抖動格點，只在內圈（步道環與隆隆陪走的偏移都碰不到的範圍）
    for (let zi = -6; zi <= 6; zi++) for (let xi = -6; xi <= 6; xi++) {
      const x = xi * 1.15 + (zi % 2 ? 0.57 : 0) + (rand() - 0.5) * 0.5, z = zi * 1.0 + (rand() - 0.5) * 0.5;
      if (!inHex(x, z, 6.0)) continue;
      const r = Math.hypot(x, z);
      // 地標中央留空，地標正面（朝預設鏡頭那一側）也留空，不擋住地標
      if (cell.hero && (r < 3.2 || (r < 5.4 && (x * 0.5 + z * 0.866) / r > 0.35))) continue;
      if (r < 1.2) continue;
      cand.push({ x: cell.c.x + x, z: cell.c.z + z, edge: r > 4.2, k: rand() });
    }
    cand.sort((a, b) => a.k - b.k);
    const n = { tree: 0, bush: 0, bed: 0, bench: 0, umbrella: 0 };
    for (const c of cand) {
      if (mobile && rand() < 0.4) continue;  // 手機少放一些
      // 靠外圈多種樹與灌木（像行道樹），內側放花圃、長椅、遮陽傘
      const order = c.edge ? ["tree", "bush", "bed", "tree", "bench"] : ["bed", "umbrella", "bench", "bush", "tree"];
      const kind = order.find((k) => n[k] < cap[k] && rand() < 0.75);
      if (!kind) continue;
      const rad = { tree: 0.55, bush: 0.4, bed: 0.85, bench: 0.7, umbrella: 0.95 }[kind];
      const ok = free(c.x, c.z, rad), gy = ok ? ground(c.x, c.z, rad) : null;
      stats.cand++; if (!ok) stats.avoid++; else if (gy == null) stats.ground++;
      if (gy == null) continue;
      placed.push({ x: c.x, z: c.z, r: rad });
      n[kind]++;
      const rot = rand() * Math.PI * 2, y = TOP + gy;
      if ((kind === "tree" || kind === "bush") && rand() < 0.7) lawnUnder(c.x, c.z);
      if (kind === "tree") {
        const k = 0.8 + rand() * 0.45;
        const round = rand() < 0.62;
        lists.trunk.push({ x: c.x, y, z: c.z, s: k, rot });
        (round ? lists.round : lists.pine).push({ x: c.x, y, z: c.z, s: k, rot, color: round ? greens[Math.floor(rand() * greens.length)] : pines[Math.floor(rand() * pines.length)] });
      } else if (kind === "bush") {
        const k = 0.7 + rand() * 0.6;
        lists.bush.push({ x: c.x, y, z: c.z, s: k, rot, color: rand() < 0.25 ? ["#f19bb3", "#f5d061", "#f4a76b"][Math.floor(rand() * 3)] : greens[Math.floor(rand() * greens.length)] });
      } else if (kind === "bed") {
        lists.bed.push({ x: c.x, y, z: c.z, s: 1, rot });
        for (let f = 0; f < 7; f++) {
          const a = (f / 7) * Math.PI * 2 + rand() * 0.4, d = f === 6 ? 0 : 0.42 + rand() * 0.12;
          lists.bloom.push({ x: c.x + Math.cos(a) * d, y: y + 0.26, z: c.z + Math.sin(a) * d, s: 0.9 + rand() * 0.5, rot: 0, color: blooms[Math.floor(rand() * blooms.length)] });
        }
      } else if (kind === "bench") {
        lists.bench.push({ x: c.x, y, z: c.z, s: 1, rot: Math.round(rot / (Math.PI / 3)) * (Math.PI / 3) });
      } else {
        lists.pole.push({ x: c.x, y, z: c.z, s: 1, rot: 0 });
        lists.umbrella.push({ x: c.x, y, z: c.z, s: 1, rot, color: shades[Math.floor(rand() * shades.length)] });
      }
    }
  }

  // ── 3. 造型（低多邊形），每種一個 InstancedMesh ───────────────────────
  const tinted = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.85, flatShading: true });
  const solid = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, flatShading: true });
  function merge(parts) {  // 小工具：把幾個非索引幾何合成一個（不另外載入 BufferGeometryUtils）
    const geos = parts.map((g) => (g.index ? g.toNonIndexed() : g));
    const pos = [], nor = [];
    for (const g of geos) { pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array); }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    return out;
  }
  const GEO = {
    lawn: new THREE.CylinderGeometry(1, 1, 0.05, 10).translate(0, 0.025, 0),
    trunk: new THREE.CylinderGeometry(0.09, 0.13, 0.75, 5).translate(0, 0.37, 0),
    round: new THREE.IcosahedronGeometry(0.66, 0).translate(0, 1.2, 0),
    pine: new THREE.ConeGeometry(0.6, 1.5, 6).translate(0, 1.3, 0),
    bush: new THREE.IcosahedronGeometry(0.42, 0).scale(1, 0.72, 1).translate(0, 0.27, 0),
    bed: new THREE.CylinderGeometry(0.78, 0.84, 0.24, 8).translate(0, 0.12, 0),
    bloom: new THREE.IcosahedronGeometry(0.15, 0),
    bench: merge([
      new THREE.BoxGeometry(1.1, 0.08, 0.36).translate(0, 0.36, 0),
      new THREE.BoxGeometry(1.1, 0.3, 0.06).translate(0, 0.56, -0.16),
      new THREE.BoxGeometry(0.08, 0.36, 0.32).translate(-0.46, 0.18, 0),
      new THREE.BoxGeometry(0.08, 0.36, 0.32).translate(0.46, 0.18, 0),
    ]),
    pole: new THREE.CylinderGeometry(0.04, 0.05, 1.7, 5).translate(0, 0.85, 0),
    umbrella: new THREE.ConeGeometry(1.0, 0.45, 8).translate(0, 1.82, 0),
  };
  const MAT = { lawn: tinted, trunk: solid("#8a6a4a"), round: tinted, pine: tinted, bush: tinted, bed: solid("#d27a52"), bloom: tinted, bench: solid("#b9825a"), pole: solid("#f4f1ea"), umbrella: tinted };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), tint = new THREE.Color();
  let count = 0;
  for (const [kind, list] of Object.entries(lists)) {
    if (!list.length) continue;
    const im = new THREE.InstancedMesh(GEO[kind], MAT[kind], list.length);
    list.forEach((it, i) => {
      im.setMatrixAt(i, m4.compose(p.set(it.x, it.y, it.z), q.setFromAxisAngle(up, it.rot), s.setScalar(it.s)));
      if (it.color) im.setColorAt(i, tint.set(it.color));
    });
    im.castShadow = !["bloom", "bed", "lawn"].includes(kind);
    im.receiveShadow = true;
    im.userData = { dress: kind };
    group.add(im);
    count += list.length;
  }
  world.add(group);
  return { group, count, stats };
}
