/* Neon Riff - game engine: audio-clock sync, input, judging, scoring and canvas rendering. */
(function () {
  "use strict";
  const NR = (window.NR = window.NR || {});
  const LANE_COLORS = ["#39ff14", "#ff2d55", "#ffe600", "#00b3ff", "#ff8a00"];
  const KEYS = { 3: ["KeyD", "KeyF", "KeyJ"], 4: ["KeyD", "KeyF", "KeyJ", "KeyK"], 5: ["KeyD", "KeyF", "KeyJ", "KeyK", "KeyL"] };
  NR.LANE_COLORS = LANE_COLORS; NR.KEYS = KEYS;
  const WIN = { perfect: 0.045, great: 0.09, good: 0.14 };
  const POINTS = { perfect: 100, great: 70, good: 40 };
  const WEIGHT = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };
  const JCOL = { perfect: "#7dfcff", great: "#7dff8a", good: "#ffd45a", miss: "#ff4060" };

  /** Clock over a decoded AudioBuffer. Time 0 = start of the song; negative during lead-in. */
  NR.BufferClock = class {
    constructor(ctx, buffer, dest) {
      this.ctx = ctx; this.buffer = buffer; this.dest = dest; this.kind = "file";
      const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
      this.useTs = !!(ts && ts.contextTime > 0 && ts.performanceTime > 0);
    }
    raw() {
      const ct = this.ctx.currentTime;
      if (this.useTs) {
        const ts = this.ctx.getOutputTimestamp();
        if (ts.contextTime > 0 && ts.performanceTime > 0) return Math.min(ct, ts.contextTime + (performance.now() - ts.performanceTime) / 1000);
      }
      return ct;
    }
    start(leadIn) {
      this.stop();
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer; src.connect(this.dest);
      this.t0 = this.ctx.currentTime + leadIn;
      src.start(this.t0);
      this.src = src; this.ended = false; this.last = -Infinity;
      src.onended = () => { if (this.src === src) this.ended = true; };
      if (this.ctx.state !== "running") this.ctx.resume();
    }
    now() { let t = this.raw() - this.t0; if (t < this.last) t = this.last; this.last = t; return t; }
    pause() { return this.ctx.suspend(); }
    resume() { this.last = -Infinity; return this.ctx.resume(); }
    stop() { if (this.src) { const s = this.src; this.src = null; try { s.onended = null; s.stop(); } catch (e) {} s.disconnect(); } }
    isEnded() { return this.ended; }
  };

  function makeGem(color, star, S) {
    const c = document.createElement("canvas"); c.width = c.height = S;
    const g = c.getContext("2d"), m = S / 2;
    const glow = g.createRadialGradient(m, m, S * 0.1, m, m, m);
    glow.addColorStop(0, star ? "rgba(255,255,255,0.9)" : color); glow.addColorStop(0.45, star ? "rgba(120,230,255,0.35)" : color + "55"); glow.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = glow; g.fillRect(0, 0, S, S);
    g.save(); g.translate(m, m); g.scale(1, 0.55);
    const body = g.createRadialGradient(-S * 0.08, -S * 0.1, S * 0.02, 0, 0, S * 0.3);
    body.addColorStop(0, "#ffffff"); body.addColorStop(0.35, star ? "#bff6ff" : color); body.addColorStop(1, star ? "#2fb7ff" : shade(color));
    g.fillStyle = body; g.beginPath(); g.arc(0, 0, S * 0.3, 0, Math.PI * 2); g.fill();
    g.lineWidth = S * 0.035; g.strokeStyle = star ? color : "rgba(255,255,255,0.85)"; g.stroke();
    g.restore();
    if (star) { g.fillStyle = "#fff"; drawStar(g, m, m, S * 0.1, S * 0.045); }
    return c;
  }
  function shade(hex) { const n = parseInt(hex.slice(1), 16); const r = (n >> 16) * 0.35, gg = ((n >> 8) & 255) * 0.35, b = (n & 255) * 0.35; return `rgb(${r | 0},${gg | 0},${b | 0})`; }
  function drawStar(g, x, y, R, r) { g.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r : R; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } g.closePath(); g.fill(); }

  NR.Game = class {
    constructor(canvas, hooks) {
      this.cv = canvas; this.g = canvas.getContext("2d");
      this.hooks = hooks || {};
      this.settings = { offsetMs: 0, speed: 1, showDelta: true };
      this.state = "idle";
      this.particles = []; this.keys = []; this.pointerLane = new Map();
      this.gemCache = {}; this.flash = { a: 0, color: "#fff" }; this.popups = [];
      this.fps = { n: 0, t: 0, v: 0 };
      this._resize = () => this.resize(); window.addEventListener("resize", this._resize);
      this._loop = (ts) => this.frame(ts);
      this._bindInput();
      this.resize();
    }

    resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = this.cv.clientWidth || window.innerWidth, h = this.cv.clientHeight || window.innerHeight;
      this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
      this.W = w; this.H = h; this.dpr = dpr;
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.layout(); this.bg = null;
    }
    layout() {
      const W = this.W, H = this.H, lanes = (this.chart && this.chart.lanes) || 4;
      const bw = Math.min(W * 0.96, H * 0.62, 120 * lanes + 40);
      this.geo = { cx: W / 2, fretY: H * (W < 600 ? 0.8 : 0.83), topY: H * 0.1, bw, tw: bw * 0.26, lanes, laneW: bw / lanes };
      this.geo.k = this.geo.bw / this.geo.tw - 1;
      this.geo.norm = 1 - 1 / (1 + this.geo.k);
      this.gemSize = Math.round(this.geo.laneW * 1.15 * this.dpr);
      this.gemCache = {};
    }
    // z: 0 at fret, 1 at horizon, negative below the fret.
    proj(z, laneF) {
      const G = this.geo; const s = 1 / (1 + Math.max(-0.6, z) * G.k);
      const y = G.fretY - (G.fretY - G.topY) * (1 - s) / G.norm;
      return { x: G.cx + (laneF - (G.lanes - 1) / 2) * G.laneW * s, y, s };
    }
    gem(lane, star) {
      const key = lane + (star ? "s" : "");
      return this.gemCache[key] || (this.gemCache[key] = makeGem(LANE_COLORS[lane], star, this.gemSize));
    }

    /** Begin a run. chart: from NR.chart*, clock: BufferClock / YTClock. */
    load(chart, clock, meta) {
      this.chart = chart; this.clock = clock; this.meta = meta || {};
      for (const n of chart.notes) { n.judged = null; n.dt = 0; }
      this.layout();
      this.head = 0; this.drawHead = 0;
      const win = chart.mode === "youtube" ? 1.4 : 1;
      this.win = { perfect: WIN.perfect * win, great: WIN.great * win, good: WIN.good * win };
      this.score = 0; this.combo = 0; this.maxCombo = 0; this.mult = 1; this.accSum = 0; this.judgedCount = 0;
      this.counts = { perfect: 0, great: 0, good: 0, miss: 0 }; this.early = 0; this.late = 0; this.deltas = [];
      this.od = 0; this.odActive = false; this.phraseBroken = new Set(); this.phraseHits = {};
      this.particles.length = 0; this.popups.length = 0; this.judgeText = null; this.keys = new Array(chart.lanes).fill(0);
      this.nudge = 0; this.lastNow = -10; this.finished = false;
      this.phraseSize = {};
      for (const n of chart.notes) if (n.star) this.phraseSize[n.phrase] = (this.phraseSize[n.phrase] || 0) + 1;
    }
    start(leadIn) {
      this.state = "playing";
      if (this.clock.start) this.clock.start(leadIn);
      if (!this.raf) this.raf = requestAnimationFrame(this._loop);
    }
    pause() {
      if (this.state !== "playing") return;
      this.state = "paused"; this.clock.pause();
      this.keys.fill(0);
      this.hooks.onPause && this.hooks.onPause();
    }
    resume() {
      if (this.state !== "paused") return;
      this.state = "playing"; this.clock.resume();
      this.hooks.onResume && this.hooks.onResume();
    }
    stop() {
      this.state = "idle";
      if (this.clock) this.clock.stop();
      if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0;
    }
    gameTime() { return this.clock.now() - this.settings.offsetMs / 1000 - this.nudge; }

    _bindInput() {
      window.addEventListener("keydown", (e) => {
        if (this.state === "idle" || this.hooks.isModalOpen && this.hooks.isModalOpen()) return;
        if (e.code === "Escape" || e.code === "KeyP") { e.preventDefault(); this.state === "playing" ? this.pause() : this.state === "paused" && this.hooks.requestResume ? this.hooks.requestResume() : this.resume(); return; }
        if (this.state !== "playing") return;
        if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); this.activateOD(); return; }
        if (this.chart.mode === "youtube" && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
          e.preventDefault(); this.nudge += e.code === "ArrowLeft" ? -0.01 : 0.01; this.popup((this.nudge >= 0 ? "+" : "") + Math.round(this.nudge * 1000) + " ms sync", "#9ad"); return;
        }
        const lane = KEYS[this.chart.lanes].indexOf(e.code);
        if (lane < 0 || e.repeat) return;
        e.preventDefault();
        this.press(lane, e.timeStamp);
      });
      window.addEventListener("keyup", (e) => {
        if (!this.chart) return;
        const lane = KEYS[this.chart.lanes].indexOf(e.code);
        if (lane >= 0) this.keys[lane] = 0;
      });
      const laneAt = (x) => {
        const G = this.geo; const f = (x - (G.cx - G.bw / 2)) / G.laneW;
        return Math.max(0, Math.min(G.lanes - 1, Math.floor(f)));
      };
      this.cv.addEventListener("pointerdown", (e) => {
        if (this.state !== "playing") return;
        e.preventDefault();
        const r = this.cv.getBoundingClientRect();
        const lane = laneAt(e.clientX - r.left);
        this.pointerLane.set(e.pointerId, lane);
        this.press(lane, e.timeStamp);
      });
      const up = (e) => { const l = this.pointerLane.get(e.pointerId); if (l !== undefined) { this.keys[l] = 0; this.pointerLane.delete(e.pointerId); } };
      this.cv.addEventListener("pointerup", up); this.cv.addEventListener("pointercancel", up);
    }

    press(lane, evTs) {
      this.keys[lane] = 1;
      let t = this.gameTime();
      if (typeof evTs === "number" && evTs > 0) t -= Math.max(0, Math.min(0.1, (performance.now() - evTs) / 1000));
      const notes = this.chart.notes, W = this.win;
      let best = null, bd = Infinity;
      for (let i = this.head; i < notes.length; i++) {
        const n = notes[i];
        if (n.t - t > W.good) break;
        if (n.judged || n.lane !== lane) continue;
        const d = Math.abs(t - n.t);
        if (d <= W.good && d < bd) { bd = d; best = n; }
      }
      if (best) this.judge(best, t - best.t);
      else this.hooks.onGhost && this.hooks.onGhost(lane);
    }

    judge(n, dt) {
      const W = this.win, a = Math.abs(dt);
      const j = a <= W.perfect ? "perfect" : a <= W.great ? "great" : "good";
      n.judged = j; n.dt = dt;
      this.counts[j]++; this.judgedCount++; this.accSum += WEIGHT[j];
      this.deltas.push(dt); if (j !== "perfect") { if (dt < 0) this.early++; else this.late++; }
      this.combo++; if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      const nm = Math.min(4, 1 + Math.floor(this.combo / 10));
      if (nm > this.mult) { this.flashScreen(0.18, "#ff4fd8"); this.popup("x" + nm + " MULTIPLIER", "#ff7ae6"); }
      this.mult = nm;
      this.score += POINTS[j] * this.mult * (this.odActive ? 2 : 1);
      if (this.combo % 50 === 0) { this.flashScreen(0.35, "#7dfcff"); this.popup(this.combo + " NOTE STREAK!", "#7dfcff", 1.4); }
      if (n.star && !this.phraseBroken.has(n.phrase)) {
        this.phraseHits[n.phrase] = (this.phraseHits[n.phrase] || 0) + 1;
        if (this.phraseHits[n.phrase] === this.phraseSize[n.phrase]) { this.od = Math.min(1, this.od + 0.25); this.popup("OVERDRIVE +25%", "#8ff"); this.flashScreen(0.2, "#6ef"); }
      }
      this.judgeText = { j, dt, t: performance.now() };
      const p = this.proj(0, n.lane);
      this.burst(p.x, p.y, n.star ? "#bff6ff" : LANE_COLORS[n.lane], j === "perfect" ? 26 : 16);
      this.hooks.onJudge && this.hooks.onJudge(j, dt, n);
    }
    miss(n) {
      n.judged = "miss"; this.counts.miss++; this.judgedCount++;
      if (this.combo >= 20) this.flashScreen(0.15, "#ff2040");
      this.combo = 0; this.mult = 1;
      if (n.star) this.phraseBroken.add(n.phrase);
      this.judgeText = { j: "miss", dt: 0, t: performance.now() };
      this.hooks.onJudge && this.hooks.onJudge("miss", 0, n);
    }
    activateOD() {
      if (this.odActive || this.od < 0.5) return false;
      this.odActive = true; this.flashScreen(0.45, "#4ef"); this.popup("OVERDRIVE! x2", "#6ff", 1.5);
      return true;
    }
    flashScreen(a, color) { this.flash.a = Math.max(this.flash.a, a); this.flash.color = color; }
    popup(text, color, size) { this.popups.push({ text, color, size: size || 1, t: performance.now() }); if (this.popups.length > 4) this.popups.shift(); }
    burst(x, y, color, n) {
      for (let i = 0; i < n; i++) {
        if (this.particles.length > 500) this.particles.shift();
        const a = -Math.PI * Math.random(), s = 120 + Math.random() * 380;
        this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.35 + Math.random() * 0.4, color, size: 1.5 + Math.random() * 3 });
      }
    }

    stats() {
      const total = this.chart.notes.length || 1;
      const acc = this.accSum / total;
      const grade = acc >= 0.97 ? "S" : acc >= 0.9 ? "A" : acc >= 0.8 ? "B" : acc >= 0.7 ? "C" : acc >= 0.55 ? "D" : "F";
      const stars = acc >= 0.97 ? 5 : acc >= 0.9 ? 4 : acc >= 0.8 ? 3 : acc >= 0.65 ? 2 : acc >= 0.45 ? 1 : 0;
      const sorted = this.deltas.slice().sort((a, b) => a - b);
      const median = sorted.length ? sorted[sorted.length >> 1] : 0;
      return { score: this.score, accuracy: acc, maxCombo: this.maxCombo, counts: Object.assign({}, this.counts), total: this.chart.notes.length,
        grade, stars, early: this.early, late: this.late, medianDeltaMs: Math.round(median * 1000), fullCombo: this.counts.miss === 0 && this.judgedCount === this.chart.notes.length };
    }

    frame(ts) {
      this.raf = requestAnimationFrame(this._loop);
      const dtR = this._lastTs ? Math.min(0.05, (ts - this._lastTs) / 1000) : 0.016; this._lastTs = ts;
      this.fps.n++; if (ts - this.fps.t > 1000) { this.fps.v = this.fps.n; this.fps.n = 0; this.fps.t = ts; }
      if (this.state === "idle" || !this.chart) return;
      const now = this.state === "playing" ? this.gameTime() : this.lastNow;
      const dt = this.state === "playing" ? Math.max(0, Math.min(0.05, now - this.lastNow)) : 0;
      this.lastNow = now;
      if (this.state === "playing") {
        const notes = this.chart.notes;
        for (let i = this.head; i < notes.length; i++) {
          const n = notes[i];
          if (n.t > now - this.win.good) break;
          if (!n.judged) this.miss(n);
        }
        while (this.head < notes.length && notes[this.head].judged) this.head++;
        if (this.odActive) { this.od -= dt / 8; if (this.od <= 0) { this.od = 0; this.odActive = false; } }
        const lastT = notes.length ? notes[notes.length - 1].t : 0;
        const ytEnded = this.clock.kind === "youtube" && this.clock.isEnded();
        if (ytEnded) for (let i = this.head; i < notes.length; i++) if (!notes[i].judged) this.miss(notes[i]);
        if (ytEnded) this.head = notes.length;
        if (!this.finished && (ytEnded || this.clock.isEnded() || now > Math.max(lastT + 2.5, this.chart.duration + 0.3)) && this.head >= notes.length) {
          this.finished = true; this.state = "ended";
          setTimeout(() => this.hooks.onEnd && this.hooks.onEnd(this.stats()), 600);
        }
      }
      this.render(now, this.state === "paused" ? 0 : dtR);
    }

    render(now, dt) {
      const g = this.g, W = this.W, H = this.H, G = this.geo, ch = this.chart;
      const lead = ch.lead / this.settings.speed;
      // Background (cached) + beat pulse
      if (!this.bg) this.bg = this.makeBg();
      g.globalCompositeOperation = "source-over";
      if (this.transparentBg) g.clearRect(0, 0, W, H); else g.drawImage(this.bg, 0, 0, W, H);
      if (this.transparentBg) { g.globalAlpha = 0.55; g.drawImage(this.bg, 0, 0, W, H); g.globalAlpha = 1; }
      const beatLen = 60 / (ch.bpm || 120);
      const bp = ch.beats && ch.beats.length ? ((now - ch.beats[0]) / beatLen) : now / beatLen;
      const pulse = Math.pow(1 - (((bp % 1) + 1) % 1), 3);
      // Highway
      const tl = this.proj(1, -0.5), tr = this.proj(1, G.lanes - 0.5), bl = this.proj(-0.35, -0.5), br = this.proj(-0.35, G.lanes - 0.5);
      const hw = g.createLinearGradient(0, G.topY, 0, H);
      hw.addColorStop(0, "rgba(20,6,40,0.2)"); hw.addColorStop(0.6, this.odActive ? "rgba(10,60,90,0.85)" : "rgba(28,8,58,0.85)"); hw.addColorStop(1, this.odActive ? "rgba(20,90,130,0.95)" : "rgba(40,10,80,0.95)");
      g.fillStyle = hw; g.beginPath(); g.moveTo(tl.x, tl.y); g.lineTo(tr.x, tr.y); g.lineTo(br.x, br.y); g.lineTo(bl.x, bl.y); g.closePath(); g.fill();
      // lane tint when pressed
      for (let l = 0; l < G.lanes; l++) {
        if (!this.keys[l]) continue;
        const a = this.proj(1, l - 0.5), b = this.proj(1, l + 0.5), c = this.proj(-0.35, l + 0.5), d = this.proj(-0.35, l - 0.5);
        const lg = g.createLinearGradient(0, G.topY, 0, G.fretY); lg.addColorStop(0, "rgba(0,0,0,0)"); lg.addColorStop(1, LANE_COLORS[l] + "40");
        g.fillStyle = lg; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(c.x, c.y); g.lineTo(d.x, d.y); g.fill();
      }
      // beat lines
      if (ch.beats) {
        g.lineWidth = 1;
        const first = Math.max(0, Math.floor((now - 0.3 - ch.beats[0]) / beatLen) - 1);
        for (let i = first; i < ch.beats.length; i++) {
          const z = (ch.beats[i] - now) / lead;
          if (z > 1) break; if (z < -0.3) continue;
          const a = this.proj(z, -0.5), b = this.proj(z, G.lanes - 0.5);
          g.strokeStyle = `rgba(190,150,255,${(i % 4 === 0 ? 0.45 : 0.16) * (1 - z * 0.7)})`; g.lineWidth = i % 4 === 0 ? 2 : 1;
          g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
        }
      }
      // lane dividers + glowing rails
      for (let l = 0; l <= G.lanes; l++) {
        const a = this.proj(1, l - 0.5), b = this.proj(-0.35, l - 0.5);
        const rail = l === 0 || l === G.lanes;
        g.strokeStyle = rail ? (this.odActive ? "#4ef" : "#ff3cdc") : "rgba(140,110,255,0.35)";
        g.lineWidth = rail ? 3 + pulse * 2 : 1;
        if (rail) { g.shadowColor = g.strokeStyle; g.shadowBlur = 14 + pulse * 10; }
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
        g.shadowBlur = 0;
      }
      // fret line + buttons
      const fl = this.proj(0, -0.5), fr = this.proj(0, G.lanes - 0.5);
      g.strokeStyle = "rgba(255,255,255,0.85)"; g.lineWidth = 3; g.shadowColor = "#fff"; g.shadowBlur = 10;
      g.beginPath(); g.moveTo(fl.x, fl.y); g.lineTo(fr.x, fr.y); g.stroke(); g.shadowBlur = 0;
      const keyLabels = KEYS[G.lanes].map((k) => k.slice(3));
      for (let l = 0; l < G.lanes; l++) {
        const p = this.proj(0, l), r = G.laneW * 0.36;
        g.save(); g.translate(p.x, p.y); g.scale(1, 0.55);
        g.lineWidth = 5; g.strokeStyle = LANE_COLORS[l];
        g.shadowColor = LANE_COLORS[l]; g.shadowBlur = this.keys[l] ? 30 : 10;
        g.fillStyle = this.keys[l] ? LANE_COLORS[l] + "cc" : "rgba(10,5,20,0.7)";
        g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill(); g.stroke();
        g.restore();
        g.fillStyle = "rgba(255,255,255,0.55)"; g.font = `600 ${Math.max(11, G.laneW * 0.16)}px system-ui,sans-serif`; g.textAlign = "center";
        if (!this.touchUI) g.fillText(keyLabels[l], p.x, p.y + G.laneW * 0.42);
      }
      // notes
      const notes = ch.notes;
      while (this.drawHead < notes.length && notes[this.drawHead].t < now - 0.6) this.drawHead++;
      g.globalCompositeOperation = "lighter";
      const toDraw = [];
      for (let i = this.drawHead; i < notes.length; i++) {
        const n = notes[i]; const z = (n.t - now) / lead;
        if (z > 1.02) break;
        if (n.judged && n.judged !== "miss") continue;
        if (z < -0.32) continue;
        toDraw.push(n);
      }
      for (let i = toDraw.length - 1; i >= 0; i--) {
        const n = toDraw[i]; const z = (n.t - now) / lead; const p = this.proj(z, n.lane);
        const sz = (this.gemSize / this.dpr) * p.s;
        g.globalAlpha = n.judged === "miss" ? 0.3 : Math.min(1, (1.02 - z) * 4);
        g.drawImage(this.gem(n.lane, n.star || this.odActive), p.x - sz / 2, p.y - sz / 2, sz, sz);
      }
      g.globalAlpha = 1;
      // particles
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const q = this.particles[i]; q.life += dt;
        if (q.life > q.max) { this.particles.splice(i, 1); continue; }
        q.vy += 900 * dt; q.x += q.vx * dt; q.y += q.vy * dt;
        g.globalAlpha = 1 - q.life / q.max; g.fillStyle = q.color;
        g.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
      }
      g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
      this.drawHud(now);
      if (this.flash.a > 0.005) {
        g.globalCompositeOperation = "lighter"; g.globalAlpha = this.flash.a; g.fillStyle = this.flash.color; g.fillRect(0, 0, W, H);
        g.globalAlpha = 1; g.globalCompositeOperation = "source-over"; this.flash.a *= Math.pow(0.02, dt || 0.016);
      }
      // lead-in countdown
      if (now < 0 && this.state === "playing") {
        g.fillStyle = "rgba(255,255,255,0.9)"; g.font = `800 ${Math.min(W, H) * 0.14}px system-ui,sans-serif`; g.textAlign = "center";
        g.fillText(String(Math.ceil(-now)), W / 2, H * 0.42);
      }
    }

    drawHud(now) {
      const g = this.g, W = this.W, H = this.H, G = this.geo, ch = this.chart;
      const small = W < 600, pad = small ? 12 : 22;
      g.textAlign = "left"; g.textBaseline = "alphabetic";
      // progress bar
      const prog = Math.max(0, Math.min(1, now / (ch.duration || 1)));
      g.fillStyle = "rgba(255,255,255,0.12)"; g.fillRect(0, 0, W, 4);
      const pg = g.createLinearGradient(0, 0, W, 0); pg.addColorStop(0, "#ff3cdc"); pg.addColorStop(1, "#4ef");
      g.fillStyle = pg; g.fillRect(0, 0, W * prog, 4);
      const topPad = pad + (this.safeTop || 0);
      g.fillStyle = "#fff"; g.font = `800 ${small ? 24 : 34}px system-ui,sans-serif`;
      g.shadowColor = "#ff3cdc"; g.shadowBlur = 12;
      g.fillText(this.score.toLocaleString(), pad, topPad + (small ? 24 : 34));
      g.shadowBlur = 0;
      const acc = this.judgedCount ? (this.accSum / this.judgedCount) * 100 : 100;
      g.font = `600 ${small ? 12 : 15}px system-ui,sans-serif`; g.fillStyle = "rgba(220,210,255,0.8)";
      g.fillText(`${acc.toFixed(1)}%  ·  ${NR.DIFFS[ch.diff].name}${ch.mode === "youtube" ? "  ·  APPROX SYNC" : ""}`, pad, topPad + (small ? 42 : 58));
      if (ch.mode === "youtube") { g.fillStyle = "rgba(160,200,255,0.7)"; g.fillText(`←/→ nudge sync: ${(this.nudge >= 0 ? "+" : "") + Math.round(this.nudge * 1000)} ms`, pad, topPad + (small ? 58 : 78)); }
      // overdrive meter
      const ow = small ? 110 : 170, oy = topPad + (small ? 66 : 90);
      g.fillStyle = "rgba(255,255,255,0.12)"; g.fillRect(pad, oy, ow, 8);
      g.fillStyle = this.odActive ? "#4ef" : this.od >= 0.5 ? "#9ff" : "#3a8aa8"; g.fillRect(pad, oy, ow * this.od, 8);
      g.fillStyle = "rgba(255,255,255,0.5)"; g.fillRect(pad + ow * 0.5 - 1, oy - 2, 2, 12);
      g.font = `600 ${small ? 10 : 12}px system-ui,sans-serif`; g.fillStyle = this.od >= 0.5 && !this.odActive ? "#9ff" : "rgba(200,220,255,0.6)";
      g.fillText(this.odActive ? "OVERDRIVE ACTIVE" : this.od >= 0.5 ? (this.touchUI ? "OVERDRIVE READY: tap ⚡" : "OVERDRIVE READY: SPACE") : "OVERDRIVE", pad, oy + 22);
      // multiplier ring + combo (right of highway, or top-right on narrow screens)
      const mx = small ? W - 44 : Math.min(W - 70, G.cx + G.bw / 2 + 80), my = small ? topPad + 34 : G.fretY - 60;
      const ring = this.mult >= 4 ? 1 : (this.combo % 10) / 10;
      g.lineWidth = 6; g.strokeStyle = "rgba(255,255,255,0.12)"; g.beginPath(); g.arc(mx, my, small ? 26 : 38, 0, Math.PI * 2); g.stroke();
      const mc = ["#fff", "#ffe600", "#39ff14", "#ff3cdc"][this.mult - 1];
      g.strokeStyle = mc; g.shadowColor = mc; g.shadowBlur = 14;
      g.beginPath(); g.arc(mx, my, small ? 26 : 38, -Math.PI / 2, -Math.PI / 2 + ring * Math.PI * 2); g.stroke(); g.shadowBlur = 0;
      g.fillStyle = mc; g.textAlign = "center"; g.font = `900 ${small ? 20 : 30}px system-ui,sans-serif`; g.fillText("x" + (this.mult * (this.odActive ? 2 : 1)), mx, my + (small ? 7 : 10));
      if (this.combo >= 5) {
        g.fillStyle = "#fff"; g.font = `800 ${small ? 16 : 22}px system-ui,sans-serif`;
        g.fillText(this.combo + " combo", mx, my + (small ? 50 : 70));
      }
      // judgement
      const jt = this.judgeText;
      if (jt) {
        const age = (performance.now() - jt.t) / 1000;
        if (age < 0.6) {
          const s = 1 + 0.25 * Math.max(0, 1 - age * 8);
          g.globalAlpha = Math.min(1, (0.6 - age) * 4);
          g.fillStyle = JCOL[jt.j]; g.shadowColor = JCOL[jt.j]; g.shadowBlur = 16;
          g.font = `900 ${Math.round((small ? 26 : 34) * s)}px system-ui,sans-serif`; g.textAlign = "center";
          g.fillText(jt.j.toUpperCase(), G.cx, G.fretY - G.laneW * 1.3);
          g.shadowBlur = 0;
          if (this.settings.showDelta && jt.j !== "miss" && jt.j !== "perfect") {
            g.font = `600 ${small ? 12 : 14}px system-ui,sans-serif`; g.fillStyle = "rgba(255,255,255,0.8)";
            const ms = Math.round(jt.dt * 1000);
            g.fillText(`${ms < 0 ? "EARLY" : "LATE"} ${Math.abs(ms)} ms`, G.cx, G.fretY - G.laneW * 1.3 + (small ? 18 : 22));
          }
          g.globalAlpha = 1;
        }
      }
      // popups
      for (let i = this.popups.length - 1; i >= 0; i--) {
        const p = this.popups[i]; const age = (performance.now() - p.t) / 1000;
        if (age > 1.3) { this.popups.splice(i, 1); continue; }
        g.globalAlpha = Math.min(1, (1.3 - age) * 3);
        g.fillStyle = p.color; g.shadowColor = p.color; g.shadowBlur = 18; g.textAlign = "center";
        g.font = `900 ${Math.round((small ? 20 : 28) * p.size)}px system-ui,sans-serif`;
        g.fillText(p.text, G.cx, H * 0.32 - age * 40 - i * 4);
        g.shadowBlur = 0; g.globalAlpha = 1;
      }
    }

    makeBg() {
      const c = document.createElement("canvas"); c.width = Math.max(1, this.W); c.height = Math.max(1, this.H);
      const g = c.getContext("2d");
      const gr = g.createLinearGradient(0, 0, 0, this.H); gr.addColorStop(0, "#07020f"); gr.addColorStop(0.55, "#140528"); gr.addColorStop(1, "#05010a");
      g.fillStyle = gr; g.fillRect(0, 0, this.W, this.H);
      const rg = g.createRadialGradient(this.W / 2, this.geo.topY, 10, this.W / 2, this.geo.topY, this.H * 0.7);
      rg.addColorStop(0, "rgba(255,60,220,0.25)"); rg.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = rg; g.fillRect(0, 0, this.W, this.H);
      for (let i = 0; i < 140; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.6})`; const s = Math.random() * 1.6; g.fillRect(Math.random() * this.W, Math.random() * this.H * 0.8, s, s); }
      return c;
    }
  };
})();
