// 場景細節：岸邊岩石與花草、海面、船、路燈、日夜切換（島間的橋在 app.js；天空與遠景在 backdrop.js）。
// 由 app.js 在建島後呼叫 addSceneExtras(ctx)，回傳 { update(dt, t), setNight(on), setWet(amount) }。

export function addSceneExtras(ctx) {
  const { THREE, scene, world, islands, LAYOUT, hexToWorld, mid, R, mat, box, cyl, cone, tree, sun, hemi, amb, fill, renderer, shallowMat, backdrop, rng, boatModels = {} } = ctx;
  const rand = rng(20261024);
  const moving = [];

  // 所有六角格與所屬島
  const cells = [];
  for (const isl of islands) for (const [q, r] of LAYOUT[isl.id]) cells.push({ q, r, id: isl.id, p: hexToWorld(q, r).sub(mid) });
  const key = (q, r) => `${q},${r}`;
  const byKey = new Map(cells.map((c) => [key(c.q, c.r), c]));
  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e3 = new THREE.Euler(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3();

  // ── 外圍岸邊：沒有鄰格的那一側放岩石（一次繪製）、小碼頭 ──────────────
  const rockMats = [];
  const flowerColors = ["#f2a1b5", "#f6d26b", "#ffffff", "#c9a7e8", "#f08a5d"];
  const flowerGeo = new THREE.SphereGeometry(0.16, 6, 4);
  const flowers = flowerColors.map((col) => new THREE.InstancedMesh(flowerGeo, mat(col), 400));
  const fCount = flowerColors.map(() => 0);
  for (const c of cells) {
    DIRS.forEach(([dq, dr], k) => {
      if (byKey.get(key(c.q + dq, c.r + dr))) return;
      const dir = hexToWorld(dq, dr).normalize();
      const edge = c.p.clone().add(dir.clone().multiplyScalar(R * 1.02));
      for (let i = 0; i < 3; i++) {
        const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar((rand() - 0.5) * R * 0.8);
        v3.copy(edge).add(side).add(dir.clone().multiplyScalar(rand() * 0.8));
        v3.y = -1.1 + rand() * 0.3;
        q4.setFromEuler(e3.set(rand() * 3, rand() * 3, rand() * 3));
        rockMats.push(new THREE.Matrix4().compose(v3, q4, s3.setScalar(0.6 + rand() * 0.9)));
      }
      if (k % 3 === 0 && rand() < 0.5) {  // 小碼頭
        const dock = new THREE.Group();
        dock.add(box(1.2, 0.12, 3, "#b08a62", 0, 0, 0));
        for (const z of [-1.2, 1.2]) dock.add(cyl(0.08, 0.08, 1, 5, "#7a5a3c", 0.5, -0.8, z));
        dock.position.copy(edge).add(dir.clone().multiplyScalar(1.6));
        dock.position.y = -0.7;
        dock.rotation.y = -Math.atan2(dir.z, dir.x) + Math.PI / 2;
        world.add(dock);
      }
    });
    // 草地上的小花
    for (let i = 0; i < 26; i++) {
      const a = rand() * Math.PI * 2, d = R * (0.15 + rand() * 0.5);
      const ci = Math.floor(rand() * flowers.length);
      if (fCount[ci] >= 400) continue;
      m4.makeTranslation(c.p.x + Math.cos(a) * d, 0.55, c.p.z + Math.sin(a) * d);
      flowers[ci].setMatrixAt(fCount[ci]++, m4);
    }
  }
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.6, 0), mat("#c9bda8"), rockMats.length);
  rockMats.forEach((m, i) => rocks.setMatrixAt(i, m));
  rocks.castShadow = rocks.receiveShadow = true;
  world.add(rocks);
  flowers.forEach((f, i) => { f.count = fCount[i]; world.add(f); });

  // ── 海面：島邊淺水亮綠松石、遠處較深；緩慢起伏、細碎反光 ─────────────
  // 淺水深淺圖：每個像素離最近的島（六角形）或小島有多遠，越近越亮
  const SH = 240, N = 128, shallow = new Uint8Array(N * N);
  const hexDist = (x, z) => { const ax = Math.abs(x), az = Math.abs(z); return Math.max(ax, ax * 0.5 + az * 0.866) - R * 0.866; };
  const islets = backdrop?.islets || [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = ((i + 0.5) / N - 0.5) * SH, z = ((j + 0.5) / N - 0.5) * SH;
    let d = 1e9;
    for (const c of cells) d = Math.min(d, hexDist(x - c.p.x, z - c.p.z));
    for (const o of islets) d = Math.min(d, Math.hypot(x - o.x, z - o.z) - o.r * 1.1 + 1.5);
    shallow[j * N + i] = Math.round(255 * Math.exp(-Math.max(0, d) / 7));
  }
  const shallowTex = new THREE.DataTexture(shallow, N, N, THREE.RedFormat);
  shallowTex.magFilter = shallowTex.minFilter = THREE.LinearFilter;
  shallowTex.needsUpdate = true;

  const waveGeo = new THREE.PlaneGeometry(800, 800, 56, 56);
  waveGeo.rotateX(-Math.PI / 2);
  const waveMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.55, metalness: 0, flatShading: true });
  const waves = new THREE.Mesh(waveGeo, waveMat);
  waves.position.y = -1.2;  // 浪谷仍高於底層平面海，避免透出色塊
  waves.receiveShadow = true;
  scene.add(waves);

  // ── 船：沿群島外圍繞行 ───────────────────────────────────────────
  function boat(color) {
    const g = new THREE.Group();
    g.add(box(2.6, 0.5, 1.1, color, 0, 0, 0));
    g.add(box(1.2, 0.6, 0.8, "#fffaf0", -0.2, 0.5, 0));
    g.add(cyl(0.05, 0.05, 1.6, 4, "#6b5a48", 0.6, 0.5, 0));
    g.add(cone(0.5, 1.2, 3, "#ffffff", 0.95, 0.9, 0));
    return g;
  }
  // 船都繞在小島圈內（≤88），轉鏡頭時不會開上遠方海岸
  [["#e4994a", 70, 0.035], ["#4f9fc4", 78, -0.028], ["#e48f9e", 86, 0.022]].forEach(([col, rad, speed], i) => {
    const ids = Object.keys(boatModels);
    const b = ids.length ? boatModels[ids[i % ids.length]].clone(true) : boat(col);
    world.add(b);
    moving.push({ obj: b, kind: "boat", rad, speed, a: i * 2.1 });
  });

  // ── 路燈：每格一盞（桿、燈泡各一次繪製），夜裡燈泡發亮並帶一圈暖光暈 ─────
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffefba, emissive: 0xffcf78, emissiveIntensity: 0 });
  const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.06, 2.2, 6), mat("#6c8586"), cells.length);
  const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.18, 8, 6), lampMat, cells.length);
  const haloMat = new THREE.MeshBasicMaterial({ color: "#ffb45a", transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
  const halos = new THREE.InstancedMesh(new THREE.SphereGeometry(0.62, 12, 8), haloMat, cells.length);
  cells.forEach((c, i) => {
    poles.setMatrixAt(i, m4.makeTranslation(c.p.x + R * 0.8, 1.6, c.p.z));
    bulbs.setMatrixAt(i, m4.makeTranslation(c.p.x + R * 0.8, 2.75, c.p.z));
    halos.setMatrixAt(i, m4.makeTranslation(c.p.x + R * 0.8, 2.75, c.p.z));
  });
  poles.castShadow = true;
  halos.visible = false;
  world.add(poles, bulbs, halos);

  // ── 日夜：白天明亮暖陽；夜晚是亮藍色的夜（不是黑夜），路燈與窗戶暖光 ──────
  // 夜海底色偏灰藍：月光與環境光本身偏藍，乘上去才會接近參考的 0x5a88b2，不會變泳池藍
  // 參考 HEART：環境光補底、暖色主光、冷色補光、ACES 色調；夜裡半球光加強、月光偏藍、海面中藍
  const DAY = {
    sun: 2.7, sunCol: "#fff1de", hemi: 1.0, sky: "#eef6fa", ground: "#8f8270", amb: 0.7, ambCol: "#ffffff", fill: 0.35, fillCol: "#bfd6ff",
    exposure: 1.0, deep: "#1f9cb6", shore: "#55c7c3", glint: 0.9, fog: "#f3eee2", skyTop: "#a6d6ee", shallow: "#b2efe4", shallowOp: 0.55,
  };
  const NIGHT = {
    sun: 1.3, sunCol: "#b4c2ff", hemi: 1.85, sky: "#b3c8f2", ground: "#4a5878", amb: 1.1, ambCol: "#a7bcef", fill: 0.25, fillCol: "#bfd6ff",
    exposure: 1.06, deep: "#6b8a9e", shore: "#83a3b6", glint: 0.28, fog: "#41699f", skyTop: "#223f72", shallow: "#8fc0ec", shallowOp: 0.45,
  };
  const C = (k) => [new THREE.Color(DAY[k]), new THREE.Color(NIGHT[k])];
  const col = { sunCol: C("sunCol"), sky: C("sky"), ground: C("ground"), ambCol: C("ambCol"), fillCol: C("fillCol"), deep: C("deep"), shore: C("shore"), fog: C("fog"), skyTop: C("skyTop"), shallow: C("shallow") };
  const wetCol = new THREE.Color("#c9d3d6"), fogNow = new THREE.Color(), skyNow = new THREE.Color();
  const lerpC = (target, k, t) => target.copy(col[k][0]).lerp(col[k][1], t);
  const lerpN = (k, t) => THREE.MathUtils.lerp(DAY[k], NIGHT[k], t);

  // 霧：只淡淡蓋住遠方的海與海岸，近處的島不受影響（深度從鏡頭量）
  scene.fog = new THREE.Fog(DAY.fog, 205, 370);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = DAY.exposure;

  let night = 0, nightTarget = 0, wet = 0;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const uniforms = { dotTime: { value: 0 }, dotMotion: { value: 1 }, uShallow: { value: shallowTex }, uShallowSize: { value: SH }, uDeep: { value: new THREE.Color() }, uShore: { value: new THREE.Color() }, uGlint: { value: DAY.glint } };
  waveMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = "uniform float dotTime; uniform float dotMotion; varying vec2 vSeaXZ;\n" + shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
      transformed.y += dotMotion * (.12*sin(position.x*.08+dotTime*.6)+.12*cos(position.z*.07+dotTime*.5));
      vSeaXZ = (modelMatrix * vec4(position, 1.0)).xz;`);
    shader.fragmentShader = "uniform float dotTime; uniform float dotMotion; uniform sampler2D uShallow; uniform float uShallowSize; uniform vec3 uDeep; uniform vec3 uShore; uniform float uGlint; varying vec2 vSeaXZ;\n" + shader.fragmentShader
      .replace("#include <color_fragment>", `#include <color_fragment>
        float seaShallow = texture2D(uShallow, vSeaXZ / uShallowSize + 0.5).r;
        float seaSwell = 0.5 + 0.5 * sin(vSeaXZ.x * .045 + vSeaXZ.y * .035 + dotTime * .35);
        diffuseColor.rgb = mix(uDeep, uShore, seaShallow) * (0.96 + 0.07 * seaSwell);`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        vec2 seaGp = vSeaXZ * vec2(.22, .5);
        vec2 seaGf = fract(seaGp) - .5;
        float seaGh = fract(sin(dot(floor(seaGp), vec2(127.1, 311.7))) * 43758.5453);
        float seaTw = .5 + .5 * sin(dotTime * (1.2 + seaGh * 2.) + seaGh * 40.);
        float seaGlint = step(.88, seaGh) * smoothstep(.14, .02, length(seaGf * vec2(1., 2.6))) * mix(.55, seaTw, dotMotion);
        totalEmissiveRadiance += uGlint * seaGlint * vec3(.85, .95, 1.) * (1. - seaShallow * .4);`);
  };
  waveMat.customProgramCacheKey = () => "dot-sea-r169-v2";

  function setNight(on) { nightTarget = typeof on === "number" ? on : (on ? 1 : 0); if (motion.matches) night = nightTarget; }
  function setWet(a) { wet = a; }

  function update(dt, t) {
    night += (nightTarget - night) * (motion.matches ? 1 : 1 - Math.exp(-dt * 0.6));
    const n = night;
    sun.intensity = lerpN("sun", n); lerpC(sun.color, "sunCol", n);
    hemi.intensity = lerpN("hemi", n); lerpC(hemi.color, "sky", n); lerpC(hemi.groundColor, "ground", n);
    if (amb) { amb.intensity = lerpN("amb", n); lerpC(amb.color, "ambCol", n); }
    if (fill) { fill.intensity = lerpN("fill", n); lerpC(fill.color, "fillCol", n); }
    renderer.toneMappingExposure = lerpN("exposure", n);
    lerpC(uniforms.uDeep.value, "deep", n); lerpC(uniforms.uShore.value, "shore", n);
    uniforms.uGlint.value = lerpN("glint", n);
    // 下雨時遠方灰一點點（只動霧與天空，不把整個畫面染灰）
    lerpC(fogNow, "fog", n).lerp(wetCol, wet * 0.25);
    lerpC(skyNow, "skyTop", n).lerp(wetCol, wet * 0.3);
    scene.fog.color.copy(fogNow);
    if (scene.background?.isColor) scene.background.copy(fogNow);
    backdrop?.setSky(skyNow, fogNow, n);
    if (shallowMat) { lerpC(shallowMat.color, "shallow", n); shallowMat.opacity = lerpN("shallowOp", n); }
    lampMat.emissiveIntensity = n * 1.6;
    halos.visible = n > 0.05;
    haloMat.opacity = n * 0.24;
    uniforms.dotTime.value = t; uniforms.dotMotion.value = motion.matches ? 0 : 1;
    if (motion.matches) dt = 0;
    for (const m of moving) {
      m.a += m.speed * dt;
      m.obj.position.set(Math.cos(m.a) * m.rad, -1.1 + Math.sin(t * 1.4 + m.rad) * 0.12, Math.sin(m.a) * m.rad * 0.7);
      m.obj.rotation.y = -m.a + (m.speed > 0 ? -Math.PI / 2 : Math.PI / 2);
    }
  }

  update(0, 0);
  return { update, setNight, setWet };
}
