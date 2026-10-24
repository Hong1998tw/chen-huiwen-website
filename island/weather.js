// 天氣：日夜與下雨自己慢慢變。
// addWeather(ctx) 回傳 { update(dt), cycleMode(), get night, get rain }。
// 日夜：每次打開都從明亮的白天開始；約 10 分鐘一輪，大部分時間是白天，夜晚是亮藍色的夜。
// 下雨：很少來，雨勢小、雨點淡，只讓遠方天空稍微灰一點，不把整個畫面染灰。

export function addWeather({ THREE, scene, setNight, setWet, rng }) {
  const rand = rng(20261031);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mobile = innerWidth <= 760;

  // ── 日夜 ───────────────────────────────────────────────────────
  const PERIOD = 600;              // 一輪約 10 分鐘
  let clock = 0;                   // 從白天開始（不再隨機）
  let drift = 0, driftTarget = 0;  // 讓週期不那麼規律
  let night = 0;
  let mode = "auto";  // auto／day／night（日夜按鈕切換）

  // ── 雨 ─────────────────────────────────────────────────────────
  const N = mobile ? 500 : 1100;
  const AREA = { x: 150, z: 120, h: 70 };
  const pos = new Float32Array(N * 3), speed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (rand() - 0.5) * AREA.x * 2;
    pos[i * 3 + 1] = rand() * AREA.h;
    pos[i * 3 + 2] = (rand() - 0.5) * AREA.z * 2;
    speed[i] = 38 + rand() * 22;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: "#eef6fa", size: 0.4, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true });
  const rain = new THREE.Points(geo, mat);
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);
  let rainAmt = 0, rainTarget = 0, nextChange = 360 + rand() * 300;  // 開頭至少六分鐘不下雨

  function update(dt) {
    if (reduced) { setNight(mode === "night" ? 1 : 0); setWet?.(0); return; }
    // 日夜：cos 週期＋慢速漂移；只有週期中段那一小段是夜晚，其餘都是白天
    clock += dt;
    if (Math.abs(drift - driftTarget) < 0.01) driftTarget = (rand() - 0.5) * 0.3;
    drift += (driftTarget - drift) * (1 - Math.exp(-dt / 40));
    const k = 0.5 - 0.5 * Math.cos((clock / PERIOD) * Math.PI * 2 + drift * Math.min(1, clock / 60));
    night = mode === "day" ? 0 : mode === "night" ? 1 : THREE.MathUtils.smoothstep(k, 0.7, 0.95);
    setNight(night);

    // 雨：偶爾來一小陣（30–50 秒），之後隔 6–11 分鐘才可能再下
    nextChange -= dt;
    if (nextChange <= 0) {
      rainTarget = rainTarget > 0 ? 0 : 0.15 + rand() * 0.2;
      nextChange = rainTarget > 0 ? 30 + rand() * 20 : 360 + rand() * 300;
    }
    rainAmt += (rainTarget - rainAmt) * (1 - Math.exp(-dt / 15));
    rain.visible = rainAmt > 0.01;
    setWet?.(rainAmt);
    if (rain.visible) {
      mat.opacity = rainAmt * 0.5;
      const a = geo.attributes.position.array;
      for (let i = 0; i < N; i++) {
        a[i * 3 + 1] -= speed[i] * dt;
        a[i * 3] -= 6 * dt;  // 風向
        if (a[i * 3 + 1] < -1) { a[i * 3 + 1] = AREA.h; a[i * 3] = (rand() - 0.5) * AREA.x * 2; a[i * 3 + 2] = (rand() - 0.5) * AREA.z * 2; }
      }
      geo.attributes.position.needsUpdate = true;
    }
  }
  function cycleMode() { mode = { auto: "day", day: "night", night: "auto" }[mode]; return mode; }
  return { update, cycleMode, get night() { return night; }, get rain() { return rainAmt; } };
}
