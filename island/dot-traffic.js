// 交通細節：車道邊線、橋頭路口的斑馬線與智慧號誌、高架捷運（橘線）。
// addTraffic(ctx) 回傳 { update(dt, t), mustStop(key, u, dir) }。

export function addTraffic(ctx) {
  const { THREE, world, cells, bridgePairs, cellPos, edgeU, hexPoint, hexRing, R, TOP, ROAD_IN, ROAD_OUT, ROAD_MID, mat, box, cyl } = ctx;

  // ── 車道邊線（只有開車模式才畫；島上目前不走車）──────────────────
  const lineMat = mat("#f6f1e2");
  for (const c of ctx.pedestrianOnly ? [] : cells) {
    for (const rad of [ROAD_IN + 0.18, ROAD_OUT - 0.18]) {
      const ring = new THREE.Mesh(hexRing(rad + 0.05, rad - 0.05), lineMat);
      ring.position.set(c.p.x, TOP + 0.045, c.p.z);
      world.add(ring);
    }
  }

  // ── 橋頭路口：斑馬線＋智慧號誌 ────────────────────────────────────
  const junctions = new Map();  // key → [{u, phase, lamps}]
  const lampOn = { r: mat("#ff4d3d", { emissive: "#ff2a1a", emissiveIntensity: 1.2 }), y: mat("#ffc93c", { emissive: "#ffb000", emissiveIntensity: 1.2 }), g: mat("#3ddc84", { emissive: "#1fcf6a", emissiveIntensity: 1.2 }) };
  const lampOff = mat("#3a3f44");
  const CYCLE = 9, GREEN = 4.5, YELLOW = 1.2;  // 秒
  for (const bp of ctx.pedestrianOnly ? [] : bridgePairs) {  // 不走車就不需要斑馬線與號誌
    for (const [from, to] of [[bp.a, bp.b], [bp.b, bp.a]]) {
      const key = from.join(","), c = cellPos(...from), u = edgeU(from, to);
      // 斑馬線：在路口兩側橫越車道
      for (const du of [-0.09, 0.09]) {
        const p0 = hexPoint(c, ROAD_MID, (u + du + 6) % 6), p1 = hexPoint(c, ROAD_MID, (u + du + 0.01 + 6) % 6);
        const ang = -Math.atan2(p1.z - p0.z, p1.x - p0.x);
        for (let k = -3; k <= 3; k++) {
          const off = new THREE.Vector3(p0.x - c.x, 0, p0.z - c.z).normalize().multiplyScalar(k * 0.22);
          const s = box(0.5, 0.03, 0.12, "#ffffff", 0, 0, 0);
          s.position.set(p0.x + off.x, TOP + 0.05, p0.z + off.z);
          s.rotation.y = ang;
          world.add(s);
        }
      }
      // 號誌桿：立在路口旁的人行道，含燈箱、偵測器、倒數面板（智慧號誌）
      const pole = new THREE.Group();
      const pos = hexPoint(c, R * 0.95, (u + 0.14) % 6);
      pole.add(cyl(0.06, 0.07, 2.6, 6, "#5b6166"));
      pole.add(box(0.9, 0.08, 0.08, "#5b6166", 0.4, 2.5, 0));
      const housing = box(0.28, 0.8, 0.22, "#2b2f33", 0.82, 2.0, 0);
      pole.add(housing);
      const lamps = {};
      [["r", 2.6], ["y", 2.35], ["g", 2.1]].forEach(([k, y]) => {
        const l = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), lampOff);
        l.position.set(0.82, y, 0.12);
        pole.add(l);
        lamps[k] = l;
      });
      pole.add(box(0.18, 0.12, 0.14, "#e8eef2", 0.25, 2.45, 0));          // 車流偵測器
      const count = box(0.26, 0.2, 0.04, "#101418", 0.2, 1.6, 0.06);       // 倒數面板
      pole.add(count);
      pole.position.set(pos.x, TOP + 0.08, pos.z);
      pole.rotation.y = -Math.atan2(c.z - pos.z, c.x - pos.x) + Math.PI;
      world.add(pole);
      const list = junctions.get(key) || [];
      list.push({ u, phase: (from[0] * 3.1 + from[1] * 1.7 + u) % CYCLE, lamps, count });
      junctions.set(key, list);
    }
  }
  const stateOf = (j, t) => {
    const x = ((t + j.phase) % CYCLE + CYCLE) % CYCLE;
    return x < GREEN ? "g" : x < GREEN + YELLOW ? "y" : "r";
  };
  let now = 0;
  // 車子快到路口（行進方向 0.25 以內）且燈號不是綠燈就停
  function mustStop(key, u, dir) {
    for (const j of junctions.get(key) || []) {
      const ahead = ((j.u - u) * dir + 6) % 6;
      if (ahead > 0.06 && ahead < 0.25 && stateOf(j, now) !== "g") return true;
    }
    return false;
  }

  // ── 高架捷運：沿 r=-2 與 r=-1 兩列之間的水道上方東西向行駛 ─────────────
  const zLine = (cellPos(0, -2).z + cellPos(0, -1).z) / 2;
  const X0 = -110, X1 = 110, H = 6.2;
  const viaduct = new THREE.Group();
  viaduct.add(box(X1 - X0, 0.5, 1.6, "#e9e4d8", 0, H - 0.5, 0));
  for (const z of [-0.65, 0.65]) viaduct.add(box(X1 - X0, 0.1, 0.12, "#8a9096", 0, H, z));
  for (let x = X0 + 4; x < X1; x += 9) {
    const wp = new THREE.Vector3(x, 0, zLine);
    const onLand = cells.some((c) => c.p.distanceTo(wp) < R * 1.02);
    if (!onLand) viaduct.add(cyl(0.35, 0.45, H + 2.5, 8, "#d6cfc2", x, -2.5, 0));
  }
  viaduct.position.z = zLine;
  world.add(viaduct);
  // 列車：三節橘線車廂
  const train = new THREE.Group();
  const doors = [];
  for (let k = 0; k < 3; k++) {
    const car = new THREE.Group();
    car.add(box(3.6, 1.2, 1.3, "#f5f3ee", 0, 0, 0));
    car.add(box(3.6, 0.22, 1.32, "#e8772e", 0, 0.35, 0));
    for (let w = -1; w <= 1; w++) car.add(box(0.7, 0.35, 1.34, "#3f5f6e", w * 1.05, 0.7, 0));
    for (const side of [-1,1]) for (const sign of [-1,1]) { const d=box(.32,.8,.04,"#dce4e8",sign*.17,.35,side*.68); car.add(d); doors.push({mesh:d,base:sign*.17,sign}); }
    car.position.x = k * 3.8;
    train.add(car);
  }
  train.position.set(X0 + 10, H + 0.05, zLine);
  world.add(train);
  // 鳳山西站（P01 上方）停靠
  const station = cellPos(2, -2).x;
  const tr = { x: X0 + 10, dir: 1, wait: 0 };

  function update(dt, t) {
    now = t;
    for (const list of junctions.values()) for (const j of list) {
      const st = stateOf(j, t);
      for (const k of ["r", "y", "g"]) j.lamps[k].material = st === k ? lampOn[k] : lampOff;
      j.count.material = st === "g" ? lampOn.g : st === "r" ? lampOn.r : lampOn.y;
    }
    const previousWait=tr.wait;
    if (tr.wait > 0) tr.wait=Math.max(0,tr.wait-dt);
    else {
      const prev=tr.x; const next=prev+tr.dir*dt*9;
      if ((prev<station && next>=station)||(prev>station && next<=station)) {tr.x=station;tr.wait=4;tr.departed=false;}
      else {tr.x=next;tr.departed=true;}
      if(tr.x>X1-14||tr.x<X0+2){tr.x=Math.max(X0+2,Math.min(X1-14,tr.x));tr.dir*=-1;tr.wait=2;}
    }
    const atStation=Math.abs(tr.x-station)<.001;
    const openness=atStation && tr.wait>.7 ? Math.min(1,(4-tr.wait)*2):atStation?Math.max(0,tr.wait/.7):0;
    for(const d of doors)d.mesh.position.x=d.base+d.sign*openness*.32;
    train.position.x=tr.x-3.8;
  }
  function gap(key,u,dir) {let d=Infinity;for(const j of junctions.get(key)||[]){if(stateOf(j,now)==="g")continue;const a=((j.u-dir*.12-u)*dir+12)%6;if(a<.8)d=Math.min(d,a);}return d;}
  function maxAdvance(key,u,dir){return Math.max(0,gap(key,u,dir)-.001);}
  function speedFactor(key,u,dir){return Math.min(1,Math.max(0,(gap(key,u,dir)-.005)/.5));}
  function pedestrianAllowed(key,u,dir){for(const j of junctions.get(key)||[]){const a=((j.u-u)*dir+12)%6;if(a<.24 && a>.04)return stateOf(j,now)==="r";}return true;}
  update(0,0);
  return { update, mustStop, maxAdvance, speedFactor, pedestrianAllowed, train, debugState:()=>({...tr}) };
}
