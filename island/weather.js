// 天氣：日夜與下雨自己慢慢變，沒有固定規則。
// addWeather(ctx) 回傳 { update(dt), get night, get rain }。
// 日夜：一個約 7 分鐘的慢週期，再疊一點隨機漂移，所以每次看都不太一樣。
// 下雨：偶爾來一陣，20 秒內慢慢落下、慢慢停，雨勢大小也隨機。

export function addWeather({ THREE, scene, setNight, rng }) {
  const rand = rng(20261031);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── 日夜 ───────────────────────────────────────────────────────
  let clock = rand() * 420;        // 從一天裡的隨機時刻開始
  let drift = 0, driftTarget = 0;  // 讓週期不那麼規律
  let night = 0;
  let mode = "auto";  // auto／day／night（日夜按鈕切換）

  // ── 雨 ─────────────────────────────────────────────────────────
  const N = 2200;
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
  const mat = new THREE.PointsMaterial({ color: "#dfeef5", size: 0.55, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true });
  const rain = new THREE.Points(geo, mat);
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);
  let rainAmt = 0, rainTarget = 0, nextChange = 40 + rand() * 80;
  const wet = new THREE.Color("#8ea4ab");

  function update(dt) {
    if (reduced) { setNight(mode === "night" ? 1 : 0); return; }
    // 日夜：sin 週期（約 7 分鐘）＋ 慢速隨機漂移，轉成 0（白天）到 1（夜晚）的平滑量
    clock += dt;
    if (Math.abs(drift - driftTarget) < 0.01) driftTarget = (rand() - 0.5) * 0.5;
    drift += (driftTarget - drift) * (1 - Math.exp(-dt / 40));
    const k = 0.5 - 0.5 * Math.cos((clock / 420) * Math.PI * 2 + drift);
    night = mode === "day" ? 0 : mode === "night" ? 1 : THREE.MathUtils.smoothstep(k, 0.25, 0.8);
    setNight(night);

    // 雨：每隔一陣子決定要不要下、下多大；雨量 20 秒內慢慢過渡
    nextChange -= dt;
    if (nextChange <= 0) {
      rainTarget = rainTarget > 0 ? 0 : 0.35 + rand() * 0.65;
      nextChange = rainTarget > 0 ? 45 + rand() * 60 : 90 + rand() * 150;
    }
    rainAmt += (rainTarget - rainAmt) * (1 - Math.exp(-dt / 20));
    rain.visible = rainAmt > 0.01;
    if (rain.visible) {
      mat.opacity = rainAmt * 0.55;
      const a = geo.attributes.position.array;
      for (let i = 0; i < N; i++) {
        a[i * 3 + 1] -= speed[i] * dt;
        a[i * 3] -= 6 * dt;  // 風向
        if (a[i * 3 + 1] < -1) { a[i * 3 + 1] = AREA.h; a[i * 3] = (rand() - 0.5) * AREA.x * 2; a[i * 3 + 2] = (rand() - 0.5) * AREA.z * 2; }
      }
      geo.attributes.position.needsUpdate = true;
      // 下雨時天色灰一點（在 extras 算完日夜底色之後疊上去）
      scene.background.lerp(wet, rainAmt * 0.45);
    }
  }
  function cycleMode() { mode = { auto: "day", day: "night", night: "auto" }[mode]; return mode; }
  return { update, cycleMode, get night() { return night; }, get rain() { return rainAmt; } };
}
