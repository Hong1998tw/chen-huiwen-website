// 滑鼠與觸控的手感：游標狀態、懸停時建築微微浮起、點擊漣漪、雙擊／雙點聚焦、拖曳範圍限制。
// createInteraction(ctx) 回傳 { hover(obj), ripple(point), update(dt) }。

export function createInteraction({ THREE, scene, camera, controls, canvas, pickables, TOP, reduced, onDoubleTap, onDragStart }) {
  const roots = new Set(pickables);
  const rootOf = (o) => { while (o && !roots.has(o)) o = o.parent; return o; };

  // ── 操作方式：像模擬城市一樣，左鍵／單指拖曳平移，右鍵／雙指旋轉與縮放 ──
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.zoomToCursor = true;
  controls.dampingFactor = 0.08;
  if (reduced()) controls.enableDamping = false;
  controls.zoomSpeed = 1.2;
  canvas.style.touchAction = "none";
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // 平移不超出群島範圍
  const LIMIT = 95;
  controls.addEventListener("change", () => {
    const t = controls.target, len = Math.hypot(t.x, t.z);
    if (len > LIMIT) {
      const k = LIMIT / len, dx = t.x * k - t.x, dz = t.z * k - t.z;
      t.x += dx; t.z += dz; camera.position.x += dx; camera.position.z += dz;
    }
  });

  // 游標：可點 → 手指，拖曳中 → 抓取
  let dragging = false, hovering = false;
  const cursor = () => { canvas.style.cursor = dragging ? "grabbing" : hovering ? "pointer" : "grab"; };
  controls.addEventListener("start", () => { dragging = true; cursor(); onDragStart?.(); });  // 使用者一拖曳就中斷相機飛行
  controls.addEventListener("end", () => { dragging = false; cursor(); });
  cursor();

  // ── 懸停：建築浮起並放大一點，離開時回彈 ─────────────────────────
  const lifted = new Map();  // root → { k: 0..1, base: {y, s} }
  let current = null;
  function hover(obj) {
    const r = obj ? rootOf(obj) : null;
    const ud = obj?.userData || {};
    hovering = !!(ud.island || ud.river || ud.bridge || ud.longlong || ud.huiwen);
    // 只讓建築與人物浮起，整塊島地與橋不動
    const liftable = r && (ud.item != null || ud.landmark || ud.figure || ud.thread != null || ud.longlong || ud.huiwen);
    if (!liftable) { current = null; cursor(); return; }
    cursor();
    if (r === current) return;
    current = r;
    if (r && !lifted.has(r)) lifted.set(r, { k: 0, y: r.position.y, s: r.scale.clone() });
  }

  // ── 點擊漣漪：在點到的位置畫兩圈擴散的光環 ──────────────────────
  const ringGeo = new THREE.RingGeometry(0.82, 1, 48);
  ringGeo.rotateX(-Math.PI / 2);
  const ripples = [];
  function ripple(point, color = "#f3c64f") {
    if (!point) return;
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }));
      m.position.set(point.x, Math.max(point.y, TOP) + 0.12, point.z);
      m.renderOrder = 5;
      scene.add(m);
      ripples.push({ m, t: -i * 0.12 });
    }
  }

  // ── 雙擊（滑鼠）／雙點（觸控）：飛到該處並放大 ───────────────────
  canvas.addEventListener("dblclick", (e) => onDoubleTap?.(e));
  let lastTap = 0, lastXY = [0, 0];
  canvas.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse") return;
    const now = performance.now();
    if (now - lastTap < 300 && Math.hypot(e.clientX - lastXY[0], e.clientY - lastXY[1]) < 24) { onDoubleTap?.(e); lastTap = 0; return; }
    lastTap = now; lastXY = [e.clientX, e.clientY];
  });

  function update(dt) {
    const rate = reduced() ? 1 : 1 - Math.exp(-dt * 14);
    for (const [r, st] of lifted) {
      const goal = r === current ? 1 : 0;
      st.k += (goal - st.k) * rate;
      r.position.y = st.y + st.k * 0.6;
      r.scale.copy(st.s).multiplyScalar(1 + st.k * 0.05);
      if (goal === 0 && st.k < 0.002) { r.position.y = st.y; r.scale.copy(st.s); lifted.delete(r); }
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const p = ripples[i];
      p.t += dt;
      if (p.t < 0) continue;
      const k = p.t / 0.7;
      p.m.scale.setScalar(0.4 + k * 4.5);
      p.m.material.opacity = Math.max(0, 0.9 * (1 - k));
      if (k >= 1) { scene.remove(p.m); p.m.material.dispose(); ripples.splice(i, 1); }
    }
  }

  return { hover, ripple, update };
}
