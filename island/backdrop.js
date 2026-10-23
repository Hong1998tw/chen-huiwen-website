// 外圍風景：海上的小島（風車、燈塔、涼亭、樹）與遠方一圈丘陵，讓群島像在一片真實的海灣裡。
// addBackdrop(ctx) 回傳 { update(dt) }。

export function addBackdrop({ THREE, scene, box, cyl, cone, tree, rng }) {
  const rand = rng(20261025);
  const spinning = [];
  const group = new THREE.Group();
  scene.add(group);

  // ── 遠方丘陵：只放在畫面後方（北、西北），低多邊形、顏色偏淡像有空氣感 ──
  const hillColors = ["#9cc3a0", "#a9cba8", "#b7d3b3"];
  for (let i = 0; i < 26; i++) {
    const a = -Math.PI * 0.95 + (i / 25) * Math.PI * 0.9 + (rand() - 0.5) * 0.08;
    const d = 190 + rand() * 40;
    const r = 18 + rand() * 22, h = 14 + rand() * 26;
    const hill = cone(r, h, 6, hillColors[i % 3], Math.cos(a) * d, -1.6, Math.sin(a) * d);
    hill.rotation.y = rand() * Math.PI;
    hill.receiveShadow = false;
    group.add(hill);
  }

  // ── 小島 ────────────────────────────────────────────────────────
  function islet(x, z, r, kind) {
    const g = new THREE.Group();
    g.add(cyl(r, r * 1.15, 1.6, 10, "#d9c7a0", 0, -1.9, 0));
    g.add(cyl(r * 0.92, r, 0.4, 10, "#9fca8c", 0, -0.3, 0));
    const trees = kind === "trees" ? 5 : 2;
    for (let i = 0; i < trees; i++) {
      const a = rand() * Math.PI * 2, d = r * (0.3 + rand() * 0.45);
      tree(g, Math.cos(a) * d, Math.sin(a) * d, 0.8 + rand() * 0.5);
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
      g.add(cone(2, 1.2, 6, "#c0573f", 0, 1.8, 0));
    }
    g.position.set(x, 0, z);
    g.rotation.y = rand() * Math.PI * 2;
    group.add(g);
  }
  const kinds = ["windmill", "trees", "lighthouse", "trees", "windmill", "pavilion", "trees", "windmill", "trees", "pavilion", "trees"];
  kinds.forEach((kind, i) => {
    const a = (i / kinds.length) * Math.PI * 2 + rand() * 0.3;
    const d = 112 + rand() * 26;
    islet(Math.cos(a) * d, Math.sin(a) * d * 0.85, 4 + rand() * 3, kind);
  });

  function update(dt) {
    for (const s of spinning) s.obj.rotation.z += dt * s.speed;
  }
  return { update };
}
