/* Neon Riff - chart generation.
   File mode: picks real onsets from the analysis, quantised to the beat grid.
   YouTube mode: steady seeded patterns from a manual BPM + offset (approximate). */
(function () {
  "use strict";
  const NR = (window.NR = window.NR || {});

  NR.DIFFS = {
    easy:   { key: "easy",   name: "Easy",   lanes: 3, allowed: [0],          minGap: 0.42,  nps: 1.3, lead: 1.9,  chordFrac: 0,    chordGap: 9,    chord3Frac: 0 },
    medium: { key: "medium", name: "Medium", lanes: 4, allowed: [0, 2],       minGap: 0.235, nps: 2.3, lead: 1.55, chordFrac: 0.05, chordGap: 0.5,  chord3Frac: 0 },
    hard:   { key: "hard",   name: "Hard",   lanes: 5, allowed: [0, 2],       minGap: 0.165, nps: 3.4, lead: 1.25, chordFrac: 0.12, chordGap: 0.24, chord3Frac: 0 },
    expert: { key: "expert", name: "Expert", lanes: 5, allowed: [0, 1, 2, 3], minGap: 0.105, nps: 5.0, lead: 1.0,  chordFrac: 0.2,  chordGap: 0.2 , chord3Frac: 0.04 },
  };

  function rng(seed) { // mulberry32
    let a = seed >>> 0;
    return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** Shared post-processing: playable lanes, chords, star phrases. Input: [{t, lane, score, c}] sorted. */
  function finalize(base, d, lanes, duration, bpm, beats, mode, r) {
    // 1. Pattern fixes: no fast jacks / triple repeats, no huge jumps at speed.
    for (let i = 1; i < base.length; i++) {
      const n = base[i], p = base[i - 1], gap = n.t - p.t;
      const dir = n.c >= p.c ? 1 : -1;
      if (n.lane === p.lane) {
        const p2 = base[i - 2];
        if (gap < 0.16 || (p2 && p2.lane === n.lane && n.t - p2.t < 1.0)) {
          let nl = n.lane + dir;
          if (nl < 0 || nl >= lanes) nl = n.lane - dir;
          n.lane = clamp(nl, 0, lanes - 1);
        }
      }
      const maxJump = gap < 0.13 ? 2 : lanes; // two hands on a keyboard: only very fast jumps are limited
      if (Math.abs(n.lane - p.lane) > maxJump) n.lane = p.lane + Math.sign(n.lane - p.lane) * maxJump;
    }
    // 2. Chords on strong, well-spaced notes (higher difficulties only).
    const notes = [];
    const scores = base.map((n) => n.score).sort((a, b) => b - a);
    const cut2 = d.chordFrac > 0 ? scores[Math.floor(scores.length * d.chordFrac)] ?? Infinity : Infinity;
    const cut3 = d.chord3Frac > 0 ? scores[Math.floor(scores.length * d.chord3Frac)] ?? Infinity : Infinity;
    for (let i = 0; i < base.length; i++) {
      const n = base[i];
      const gp = i > 0 ? n.t - base[i - 1].t : 9, gn = i < base.length - 1 ? base[i + 1].t - n.t : 9;
      let set = [n.lane];
      const forced = n.forceChord;
      const g2 = forced ? 0.2 : d.chordGap, g3 = forced ? 0.2 : d.chordGap * 1.4;
      if ((n.score >= cut3 || forced === 3) && gp >= g3 && gn >= g3 && lanes >= 4) {
        const s = clamp(n.lane - 1, 0, lanes - 3); set = [s, s + 1, s + 2];
      } else if (((n.score >= cut2 && d.chordFrac > 0) || forced >= 2) && gp >= g2 && gn >= g2) {
        const other = n.lane + 2 < lanes ? n.lane + 2 : n.lane - 2 >= 0 ? n.lane - 2 : n.lane + 1 < lanes ? n.lane + 1 : n.lane - 1;
        set = [n.lane, other];
      }
      for (const l of set) notes.push({ t: n.t, lane: l, chord: set.length > 1, star: false, phrase: -1, judged: null, dt: 0 });
    }
    // 3. Star-power phrases: 8 unique timestamps every ~24.
    const times = [...new Set(notes.map((n) => n.t))];
    const phraseOf = new Map();
    let ph = 0;
    for (let i = 12; i + 8 <= times.length; i += 26) { for (let k = 0; k < 8; k++) phraseOf.set(times[i + k], ph); ph++; }
    for (const n of notes) if (phraseOf.has(n.t)) { n.star = true; n.phrase = phraseOf.get(n.t); }
    return { notes, lanes, duration, bpm, beats, mode, diff: d.key, lead: d.lead, phrases: ph };
  }

  /** File mode chart from NR.analyzeAudio output. */
  NR.chartFromAnalysis = function (an, diffKey) {
    const d = NR.DIFFS[diffKey];
    const lanes = d.lanes;
    let cands = an.slots.filter((s) => s.strength > 0 && d.allowed.includes(s.pos));
    if (!cands.length) return finalize([], d, lanes, an.duration, an.bpm, an.beats, "file");
    // Combine global strength with locally-normalised strength so quiet sections still get notes.
    const gMean = cands.reduce((a, s) => a + s.strength, 0) / cands.length;
    let lo = 0, hi = 0, sum = 0;
    const W = 4;
    for (const s of cands) {
      while (hi < cands.length && cands[hi].t <= s.t + W) sum += cands[hi++].strength;
      while (cands[lo].t < s.t - W) sum -= cands[lo++].strength;
      const lMean = sum / Math.max(1, hi - lo);
      const metric = s.pos === 0 ? 1.25 : s.pos === 2 ? 1.1 : 0.9;
      s._score = (0.5 * (s.strength / gMean) + 0.5 * (s.strength / (lMean + 1e-9))) * metric;
    }
    const first = cands[0].t, last = cands[cands.length - 1].t;
    const target = Math.max(4, Math.round(d.nps * Math.max(5, last - first)));
    const order = cands.slice().sort((a, b) => b._score - a._score);
    const acc = []; // sorted times
    const ins = (t) => { let a = 0, b = acc.length; while (a < b) { const m = (a + b) >> 1; if (acc[m] < t) a = m + 1; else b = m; } return a; };
    const chosen = [];
    for (const s of order) {
      if (chosen.length >= target) break;
      if (s.t < 1.0) continue; // give the player a moment
      const i = ins(s.t);
      if ((i > 0 && s.t - acc[i - 1] < d.minGap) || (i < acc.length && acc[i] - s.t < d.minGap)) continue;
      acc.splice(i, 0, s.t);
      chosen.push(s);
    }
    chosen.sort((a, b) => a.t - b.t);
    // Lane from band "centroid" (low sounds left, bright sounds right), rank-normalised.
    const NB = NR.NUM_BANDS;
    for (const s of chosen) {
      let w = 0, c = 0;
      for (let b = 0; b < NB; b++) { const v = s.bands ? s.bands[b] : 0; w += v; c += v * b; }
      s._c = w > 0 ? c / w / (NB - 1) : 0.5;
    }
    const ranked = chosen.map((s, i) => [s._c, i]).sort((a, b) => a[0] - b[0]);
    const lane = new Array(chosen.length);
    ranked.forEach(([, i], r) => { lane[i] = Math.min(lanes - 1, Math.floor((r / ranked.length) * lanes)); });
    const base = chosen.map((s, i) => ({ t: s.t, lane: lane[i], score: s._score, c: s._c }));
    return finalize(base, d, lanes, an.duration, an.bpm, an.beats, "file");
  };

  // 16th positions within a 4/4 bar.
  const RHYTHMS = {
    easy:   [[0, 4, 8, 12], [0, 8, 12], [0, 4, 8], [0, 8]],
    medium: [[0, 4, 6, 8, 12, 14], [0, 2, 4, 8, 10, 12], [0, 4, 8, 10, 12, 14], [0, 2, 4, 6, 8, 12], [0, 4, 8, 12]],
    hard:   [[0, 2, 4, 6, 8, 10, 12, 14], [0, 3, 6, 8, 10, 12, 14], [0, 2, 4, 6, 8, 11, 12, 14], [0, 2, 4, 8, 10, 12, 14]],
    expert: [[0, 2, 3, 4, 6, 8, 10, 11, 12, 14], [0, 1, 2, 4, 6, 8, 9, 10, 12, 14, 15], [0, 2, 4, 6, 8, 10, 12, 14], [0, 2, 3, 4, 6, 7, 8, 10, 12, 13, 14]],
  };

  /** YouTube / manual-BPM mode: steady patterns on a fixed grid. Approximate by design. */
  NR.chartFromBpm = function ({ bpm, offset, duration, seed, diffKey }) {
    const d = NR.DIFFS[diffKey];
    const lanes = d.lanes;
    const r = rng(hashStr(String(seed) + "|" + bpm.toFixed(2) + "|" + diffKey));
    const beat = 60 / bpm, s16 = beat / 4;
    const beats = [];
    for (let t = offset; t < duration + beat; t += beat) beats.push(t);
    const base = [];
    let laneP = Math.floor(lanes / 2), dir = 1;
    const bars = Math.floor((duration - offset) / (4 * beat));
    const startBar = Math.max(1, Math.ceil((3 - offset) / (4 * beat)));
    let pattern = null, lanePattern = null;
    for (let bar = startBar; bar < bars; bar++) {
      const section = Math.floor(bar / 8);
      const intense = section % 4 === 2 || section % 4 === 3; // "chorus"-ish blocks are busier
      const pool = RHYTHMS[d.key];
      if (bar % 4 === 0 || !pattern) {
        const idx = Math.floor(r() * pool.length);
        pattern = pool[intense ? Math.max(idx, pool.length > 1 ? 1 : 0) % pool.length : idx];
        lanePattern = pattern.map(() => { const step = r() < 0.6 ? 1 : 2; if (r() < 0.3) dir = -dir; laneP += dir * step; if (laneP < 0) { laneP = -laneP; dir = 1; } if (laneP >= lanes) { laneP = 2 * (lanes - 1) - laneP; dir = -1; } laneP = clamp(laneP, 0, lanes - 1); return laneP; });
      }
      const fill = bar % 8 === 7 && d.key !== "easy";
      pattern.forEach((pos, k) => {
        if (fill && pos > 8) return;
        const t = offset + bar * 4 * beat + pos * s16;
        if (t >= duration - 0.5) return;
        base.push({ t, lane: lanePattern[k], score: pos === 0 ? 2 : pos % 4 === 0 ? 1.2 : 1, c: lanePattern[k] / lanes,
          forceChord: pos === 0 && bar % 2 === 0 ? (d.key === "expert" && bar % 8 === 0 ? 3 : d.chordFrac > 0.1 ? 2 : 0) : 0 });
      });
      if (fill) for (let k = 0; k < (d.key === "expert" ? 6 : d.key === "hard" ? 4 : 2); k++) {
        const pos = 10 + k * (d.key === "expert" ? 1 : 2);
        if (pos > 15) break;
        base.push({ t: offset + bar * 4 * beat + pos * s16, lane: clamp(lanes - 1 - (k % lanes), 0, lanes - 1), score: 1, c: 0.5, forceChord: 0 });
      }
    }
    base.sort((a, b) => a.t - b.t);
    // Enforce difficulty min gap.
    const out = [];
    for (const n of base) if (!out.length || n.t - out[out.length - 1].t >= Math.min(d.minGap, s16 * 0.99)) out.push(n);
    const dd = Object.assign({}, d, { chordFrac: 0, chord3Frac: 0 });
    return finalize(out, dd, lanes, duration, bpm, beats, "youtube", r);
  };
})();
