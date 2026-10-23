// 場景細節：岸邊岩石與花草、海浪、船、雲、日夜切換（島間的橋在 app.js）。
// 由 app.js 在建島後呼叫 addSceneExtras(ctx)，回傳 { update(dt, t), setNight(on) }。

export function addSceneExtras(ctx) {
  const { THREE, scene, world, islands, LAYOUT, hexToWorld, mid, R, mat, box, cyl, cone, tree, sun, hemi, rng, boatModels = {} } = ctx;
  const rand = rng(20261024);
  const moving = [];

  // 所有六角格與所屬島
  const cells = [];
  for (const isl of islands) for (const [q, r] of LAYOUT[isl.id]) cells.push({ q, r, id: isl.id, p: hexToWorld(q, r).sub(mid) });
  const key = (q, r) => `${q},${r}`;
  const byKey = new Map(cells.map((c) => [key(c.q, c.r), c]));
  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

  // ── 外圍岸邊：沒有鄰格的那一側放岩石、灌木與小碼頭 ────────────────
  const rockGeo = new THREE.DodecahedronGeometry(0.6, 0);
  const rockMat = mat("#b9b1a3");
  const flowerColors = ["#f2a1b5", "#f6d26b", "#ffffff", "#c9a7e8", "#f08a5d"];
  const flowerGeo = new THREE.SphereGeometry(0.16, 6, 4);
  const flowers = flowerColors.map((col) => new THREE.InstancedMesh(flowerGeo, mat(col), 400));
  const fCount = flowerColors.map(() => 0);
  const m4 = new THREE.Matrix4();
  for (const c of cells) {
    DIRS.forEach(([dq, dr], k) => {
      if (byKey.get(key(c.q + dq, c.r + dr))) return;
      const dir = hexToWorld(dq, dr).normalize();
      const edge = c.p.clone().add(dir.clone().multiplyScalar(R * 1.02));
      for (let i = 0; i < 3; i++) {
        const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar((rand() - 0.5) * R * 0.8);
        const rock = new THREE.Mesh(rockGeo, rockMat);
        rock.position.copy(edge).add(side).add(dir.clone().multiplyScalar(rand() * 0.8));
        rock.position.y = -1.1 + rand() * 0.3;
        rock.scale.setScalar(0.6 + rand() * 0.9);
        rock.rotation.set(rand() * 3, rand() * 3, rand() * 3);
        rock.castShadow = true;
        world.add(rock);
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
  flowers.forEach((f, i) => { f.count = fCount[i]; world.add(f); });

  // ── 海浪：低解析度水面，用頂點高度做緩慢起伏 ──────────────────────
  const waveGeo = new THREE.PlaneGeometry(420, 420, 28, 28);
  waveGeo.rotateX(-Math.PI / 2);
  const waveMat = new THREE.MeshStandardMaterial({ color: "#9fd3d3", roughness: 0.6, metalness: 0.05, flatShading: true });
  const waves = new THREE.Mesh(waveGeo, waveMat);
  waves.position.y = -1.2;  // 浪谷仍高於底層平面海，避免透出色塊
  waves.receiveShadow = true;
  scene.add(waves);
  const wpos = waveGeo.attributes.position;
  const base = Float32Array.from(wpos.array);

  // ── 船：沿群島外圍繞行 ───────────────────────────────────────────
  function boat(color) {
    const g = new THREE.Group();
    g.add(box(2.6, 0.5, 1.1, color, 0, 0, 0));
    g.add(box(1.2, 0.6, 0.8, "#fffaf0", -0.2, 0.5, 0));
    g.add(cyl(0.05, 0.05, 1.6, 4, "#6b5a48", 0.6, 0.5, 0));
    g.add(cone(0.5, 1.2, 3, "#ffffff", 0.95, 0.9, 0));
    return g;
  }
  [["#e4994a", 72, 0.035], ["#4f9fc4", 84, -0.028], ["#e48f9e", 96, 0.022]].forEach(([col, rad, speed], i) => {
    const ids = Object.keys(boatModels);
    const b = ids.length ? boatModels[ids[i % ids.length]].clone(true) : boat(col);
    world.add(b);
    moving.push({ obj: b, kind: "boat", rad, speed, a: i * 2.1 });
  });

  // ── 雲：慢慢飄過 ─────────────────────────────────────────────────
  const cloudMat = new THREE.MeshStandardMaterial({ color: "#ffffff", transparent: true, opacity: 0.7, roughness: 1 });
  for (let i = 0; i < 7; i++) {
    const g = new THREE.Group();
    for (let k = 0; k < 4; k++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(2.2 + rand() * 1.5, 10, 8), cloudMat);
      s.position.set(k * 2.4 - 3.6, rand() * 0.8, rand() * 1.5);
      g.add(s);
    }
    g.position.set(-120 + rand() * 240, 30 + rand() * 8, -170 + rand() * 60);  // 只在島群後方飄，不遮擋
    g.scale.setScalar(0.7 + rand() * 0.4);
    scene.add(g);
    moving.push({ obj: g, kind: "cloud", speed: 1.2 + rand() * 1.2 });
  }

  // ── 日夜切換 ─────────────────────────────────────────────────────
  const DAY = { bg: "#bfe3e2", sun: 2.2, hemi: 1.6, sea: "#9fd3d3" };
  const NIGHT = { bg: "#22324a", sun: 0.35, hemi: 0.55, sea: "#3a5a78" };
  const lampMat = new THREE.MeshStandardMaterial({color:0xffefba,emissive:0xffcf78,emissiveIntensity:0});
  const lampGeo=new THREE.SphereGeometry(.16,6,4);
  for(const c of cells){const pole=cyl(.05,.06,2.2,6,"#6c8586",c.p.x+R*.8,.5,c.p.z);world.add(pole);const bulb=new THREE.Mesh(lampGeo,lampMat);bulb.position.set(c.p.x+R*.8,2.75,c.p.z);world.add(bulb);}
  let night=0,nightTarget=0;
  const dayBg=new THREE.Color(DAY.bg),nightBg=new THREE.Color(NIGHT.bg),daySea=new THREE.Color(DAY.sea),nightSea=new THREE.Color(NIGHT.sea);
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  const uniforms={dotTime:{value:0},dotMotion:{value:1}};
  waveMat.onBeforeCompile=shader=>{Object.assign(shader.uniforms,uniforms);shader.vertexShader='uniform float dotTime; uniform float dotMotion;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n transformed.y += dotMotion * (.10*sin(position.x*.08+dotTime*.6)+.10*cos(position.z*.07+dotTime*.5));');shader.fragmentShader='uniform float dotTime; uniform float dotMotion;\n'+shader.fragmentShader;shader.fragmentShader=shader.fragmentShader.replace('#include <dithering_fragment>','gl_FragColor.rgb += dotMotion * .012 * sin(gl_FragCoord.x*.045+gl_FragCoord.y*.03+dotTime*.6);\n#include <dithering_fragment>');};
  waveMat.customProgramCacheKey=()=>"dot-water-r169-v1";
  function setNight(on){nightTarget=on?1:0;if(motion.matches)night=nightTarget;}

  function update(dt, t) {
    night += (nightTarget-night)*(motion.matches?1:1-Math.exp(-dt*2));
    scene.background.copy(dayBg).lerp(nightBg,night);sun.intensity=THREE.MathUtils.lerp(DAY.sun,NIGHT.sun,night);hemi.intensity=THREE.MathUtils.lerp(DAY.hemi,NIGHT.hemi,night);waveMat.color.copy(daySea).lerp(nightSea,night);lampMat.emissiveIntensity=night*.9;
    uniforms.dotTime.value=t;uniforms.dotMotion.value=motion.matches?0:1;
    if(motion.matches)dt=0;
    for (const m of moving) {
      if (m.kind === "boat") {
        m.a += m.speed * dt;
        m.obj.position.set(Math.cos(m.a) * m.rad, -1.1 + Math.sin(t * 1.4 + m.rad) * 0.12, Math.sin(m.a) * m.rad * 0.7);
        m.obj.rotation.y = -m.a + (m.speed > 0 ? -Math.PI / 2 : Math.PI / 2);
      } else {
        m.obj.position.x += m.speed * dt;
        if (m.obj.position.x > 140) m.obj.position.x = -140;
      }
    }
  }

  update(0,0);
  return { update, setNight };
}
