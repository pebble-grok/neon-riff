/* Neon Riff - UI wiring, settings, song loading, YouTube mode, calibration, PWA bits. */
(function () {
  "use strict";
  const NR = window.NR;
  const $ = (id) => document.getElementById(id);
  const SKEY = "neonriff.settings.v1", BKEY = "neonriff.best.v1";
  const settings = Object.assign({ volume: 0.8, offsetMs: 0, speed: 1, diff: "medium", tab: "file", ytBpm: 120 }, safeJSON(localStorage.getItem(SKEY)));
  function safeJSON(s) { try { return JSON.parse(s) || {}; } catch (e) { return {}; } }
  const save = () => { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch (e) {} };
  const S = { song: null, yt: null, chart: null, ctx: null, gain: null, previewPlayer: null, gamePlayer: null, lastStats: null, err: [] };
  window.__nr = S; // handy for debugging / automated tests

  let toastTimer;
  function toast(msg, ms) { const t = $("toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), ms || 3500); }
  function show(id) { for (const s of document.querySelectorAll(".screen")) s.classList.toggle("active", s.id === id); }
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  function info(el, msg, cls) { el.textContent = msg; el.className = "info" + (cls ? " " + cls : ""); el.classList.remove("hidden"); }

  function ensureCtx() {
    if (!S.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      S.ctx = new AC({ latencyHint: "interactive" });
      S.gain = S.ctx.createGain(); S.gain.gain.value = settings.volume; S.gain.connect(S.ctx.destination);
    }
    if (S.ctx.state === "suspended") S.ctx.resume().catch(() => {});
    return S.ctx;
  }

  // ---------- game ----------
  const cv = $("cv");
  const game = new NR.Game(cv, {
    onEnd: (st) => showResults(st),
    onPause: () => { $("pause").classList.remove("hidden"); syncSliders(); },
    onResume: () => $("pause").classList.add("hidden"),
    isModalOpen: () => !$("calib").classList.contains("hidden"),
  });
  S.game = game;
  game.touchUI = matchMedia("(pointer: coarse)").matches;
  function applySettings() {
    game.settings.offsetMs = settings.offsetMs; game.settings.speed = settings.speed;
    if (S.gain) S.gain.gain.value = settings.volume;
    if (S.gamePlayer && S.gamePlayer.setVolume) try { S.gamePlayer.setVolume(Math.round(settings.volume * 100)); } catch (e) {}
    save();
  }
  function bindSlider(inp, out, key, fmt) {
    inp.value = settings[key]; out.textContent = fmt(settings[key]);
    inp.addEventListener("input", () => { settings[key] = parseFloat(inp.value); out.textContent = fmt(settings[key]); applySettings(); syncSliders(); });
  }
  const fVol = (v) => Math.round(v * 100) + "%", fOff = (v) => (v > 0 ? "+" : "") + v + " ms", fSpd = (v) => v.toFixed(2) + "x";
  bindSlider($("vol"), $("volOut"), "volume", fVol); bindSlider($("vol2"), $("volOut2"), "volume", fVol);
  bindSlider($("offset"), $("offOut"), "offsetMs", fOff); bindSlider($("offset2"), $("offOut2"), "offsetMs", fOff);
  bindSlider($("speed"), $("speedOut"), "speed", fSpd);
  function syncSliders() {
    for (const [i, o, k, f] of [["vol", "volOut", "volume", fVol], ["vol2", "volOut2", "volume", fVol], ["offset", "offOut", "offsetMs", fOff], ["offset2", "offOut2", "offsetMs", fOff], ["speed", "speedOut", "speed", fSpd]]) {
      if (document.activeElement !== $(i)) $(i).value = settings[k]; $(o).textContent = f(settings[k]);
    }
  }
  applySettings();

  // ---------- tabs & difficulty ----------
  function setTab(t) {
    settings.tab = t; save();
    for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === t);
    $("tab-file").classList.toggle("active", t === "file"); $("tab-yt").classList.toggle("active", t === "yt");
    updatePlayable();
  }
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => setTab(b.dataset.tab));
  function setDiff(d) {
    settings.diff = d; save();
    for (const b of document.querySelectorAll(".diff")) b.classList.toggle("active", b.dataset.diff === d);
    updatePlayable();
  }
  for (const b of document.querySelectorAll(".diff")) b.addEventListener("click", () => setDiff(b.dataset.diff));

  function songKey() { return settings.tab === "file" ? (S.song ? "f:" + S.song.name + ":" + S.song.size : null) : (S.yt ? "y:" + S.yt.id : null); }
  function bestFor(key, diff) { const b = safeJSON(localStorage.getItem(BKEY)); return b[key + "|" + diff] || null; }
  function updatePlayable() {
    let ok = false, line = "No song selected";
    if (settings.tab === "file" && S.song) {
      ok = true;
      line = `<b>${escapeHtml(S.song.name)}</b> · ${fmtTime(S.song.analysis.duration)} · ~${Math.round(S.song.analysis.bpm)} BPM (detected)`;
    } else if (settings.tab === "yt" && S.yt && S.yt.ready) {
      ok = parseFloat($("ytBpm").value) >= 40;
      line = `<b>YouTube ${escapeHtml(S.yt.id)}</b> · ${parseFloat($("ytBpm").value).toFixed(1)} BPM (manual) · approximate`;
    }
    for (const b of document.querySelectorAll(".diff")) {
      const d = b.dataset.diff, i = b.querySelector("i");
      if (settings.tab === "file" && S.song) i.textContent = S.song.charts[d].notes.length + " notes"; else i.textContent = "";
      const best = songKey() && bestFor(songKey(), d);
      if (best) i.textContent += (i.textContent ? " · " : "") + "best " + best.grade;
    }
    $("songLine").innerHTML = line;
    $("playBtn").disabled = !ok;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

  // ---------- file mode ----------
  async function handleFile(file) {
    if (!file) return;
    const fi = $("fileInfo");
    ensureCtx();
    show("loading"); $("loadTitle").textContent = "Analysing " + file.name; $("loadBar").style.width = "2%"; $("loadText").textContent = "Reading file";
    try {
      const ab = await file.arrayBuffer();
      $("loadText").textContent = "Decoding audio";
      const buffer = await new Promise((res, rej) => { const p = S.ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
      if (buffer.duration < 5) throw new Error("That clip is under 5 seconds, too short to play.");
      const t0 = performance.now();
      const analysis = await NR.analyzeAudio(buffer, (p, txt) => { $("loadBar").style.width = Math.round(p * 100) + "%"; $("loadText").textContent = txt; });
      const charts = {};
      for (const d of Object.keys(NR.DIFFS)) charts[d] = NR.chartFromAnalysis(analysis, d);
      S.song = { name: file.name, size: file.size, buffer, analysis, charts, analysisMs: Math.round(performance.now() - t0) };
      info(fi, `Loaded ${file.name}: ${fmtTime(buffer.duration)}, ~${Math.round(analysis.bpm)} BPM, ${analysis.onsets.length} onsets detected.`, "ok");
    } catch (e) {
      console.warn("load failed", e);
      info(fi, "Couldn't use that file: " + (e && e.message ? e.message : "your browser can't decode this format") + ". Try mp3, wav, ogg or m4a.", "err");
    }
    show("menu"); updatePlayable();
  }
  $("fileInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; handleFile(f); });
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) { setTab("file"); handleFile(f); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f && $("menu").classList.contains("active")) { setTab("file"); handleFile(f); } });

  // ---------- YouTube mode ----------
  const tap = new NR.TapTempo();
  $("ytBpm").value = settings.ytBpm;
  $("ytBpm").addEventListener("input", () => { settings.ytBpm = parseFloat($("ytBpm").value) || 120; save(); updatePlayable(); });
  $("ytUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") $("ytLoad").click(); });
  $("ytLoad").addEventListener("click", async () => {
    const st = $("ytStatus");
    const parsed = NR.parseYouTube($("ytUrl").value);
    if (!parsed) { info(st, "That doesn't look like a YouTube link or 11-character video ID.", "err"); return; }
    S.yt = { id: parsed.id, start: parsed.start, ready: false, duration: 0 };
    info(st, `Video ID ${parsed.id}. Loading YouTube player…`);
    updatePlayable();
    try {
      const YT = await NR.loadYouTubeApi(10000);
      $("ytPreviewWrap").classList.remove("hidden");
      if (S.previewPlayer) { try { S.previewPlayer.destroy(); } catch (e) {} }
      $("ytPreviewWrap").innerHTML = '<div id="ytPreview"></div>';
      S.previewPlayer = new YT.Player("ytPreview", {
        videoId: parsed.id, playerVars: { playsinline: 1, rel: 0, modestbranding: 1, start: Math.floor(parsed.start) },
        events: {
          onReady: (e) => { S.yt.ready = true; S.yt.duration = e.target.getDuration() || 0; $("ytControls").classList.remove("hidden");
            info(st, `Ready${S.yt.duration ? " · " + fmtTime(S.yt.duration) : ""}. Play it, tap the tempo, then hit PLAY.`, "ok"); updatePlayable(); },
          onError: (e) => { S.yt.ready = false; info(st, NR.ytErrorText(e.data), "err"); updatePlayable(); },
        },
      });
    } catch (e) {
      info(st, e.message || String(e), "err");
      $("ytPreviewWrap").classList.add("hidden");
    }
  });
  function doTap(e) {
    e.preventDefault();
    let vt = null;
    const p = S.previewPlayer;
    try { if (p && p.getPlayerState && p.getPlayerState() === 1) vt = p.getCurrentTime(); } catch (err) {}
    const r = tap.tap(performance.now(), vt);
    if (r.bpm) { $("ytBpm").value = r.bpm.toFixed(1); settings.ytBpm = +r.bpm.toFixed(1); save(); }
    if (r.offset !== null && r.offset !== undefined) $("ytOffset").value = r.offset.toFixed(2);
    $("tapHint").textContent = r.count < 2 ? "Keep tapping on the beat…" : `${r.count} taps → ${r.bpm.toFixed(1)} BPM${r.offset != null ? ", first beat " + r.offset.toFixed(2) + " s" : ""}. Pause 2 s to start over.`;
    updatePlayable();
  }
  $("tapBtn").addEventListener("pointerdown", doTap);
  for (const b of document.querySelectorAll("[data-nudge]")) b.addEventListener("click", () => {
    const v = Math.max(0, (parseFloat($("ytOffset").value) || 0) + parseFloat(b.dataset.nudge)); $("ytOffset").value = v.toFixed(2);
  });

  // ---------- play flow ----------
  function enterGame() {
    show(""); cv.classList.remove("hidden"); $("gameUi").classList.remove("hidden");
    document.body.classList.toggle("narrow", window.innerWidth < 600);
    $("odBtn").classList.toggle("hidden", !game.touchUI);
    game.resize();
  }
  function exitGame() {
    game.stop(); destroyGamePlayer();
    cv.classList.add("hidden"); $("gameUi").classList.add("hidden"); $("pause").classList.add("hidden"); $("tapToStart").classList.add("hidden");
    $("ytGameHost").classList.add("hidden"); game.transparentBg = false;
  }
  function destroyGamePlayer() { if (S.gamePlayer) { try { S.gamePlayer.destroy(); } catch (e) {} S.gamePlayer = null; } }

  function startRun() {
    applySettings();
    if (settings.tab === "file") {
      if (!S.song) return;
      ensureCtx();
      S.chart = S.song.charts[settings.diff];
      S.meta = { title: S.song.name, key: songKey(), diff: settings.diff };
      enterGame();
      const clock = new NR.BufferClock(S.ctx, S.song.buffer, S.gain);
      game.load(S.chart, clock, S.meta);
      game.start(Math.max(2, S.chart.lead / settings.speed + 0.5));
    } else {
      if (!S.yt || !S.yt.ready) return;
      const bpm = parseFloat($("ytBpm").value), offset = parseFloat($("ytOffset").value) || 0;
      const duration = S.yt.duration || 600;
      S.chart = NR.chartFromBpm({ bpm, offset, duration, seed: S.yt.id, diffKey: settings.diff });
      S.meta = { title: "YouTube " + S.yt.id, key: songKey(), diff: settings.diff };
      try { S.previewPlayer && S.previewPlayer.pauseVideo(); } catch (e) {}
      enterGame();
      $("ytGameHost").classList.remove("hidden"); game.transparentBg = true;
      destroyGamePlayer();
      $("ytGameHost").innerHTML = '<div id="ytGame"></div>';
      const YT = window.YT;
      let started = false;
      S.gamePlayer = new YT.Player("ytGame", {
        videoId: S.yt.id, playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, modestbranding: 1, fs: 0, iv_load_policy: 3 },
        events: {
          onReady: (e) => {
            e.target.setVolume(Math.round(settings.volume * 100)); e.target.seekTo(0, true); e.target.playVideo();
            const clock = new NR.YTClock(e.target);
            game.load(S.chart, clock, S.meta); game.start(0);
            setTimeout(() => { if (!started && S.gamePlayer === e.target) $("tapToStart").classList.remove("hidden"); }, 2500);
          },
          onStateChange: (e) => {
            if (e.data === 1) { started = true; $("tapToStart").classList.add("hidden"); }
            if (e.data === 0 && game.clock) game.clock.ended = true;
            if (e.data === 2 && game.state === "playing" && !game.clock.paused) game.pause();
          },
          onError: (e) => { toast(NR.ytErrorText(e.data), 5000); exitGame(); show("menu"); },
        },
      });
    }
  }
  $("tapToStartBtn").addEventListener("click", () => { try { S.gamePlayer.playVideo(); } catch (e) {} $("tapToStart").classList.add("hidden"); });
  $("playBtn").addEventListener("click", startRun);
  $("pauseBtn").addEventListener("pointerdown", (e) => { e.preventDefault(); game.pause(); });
  $("odBtn").addEventListener("pointerdown", (e) => { e.preventDefault(); game.activateOD(); });
  $("resumeBtn").addEventListener("click", () => game.resume());
  $("restartBtn").addEventListener("click", () => { $("pause").classList.add("hidden"); restart(); });
  $("quitBtn").addEventListener("click", () => { exitGame(); show("menu"); updatePlayable(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) game.pause(); });
  function restart() {
    if (settings.tab === "yt" && S.gamePlayer) {
      if (game.state === "paused") { game.state = "playing"; }
      try { S.gamePlayer.seekTo(0, true); S.gamePlayer.playVideo(); } catch (e) {}
      const clock = new NR.YTClock(S.gamePlayer);
      game.load(S.chart, clock, S.meta); game.start(0);
      return;
    }
    exitGame(); startRun();
  }

  // ---------- results ----------
  function showResults(st) {
    S.lastStats = st;
    const key = S.meta.key + "|" + S.meta.diff;
    const all = safeJSON(localStorage.getItem(BKEY));
    const prev = all[key];
    const isBest = !prev || st.score > prev.score;
    if (isBest) { all[key] = { score: st.score, grade: st.grade, acc: st.accuracy }; try { localStorage.setItem(BKEY, JSON.stringify(all)); } catch (e) {} }
    exitGame();
    $("resSong").textContent = `${S.meta.title} · ${NR.DIFFS[S.meta.diff].name}${S.chart.mode === "youtube" ? " · approximate sync" : ""}`;
    $("resGrade").textContent = st.grade;
    $("resStars").textContent = "★".repeat(st.stars) + "☆".repeat(5 - st.stars);
    $("resScore").textContent = st.score.toLocaleString();
    $("resBest").textContent = st.fullCombo ? "FULL COMBO! " : "";
    $("resBest").textContent += isBest ? (prev ? "New best! (was " + prev.score.toLocaleString() + ")" : "First clear, new best!") : "Best: " + prev.score.toLocaleString();
    $("resAcc").textContent = (st.accuracy * 100).toFixed(1) + "%";
    $("resCombo").textContent = st.maxCombo + " / " + st.total;
    $("resPerfect").textContent = st.counts.perfect; $("resGreat").textContent = st.counts.great; $("resGood").textContent = st.counts.good; $("resMiss").textContent = st.counts.miss;
    const md = st.medianDeltaMs;
    $("resTiming").textContent = st.total - st.counts.miss > 4 ? `Median timing ${md > 0 ? "+" : ""}${md} ms (${Math.abs(md) < 15 ? "on point" : md > 0 ? "you tend to hit late; try raising the latency offset" : "you tend to hit early; try lowering the latency offset"}). Early ${st.early} / late ${st.late}.` : "";
    show("results");
    updatePlayable();
  }
  $("retryBtn").addEventListener("click", startRun);
  $("newBtn").addEventListener("click", () => { show("menu"); updatePlayable(); });

  // ---------- latency calibration ----------
  let cal = null;
  $("calibBtn").addEventListener("click", () => { $("calib").classList.remove("hidden"); $("calibText").textContent = "Press Start, then tap on every click."; $("calibApply").disabled = true; });
  $("calibClose").addEventListener("click", () => { $("calib").classList.add("hidden"); cal = null; });
  $("calibStart").addEventListener("click", () => {
    const ctx = ensureCtx();
    const raw = new NR.BufferClock(ctx, null, null);
    const t0 = ctx.currentTime + 1.2, iv = 0.6, clicks = [];
    for (let i = 0; i < 16; i++) {
      const t = t0 + i * iv; clicks.push(t);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = i % 4 === 0 ? 1600 : 1000;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.7 * Math.max(0.2, settings.volume), t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.08);
    }
    cal = { raw, clicks, taps: [] };
    $("calibText").textContent = "Listen… tap on each click";
    $("calibApply").disabled = true;
    const endAt = clicks[clicks.length - 1] + 0.8;
    const check = () => { if (!cal) return; if (ctx.currentTime < endAt) return setTimeout(check, 100); finishCal(); };
    check();
  });
  function calTap(e) {
    if (!cal) return; e.preventDefault();
    cal.taps.push(cal.raw.raw() - Math.max(0, Math.min(0.1, (performance.now() - e.timeStamp) / 1000)));
    $("calibText").textContent = `${cal.taps.length} taps`;
  }
  $("calibTap").addEventListener("pointerdown", calTap);
  window.addEventListener("keydown", (e) => { if (!$("calib").classList.contains("hidden") && (e.code === "Space" || e.code === "Enter")) calTap(e); });
  function finishCal() {
    const d = [];
    for (const t of cal.taps) { let best = 9; for (const c of cal.clicks) if (Math.abs(t - c) < Math.abs(best)) best = t - c; if (Math.abs(best) < 0.3) d.push(best); }
    if (d.length < 6) { $("calibText").textContent = `Only ${d.length} usable taps. Try again.`; cal = null; return; }
    d.sort((a, b) => a - b);
    const med = Math.round(d[d.length >> 1] * 1000);
    const spread = Math.round((d[Math.floor(d.length * 0.75)] - d[Math.floor(d.length * 0.25)]) * 1000);
    cal.result = Math.max(-150, Math.min(350, med));
    $("calibText").textContent = `Measured ${med > 0 ? "+" : ""}${med} ms (spread ±${Math.round(spread / 2)} ms from ${d.length} taps). Apply to set the offset.`;
    $("calibApply").disabled = false;
    const r = cal.result; cal = { result: r, done: true, taps: [], clicks: [] };
  }
  $("calibApply").addEventListener("click", () => { if (cal && cal.result !== undefined) { settings.offsetMs = cal.result; applySettings(); syncSliders(); toast("Latency offset set to " + fOff(settings.offsetMs)); } $("calib").classList.add("hidden"); cal = null; });

  // ---------- PWA ----------
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; $("installBtn").classList.remove("hidden"); });
  $("installBtn").addEventListener("click", async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice.catch(() => {}); deferredPrompt = null; $("installBtn").classList.add("hidden"); });
  window.addEventListener("appinstalled", () => $("installBtn").classList.add("hidden"));
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (isIOS && !standalone) $("iosHint").classList.remove("hidden");
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW registration failed", e)));
  }

  setTab(settings.tab === "yt" ? "yt" : "file");
  setDiff(NR.DIFFS[settings.diff] ? settings.diff : "medium");
})();
