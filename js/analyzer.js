/* Neon Riff - audio analysis: spectral-flux onset detection, tempo estimation,
   dynamic-programming beat tracking and a 16th-note grid. Pure JS, no deps. */
(function () {
  "use strict";
  const NR = (window.NR = window.NR || {});

  function makeFFT(n) {
    const levels = Math.round(Math.log2(n));
    const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r = (r << 1) | ((i >>> b) & 1); rev[i] = r; }
    return function fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cos[k] + im[l] * sin[k];
            const tim = -re[l] * sin[k] + im[l] * cos[k];
            re[l] = re[j] - tre; im[l] = im[j] - tim; re[j] += tre; im[j] += tim;
          }
        }
      }
    };
  }

  const yieldUI = () => new Promise((r) => setTimeout(r, 0));
  const BAND_EDGES = [30, 150, 400, 1200, 3500, 10000]; // 5 bands, low -> high
  NR.NUM_BANDS = BAND_EDGES.length - 1;

  function prefix(arr) { const p = new Float64Array(arr.length + 1); for (let i = 0; i < arr.length; i++) p[i + 1] = p[i] + arr[i]; return p; }
  function winMean(p, a, b) { a = Math.max(0, a); b = Math.min(p.length - 1, b); return b > a ? (p[b] - p[a]) / (b - a) : 0; }
  function percentile(arr, q) { const s = Array.from(arr).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; }

  /**
   * Analyse an AudioBuffer. Returns { duration, bpm, beats[], slots[], onsets[], fps }.
   * slots = 16th-note grid points: { t, pos (0..3 within beat), beat, strength, bands[] }.
   */
  NR.analyzeAudio = async function (buffer, onProgress) {
    const progress = onProgress || (() => {});
    const sr0 = buffer.sampleRate, chs = buffer.numberOfChannels;
    const ds = Math.max(1, Math.floor(sr0 / 22050));
    const sr = sr0 / ds;
    const n = Math.floor(buffer.length / ds);
    const mono = new Float32Array(n);
    for (let c = 0; c < chs; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0, j = 0; i < n; i++) { let s = 0; for (let k = 0; k < ds; k++) s += d[j++]; mono[i] += s; }
    }
    const norm = 1 / (chs * ds);
    for (let i = 0; i < n; i++) mono[i] *= norm;
    progress(0.05, "Mixing down");
    await yieldUI();

    const N = 1024, hop = Math.max(1, Math.round(sr / 100)), fps = sr / hop;
    const frames = Math.max(1, Math.floor((n - N) / hop) + 1);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    const NB = NR.NUM_BANDS, half = N / 2;
    const bandOf = new Int8Array(half).fill(-1);
    for (let k = 1; k < half; k++) {
      const f = (k * sr) / N;
      for (let b = 0; b < NB; b++) if (f >= BAND_EDGES[b] && f < BAND_EDGES[b + 1]) bandOf[k] = b;
    }
    const fft = makeFFT(N);
    const re = new Float32Array(N), im = new Float32Array(N);
    let prev = new Float32Array(half), cur = new Float32Array(half);
    const flux = new Float32Array(frames);
    const bandFlux = new Float32Array(frames * NB);
    const rms = new Float32Array(frames);

    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      let e = 0;
      for (let i = 0; i < N; i++) { const s = off + i < n ? mono[off + i] : 0; re[i] = s * win[i]; im[i] = 0; e += s * s; }
      rms[f] = Math.sqrt(e / N);
      fft(re, im);
      let tot = 0;
      for (let k = 1; k < half; k++) {
        const l = Math.log1p(2 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
        cur[k] = l;
        const b = bandOf[k];
        if (b >= 0 && f > 0) {
          const dlt = l - prev[k];
          if (dlt > 0) { bandFlux[f * NB + b] += dlt; tot += dlt; }
        }
      }
      flux[f] = tot;
      const t = prev; prev = cur; cur = t;
      if ((f & 511) === 511) { progress(0.05 + 0.7 * (f / frames), "Scanning spectrum"); await yieldUI(); }
    }
    progress(0.76, "Detecting onsets");
    await yieldUI();

    // Per-band normalisation so the lane mapping compares *relative* band activity.
    const bandMean = new Float64Array(NB);
    for (let f = 0; f < frames; f++) for (let b = 0; b < NB; b++) bandMean[b] += bandFlux[f * NB + b];
    for (let b = 0; b < NB; b++) bandMean[b] = bandMean[b] / frames + 1e-9;

    // Onset envelope: light smoothing, robust normalisation.
    const env = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      const a = flux[Math.max(0, f - 1)], c = flux[Math.min(frames - 1, f + 1)];
      env[f] = 0.25 * a + 0.5 * flux[f] + 0.25 * c;
    }
    const p99 = percentile(env, 0.995) || 1;
    for (let f = 0; f < frames; f++) env[f] = Math.min(1.5, env[f] / p99);

    // Adaptive threshold peak picking.
    const P = prefix(env);
    const wS = Math.round(0.1 * fps), wL = Math.round(1.0 * fps), wMax = 3;
    const minIOI = Math.round(0.05 * fps);
    const silence = percentile(rms, 0.1) * 1.5 + 1e-4;
    const onsets = [];
    let lastOn = -1e9;
    for (let f = 1; f < frames - 1; f++) {
      const v = env[f];
      let isMax = true;
      for (let k = Math.max(0, f - wMax); k <= Math.min(frames - 1, f + wMax); k++) if (env[k] > v) { isMax = false; break; }
      if (!isMax) continue;
      const th = 0.05 + Math.max(1.2 * winMean(P, f - wS, f + Math.round(wS / 2)), 1.0 * winMean(P, f - wL, f + wL));
      if (v < th || rms[f] < silence * 0.5) continue;
      if (f - lastOn < minIOI) { // keep the stronger of two close peaks
        const last = onsets[onsets.length - 1];
        if (last && v - th > last.strength) onsets.pop(); else continue;
      }
      const bands = new Array(NB);
      for (let b = 0; b < NB; b++) {
        let m = 0;
        for (let k = Math.max(0, f - 1); k <= Math.min(frames - 1, f + 1); k++) m = Math.max(m, bandFlux[k * NB + b]);
        bands[b] = m / bandMean[b];
      }
      onsets.push({ frame: f, t: (f * hop + N / 2) / sr - NR.ONSET_BIAS, strength: v - th, level: v, bands });
      lastOn = f;
    }
    progress(0.82, "Estimating tempo");
    await yieldUI();

    // Tempo: autocorrelation of the high-passed onset envelope with a log-normal prior around 120 BPM.
    const hp = new Float32Array(frames);
    for (let f = 0; f < frames; f++) hp[f] = Math.max(0, env[f] - winMean(P, f - wL, f + wL));
    const Lmin = Math.max(2, Math.floor((fps * 60) / 200)), Lmax = Math.ceil((fps * 60) / 60);
    const ac = new Float64Array(2 * Lmax + 2);
    const M = Math.min(frames, Math.round(fps * 150));
    for (let L = 1; L < ac.length; L++) {
      let s = 0;
      for (let i = 0; i + L < M; i++) s += hp[i] * hp[i + L];
      ac[L] = s / Math.max(1, M - L);
    }
    let bestL = Math.round((fps * 60) / 120), bestS = -1;
    const score = (L) => {
      const bpm = (60 * fps) / L;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
      return (ac[L] + 0.5 * (ac[2 * L] || 0) + 0.25 * (ac[Math.round(L / 2)] || 0)) * prior;
    };
    for (let L = Lmin; L <= Lmax; L++) { const s = score(L); if (s > bestS) { bestS = s; bestL = L; } }
    let Lf = bestL;
    if (bestL > Lmin && bestL < Lmax) {
      const a = score(bestL - 1), b = score(bestL), c = score(bestL + 1);
      const den = a - 2 * b + c;
      if (den < 0) Lf = bestL + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    }
    let bpmEst = (60 * fps) / Lf;
    progress(0.88, "Tracking beats");
    await yieldUI();

    // Beat tracking (Ellis 2007 dynamic programming) for slight tempo drift.
    let sd = 0; for (let f = 0; f < frames; f++) sd += hp[f] * hp[f];
    sd = Math.sqrt(sd / frames) || 1;
    const per = (fps * 60) / bpmEst;
    const alpha = 400;
    const cs = new Float64Array(frames), bt = new Int32Array(frames).fill(-1);
    const lo = Math.round(2 * per), hi = Math.max(1, Math.round(per / 2));
    for (let i = 0; i < frames; i++) {
      let best = -Infinity, arg = -1;
      for (let j = Math.max(0, i - lo); j <= i - hi; j++) {
        const r = Math.log((i - j) / per);
        const s = cs[j] - alpha * r * r;
        if (s > best) { best = s; arg = j; }
      }
      cs[i] = hp[i] / sd + (arg >= 0 && best > 0 ? best : 0);
      bt[i] = arg >= 0 && best > 0 ? arg : -1;
    }
    let end = frames - 1, mx = -Infinity;
    for (let i = Math.max(0, frames - Math.round(2 * per)); i < frames; i++) if (cs[i] > mx) { mx = cs[i]; end = i; }
    const bf = [];
    for (let i = end; i >= 0; i = bt[i]) { bf.push(i); if (bt[i] < 0) break; }
    bf.reverse();
    const duration = buffer.duration;
    let beats = bf.map((f) => (f * hop + N / 2) / sr - NR.ONSET_BIAS);
    if (beats.length < 4) { // fallback: rigid grid
      beats = [];
      for (let t = 0; t < duration; t += 60 / bpmEst) beats.push(t);
    }
    const iv = [];
    for (let i = 1; i < beats.length; i++) iv.push(beats[i] - beats[i - 1]);
    const medIv = percentile(iv, 0.5) || 60 / bpmEst;
    bpmEst = 60 / medIv;
    while (beats[0] - medIv > -medIv * 0.5) beats.unshift(beats[0] - medIv);
    while (beats[beats.length - 1] < duration + medIv) beats.push(beats[beats.length - 1] + medIv);

    // 16th-note grid; attach the strongest nearby onset to each slot.
    const slots = [];
    for (let b = 0; b < beats.length - 1; b++) {
      const d = beats[b + 1] - beats[b];
      for (let j = 0; j < 4; j++) slots.push({ t: beats[b] + (j * d) / 4, pos: j, beat: b, strength: 0, bands: null, onsetT: null });
    }
    let si = 0;
    for (const o of onsets) {
      while (si < slots.length - 1 && Math.abs(slots[si + 1].t - o.t) <= Math.abs(slots[si].t - o.t)) si++;
      const s = slots[si];
      if (!s || Math.abs(s.t - o.t) > 0.09) continue; // too far from the grid: likely noise / rubato
      if (o.strength > s.strength) { s.strength = o.strength; s.bands = o.bands; s.onsetT = o.t; }
    }
    progress(1, "Done");
    return {
      duration, bpm: bpmEst, beats, onsets, fps,
      slots: slots.filter((s) => s.t >= 0 && s.t <= duration),
    };
  };
  // Small empirical correction for the analysis frame centre vs perceived attack (seconds).
  NR.ONSET_BIAS = 0.0;
})();
