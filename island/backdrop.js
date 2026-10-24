// 外圍風景：海上的小島（風車、燈塔、涼亭、樹），以及畫面遠方的海岸、丘陵、城市天際線、雲與天空。
// 正交鏡頭沒有真正的地平線，所以遠景整組跟著鏡頭方位轉，永遠在「群島後方」那一側，不會擋到島。
// addBackdrop(ctx) 回傳 { update(dt), follow(camera, target), setSky(top, bottom, night), islets }。

export function addBackdrop({ THREE, scene, box, cyl, cone, tree, rng, avoid = [], R = 10, mobile = false }) {
  const rand = rng(20261025);
  const spinning = [];
  const group = new THREE.Group();
  scene.add(group);

  // ── 小島：放在群島與遠方海岸之間，避開每一格島與淺水 ───────────────
  const islets = [];
  function islet(x, z, r, kind) {
    const g = new THREE.Group();
    g.add(cyl(r, r * 1.15, 1.6, 10, "#f0d9a6", 0, -1.9, 0));
    g.add(cyl(r * 0.92, r, 0.4, 10, "#8fcf6e", 0, -0.3, 0));
    const trees = kind === "trees" ? 5 : 2;
    for (let i = 0; i < trees; i++) {
      const a = rand() * Math.PI * 2, d = r * (0.3 + rand() * 0.45);
      tree(g, Math.cos(a) * d, Math.sin(a) * d, 0.8 + rand() * 0.5, i % 2 ? "#4f9e4c" : "#6dbb57");
    }
    if (kind === "windmill") {
      g.add(cyl(0.18, 0.28, 7, 6, "#f4f2ec", 0, 0, 0));
      const hub = new THREE.Group();
      hub.position.set(0, 7, 0.3);
      for (let k = 0; k < 3; k++) {
        const blade = box(0.35, 3.4, 0.08, "#ffffff", 0, 0, 0);  // 葉片根部在軸心
        const arm = new THREE.Group();
        arm.add(blade);
        arm.rotation.z = (k * Math.PI * 2) / 3;
        hub.add(arm);
      }
      g.add(hub);
      spinning.push({ obj: hub, speed: 1.2 + rand() * 0.6 });
    } else if (kind === "lighthouse") {
      for (let k = 0; k < 4; k++) g.add(cyl(0.9 - k * 0.12, 1.0 - k * 0.12, 1.5, 10, k % 2 ? "#e8574a" : "#ffffff", 0, k * 1.5, 0));
      g.add(cyl(0.55, 0.55, 0.8, 8, "#ffe9a8", 0, 6, 0, { emissive: "#ffcf5a", emissiveIntensity: 0.6 }));
      g.add(cone(0.75, 0.8, 8, "#e8574a", 0, 6.8, 0));
    } else if (kind === "pavilion") {
      for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.add(cyl(0.1, 0.1, 1.8, 5, "#8a6a4a", px, 0, pz));
      g.add(cone(2, 1.2, 6, "#e8734f", 0, 1.8, 0));
    }
    g.position.set(x, 0, z);
    g.rotation.y = rand() * Math.PI * 2;
    group.add(g);
    islets.push({ x, z, r });
  }
  const kinds = ["windmill", "trees", "lighthouse", "trees", "windmill", "pavilion", "trees", "windmill", "trees", "pavilion", "trees"];
  const clear = (x, z, r) => avoid.every((c) => Math.hypot(x - c.x, z - c.z) >= R * 1.2 + r + 4) && islets.every((o) => Math.hypot(x - o.x, z - o.z) >= o.r + r + 6);
  kinds.forEach((kind, i) => {
    const r = 3.5 + rand() * 2;
    const a0 = (i / kinds.length) * Math.PI * 2 + rand() * 0.3;
    // 半徑 ≤ 88：轉到任何方位都不會跑進遠方海岸（海岸從 94 起）
    for (const da of [0, 0.12, -0.12, 0.24, -0.24]) for (let d = 76; d <= 88 - r * 0.2; d += 2) {
      const x = Math.cos(a0 + da) * d, z = Math.sin(a0 + da) * d;
      if (clear(x, z, r)) { islet(x, z, r, kind); return; }
    }
  });

  // ── 遠景：海岸、丘陵、天際線、雲、天空（整組跟著鏡頭方位轉）────────────
  // 本地座標：+z 朝鏡頭、-z 是遠方；x 是畫面左右
  const horizon = new THREE.Group();
  scene.add(horizon);
  const F0 = 94;                      // 海岸線離中心的距離
  const W = 460;                      // 左右半寬
  const coast = (x) => F0 + 10 * (0.5 + 0.25 * Math.sin(x * 0.031 + 1.3) + 0.15 * Math.sin(x * 0.077 + 0.4) + 0.1 * Math.sin(x * 0.19));
  const lit = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });

  // 海岸地面：靠海是沙灘，往內陸變草地並緩緩升高
  {
    const ROWS = [[-2.5, -2.2, "#e9d3a2"], [2.5, -0.95, "#f3e0b5"], [6, -0.7, "#f6e6c0"], [9, -0.45, "#b9d98c"], [16, 0.4, "#9fd07a"], [30, 1.8, "#8cc56c"], [52, 3.2, "#86bf6e"], [95, 5.5, "#86b97a"]];
    const cols = Math.round((W * 2) / 6) + 1;
    const pos = [], col = [], idx = [], c = new THREE.Color();
    for (let i = 0; i < cols; i++) {
      const x = -W + i * 6, z0 = coast(x);
      ROWS.forEach(([off, y, hex], k) => {
        const wob = k > 2 ? Math.sin(x * 0.11 + k) * 0.35 : 0;
        pos.push(x, y + wob, -(z0 + off));
        c.set(hex); col.push(c.r, c.g, c.b);
      });
    }
    const n = ROWS.length;
    for (let i = 0; i < cols - 1; i++) for (let k = 0; k < n - 1; k++) {
      const a = i * n + k, b = (i + 1) * n + k;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    horizon.add(new THREE.Mesh(geo, lit));
  }

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), tint = new THREE.Color();
  const white = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1, flatShading: true });
  function instanced(geo, material, list, shadow = false) {
    const im = new THREE.InstancedMesh(geo, material, list.length);
    list.forEach((it, i) => {
      q.setFromAxisAngle(up, it.rot || 0);
      m4.compose(p.set(it.x, it.y || 0, it.z), q, s.set(it.sx, it.sy, it.sz ?? it.sx));
      im.setMatrixAt(i, m4);
      if (it.color) im.setColorAt(i, tint.set(it.color));
    });
    im.castShadow = shadow;
    horizon.add(im);
    return im;
  }

  // 城市天際線：一群淡色的樓，集中在遠方偏右（像鳳山往高雄市區看過去）
  const CITY = [-70, 120];
  const towers = [];
  const towerColors = ["#f4f1ea", "#e8eef3", "#f3e6d6", "#dce8f0", "#f6efe2", "#e3ece6"];
  for (let i = 0; i < (mobile ? 26 : 44); i++) {
    const x = CITY[0] + rand() * (CITY[1] - CITY[0]);
    const z = coast(x) + 30 + rand() * 24;  // 退到丘陵後面：預設視角只露出一點，拉遠才看得到整排
    const mid = 1 - Math.abs((x - 25) / 95);  // 中間高、兩側低
    const h = 4 + rand() * 7 + mid * mid * (6 + rand() * 12);
    towers.push({ x, z: -z, y: -0.4, sx: 2.6 + rand() * 2.8, sy: h, sz: 2.6 + rand() * 2.8, rot: rand() * 0.3, color: towerColors[i % towerColors.length] });
  }
  towers.push({ x: 30, z: -(coast(30) + 40), y: -0.4, sx: 3.6, sy: 32, sz: 3.6, color: "#eef3f6" });  // 地標高樓
  // 夜裡窗戶亮起：細格窗戶貼圖當自發光
  const winCv = document.createElement("canvas");
  winCv.width = 32; winCv.height = 64;
  {
    const g2 = winCv.getContext("2d"), r2 = rng(77);
    g2.fillStyle = "#000"; g2.fillRect(0, 0, 32, 64);
    for (let y = 2; y < 64; y += 5) for (let x = 2; x < 32; x += 5) if (r2() < 0.45) { g2.fillStyle = r2() < 0.7 ? "#ffd27a" : "#fff1c4"; g2.fillRect(x, y, 3, 3); }
  }
  const winTex = new THREE.CanvasTexture(winCv);
  winTex.colorSpace = THREE.SRGBColorSpace;
  const cityMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, flatShading: true, emissive: "#ffffff", emissiveMap: winTex, emissiveIntensity: 0 });
  instanced(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), cityMat, towers);

  // 丘陵：低多邊形圓丘，近的矮、遠的高；天際線那一段留空
  const hills = [];
  const hillColors = ["#8cc86e", "#7fbf66", "#9ad07a", "#76b866", "#a3d283"];
  for (let i = 0; i < (mobile ? 30 : 48); i++) {
    const x = -W + rand() * W * 2;
    const far = rand();
    if (x > CITY[0] - 6 && x < CITY[1] + 6 && far < 0.55) continue;
    const z = coast(x) + 16 + far * 44;
    const r = 12 + rand() * 12 + far * 10;
    hills.push({ x, z: -z, y: -1.2, sx: r, sy: 6 + far * 22 + rand() * 6, sz: r * (0.7 + rand() * 0.4), rot: rand() * Math.PI, color: hillColors[i % hillColors.length] });
  }
  instanced(new THREE.SphereGeometry(1, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2), white, hills);

  // 海岸的樹：沙灘後面一排，圓樹與尖樹混著
  const roundT = [], pineT = [];
  const leaf = ["#5fae4f", "#6dbb57", "#4f9e4c", "#7cc35a"];
  // 三到五棵一叢、離沙灘再退一些，預設畫面頂端不會只露出一顆孤零零的樹冠
  for (let i = 0, n = 0; n < (mobile ? 70 : 130); i++) {
    const cx = -W + rand() * W * 2;
    if (cx > CITY[0] && cx < CITY[1] && rand() < 0.6) continue;
    const cz = coast(cx) + 20 + rand() * 12, m = 3 + Math.floor(rand() * 3);
    for (let j = 0; j < m; j++, n++) {
      const x = cx + (rand() - 0.5) * 7, z = Math.max(coast(x) + 18, cz + (rand() - 0.5) * 5);
      const k = 0.9 + rand() * 0.9;
      (rand() < 0.5 ? roundT : pineT).push({ x, z: -z, y: -0.2 + (z - coast(x) - 10) * 0.07, sx: k, sy: k, color: leaf[n % 4] });
    }
  }
  instanced(new THREE.IcosahedronGeometry(1.1, 0).translate(0, 1.0, 0), white, roundT);  // 樹冠貼地，遠看不會像浮在空中的球
  instanced(new THREE.ConeGeometry(0.9, 2.6, 6).translate(0, 1.3, 0), white, pineT);

  // 雲：幾朵白雲在遠方慢慢飄（低於群島後緣的高度不放，避免遮到島）
  const puffs = [], clouds = [];
  for (let i = 0; i < (mobile ? 5 : 8); i++) {
    const cx = -260 + rand() * 520, cz = -(82 + rand() * 50), cy = 15 + rand() * 18, k = 1.6 + rand() * 1.4;
    const cl = { x: cx, speed: 1 + rand() * 1.4, puffs: [] };
    for (let j = 0; j < 5; j++) {
      const it = { x: cx, dx: (j - 2) * 2.3 * k + (rand() - 0.5) * k, y: cy + (j % 2) * 0.8 * k + rand() * 0.6, z: cz + (rand() - 0.5) * 2 * k, sx: (1.5 + rand() * 1.1) * k, sy: (1 + rand() * 0.5) * k, sz: (1.3 + rand() * 0.6) * k };
      it.sx *= j === 0 || j === 4 ? 0.7 : 1;
      it.i = puffs.length;
      puffs.push(it);
      cl.puffs.push(it);
    }
    clouds.push(cl);
  }
  puffs.forEach((it) => (it.x = it.x + it.dx));
  const cloudMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1, flatShading: true, emissive: "#ffffff", emissiveIntensity: 0.35, transparent: true, opacity: 0.92 });
  const cloudMesh = instanced(new THREE.IcosahedronGeometry(1, 1), cloudMat, puffs);

  // 天空：遠方一面跟著鏡頭的漸層牆（下緣與霧同色，接得起來）
  const skyU = { uTop: { value: new THREE.Color("#a9d8ef") }, uBottom: { value: new THREE.Color("#f3eee2") } };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyU, fog: false, depthWrite: false,
    vertexShader: "varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "uniform vec3 uTop; uniform vec3 uBottom; varying float vY; void main(){ gl_FragColor = vec4(mix(uBottom, uTop, smoothstep(2.0, 70.0, vY)), 1.0);\n#include <colorspace_fragment>\n}",
  });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(W * 3, 260).translate(0, 128, 0), skyMat);
  sky.position.z = -(F0 + 78);
  sky.renderOrder = -1;
  horizon.add(sky);
  horizon.traverse((o) => { if (o.isMesh) { o.receiveShadow = false; o.userData = { horizon: true }; } });

  function follow(camera, target) {
    horizon.rotation.y = Math.atan2(camera.position.x - target.x, camera.position.z - target.z);
  }
  function setSky(top, bottom, night) {
    skyU.uTop.value.copy(top);
    skyU.uBottom.value.copy(bottom);
    cityMat.emissiveIntensity = night * 0.9;
    cloudMat.emissiveIntensity = 0.35 * (1 - night);
    cloudMat.opacity = 0.92 - night * 0.3;
  }
  function update(dt) {
    for (const sp of spinning) sp.obj.rotation.z += dt * sp.speed;
    // 雲往右飄，飄出去從左邊再進來
    if (!dt) return;
    q.identity();
    for (const cl of clouds) {
      cl.x += cl.speed * dt;
      if (cl.x > W * 0.7) cl.x -= W * 1.4;
      for (const it of cl.puffs) cloudMesh.setMatrixAt(it.i, m4.compose(p.set(cl.x + it.dx, it.y, it.z), q, s.set(it.sx, it.sy, it.sz)));
    }
    cloudMesh.instanceMatrix.needsUpdate = true;
  }
  return { update, follow, setSky, islets };
}
