// 鳳山溪：沿著島與島之間的水道由北往南流（q=1 與 q=2 兩欄之間），頂寶橋跨溪；海邦橋跨前鎮河，另放一道水道。
// addRiver(ctx) 回傳 { update(dt), pickables, labels, skipPairs }。

export function addRiver(ctx) {
  const { THREE, world, cellPos, R, SPACING, mat, box, cyl, bridgeEnds, TOP, models } = ctx;
  const h = Math.sqrt(3) / 2;
  // 水道中心線：未加間距時的六角頂點，乘上間距後就落在兩島之間的水道正中
  const corner = (q, r, dx, dz) => cellPos(q, r).add(new THREE.Vector3(dx * R * SPACING, 0, dz * R * SPACING));

  const pts = [corner(1, -2, h, -1.7)];
  for (let r = -2; r <= 1; r++) pts.push(corner(1, r, h, -0.5), corner(1, r, h, 0.5));
  pts.push(corner(1, 1, h + 0.5, 1.3), corner(1, 1, h + 1.0, 2.3));
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.15);

  // 河面
  const N = 260, W = 1.25, Y = -0.62;
  const pos = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, p = curve.getPointAt(t), tan = curve.getTangentAt(t);
    const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize().multiplyScalar(W);
    pos.push(p.x + side.x, Y, p.z + side.z, p.x - side.x, Y, p.z - side.z);
    if (i < N) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const river = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: "#3f9cc0", roughness: 0.3, metalness: 0.1, side: THREE.DoubleSide }));
  river.receiveShadow = true;
  river.userData = { river: true };
  world.add(river);

  // 水流：沿河漂動的浪花
  const foam = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.03, 0.12), mat("#e8f7fb"), 80);
  const foamT = Array.from({ length: 80 }, (_, i) => i / 80);
  const foamS = Array.from({ length: 80 }, (_, i) => ((i * 37) % 11) / 11 - 0.5);
  world.add(foam);
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s4 = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);

  // 跨溪的橋：兩端接在相鄰兩格的環島道路上
  function riverBridge(a, b, build, id) {
    const { pa, pb } = bridgeEnds(a, b);
    const len = pa.distanceTo(pb), m = pa.clone().add(pb).multiplyScalar(0.5);
    const g = new THREE.Group();
    const glb = models?.[id];
    if (glb) {
      // 林 dot 的橋模型長約 8.1、橋面 y≈0.5，等比縮到實際跨距並對齊路面高度
      const mm = glb.clone(true), k = len / 8.1;
      mm.scale.setScalar(k);
      mm.position.y = TOP - 0.5 * k;
      g.add(mm);
    } else build(g, len);
    g.position.set(m.x, 0, m.z);
    g.rotation.y = -Math.atan2(pb.z - pa.z, pb.x - pa.x);
    g.traverse((o) => { o.castShadow = true; o.userData = { bridge: id }; });
    world.add(g);
    return { g, pos: m.clone().setY(4.5) };
  }

  // 頂寶橋：橋面、白色鋼拱、藍色欄杆
  const dingbao = riverBridge([0, 0], [0, -1],  // 使用者指定：一端接市議會島（質詢島），另一端接人行交通島
    (g, len) => {
    g.add(box(len, 0.32, 2.2, "#d8d2c6", 0, TOP - 0.1, 0));
    for (const z of [-1.1, 1.1]) {
      g.add(box(len, 0.32, 0.08, "#3f7fb8", 0, TOP + 0.22, z));
      const arch = new THREE.Mesh(new THREE.TorusGeometry(len * 0.36, 0.1, 6, 28, Math.PI), mat("#ffffff"));
      arch.position.set(0, TOP + 0.2, z);
      g.add(arch);
      for (let i = -3; i <= 3; i++) {
        const x = (i / 3.6) * len * 0.36, hh = Math.sqrt(Math.max(0, (len * 0.36) ** 2 - x * x));
        if (hh > 0.2) g.add(box(0.05, hh, 0.05, "#ffffff", x, TOP + 0.2, z));
      }
    }
    for (const x of [-len * 0.3, len * 0.3]) g.add(cyl(0.3, 0.36, 2.4, 8, "#b9b1a3", x, -1.9, 0));
  }, "dingbao");

  // 海邦橋：跨前鎮河（不在鳳山溪上），放在鳳山溪以東的另一道水道
  const haibang = riverBridge([0, 0], [1, 0],  // 使用者指定：一端接市議會島；另一端是文史觀光島的美麗島雜誌社格
    (g, len) => {
    g.add(box(len, 0.32, 2.4, "#d8d2c6", 0, TOP - 0.1, 0));
    for (const z of [-1.2, 1.2]) g.add(box(len, 0.3, 0.08, "#f4efe4", 0, TOP + 0.22, z));
    for (const x of [-len * 0.22, len * 0.22]) {
      g.add(box(0.4, 4.2, 0.4, "#d9663f", x, TOP, 0));
      for (const d of [-1.6, -0.8, 0.8, 1.6]) {
        const top = new THREE.Vector3(x, TOP + 4.0, 0), foot = new THREE.Vector3(x + d, TOP + 0.25, 0);
        const len2 = top.distanceTo(foot);
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, len2, 4), mat("#f4efe4"));
        cable.position.copy(top).add(foot).multiplyScalar(0.5);
        cable.quaternion.setFromUnitVectors(up, foot.clone().sub(top).normalize());
        g.add(cable);
      }
    }
    for (const x of [-len * 0.3, len * 0.3]) g.add(cyl(0.3, 0.36, 2.4, 8, "#b9b1a3", x, -1.9, 0));
  }, "haibang");

  const labels = [
    { text: "鳳山溪", pos: curve.getPointAt(0.62).setY(1.2), kind: "river" },
    { text: "頂寶橋", pos: dingbao.pos, kind: "bridge", id: "dingbao" },
    { text: "海邦橋", pos: haibang.pos, kind: "bridge", id: "haibang" },
  ];

  function update(dt) {
    for (let i = 0; i < foamT.length; i++) {
      foamT[i] = (foamT[i] + dt * 0.02) % 1;
      const p = curve.getPointAt(foamT[i]), tan = curve.getTangentAt(foamT[i]);
      const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize().multiplyScalar(foamS[i] * W * 1.4);
      q4.setFromAxisAngle(up, -Math.atan2(tan.z, tan.x));
      m4.compose(new THREE.Vector3(p.x + side.x, Y + 0.03, p.z + side.z), q4, s4);
      foam.setMatrixAt(i, m4);
    }
    foam.instanceMatrix.needsUpdate = true;
  }

  return {
    update,
    pickables: [river, dingbao.g, haibang.g],
    labels,
    // 這兩處由頂寶橋、海邦橋取代通用的道路橋
    skipPairs: new Set(["0,-1|0,0", "0,0|1,0"]),
  };
}
