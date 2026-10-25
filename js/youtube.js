/* Neon Riff - YouTube mode helpers: URL parsing, IFrame API loading, tap tempo, clock.
   NOTE: a web page cannot read a YouTube video's audio, so nothing here analyses it.
   Charts in this mode come from the BPM/offset the player supplies. */
(function () {
  "use strict";
  const NR = (window.NR = window.NR || {});
  const ID_RE = /^[A-Za-z0-9_-]{11}$/;

  function parseT(v) {
    if (!v) return 0;
    if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(v);
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
  }

  /** Returns {id, start} or null. Accepts watch / youtu.be / shorts / embed / live / music links or a bare ID. */
  NR.parseYouTube = function (input) {
    const s = String(input || "").trim();
    if (!s) return null;
    if (ID_RE.test(s)) return { id: s, start: 0 };
    let url;
    try { url = new URL(/^[a-z]+:\/\//i.test(s) ? s : "https://" + s); } catch (e) { return null; }
    const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
    let id = null;
    if (host === "youtu.be") id = url.pathname.split("/")[1];
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (url.pathname === "/watch") id = url.searchParams.get("v");
      else { const m = /^\/(?:embed|shorts|live|v|e)\/([^/?#]+)/.exec(url.pathname); if (m) id = m[1]; }
    }
    if (!id || !ID_RE.test(id)) return null;
    return { id, start: parseT(url.searchParams.get("t") || url.searchParams.get("start")) };
  };

  let apiPromise = null;
  /** Load the IFrame API once; rejects on network error / timeout (e.g. offline) so the UI can recover. */
  NR.loadYouTubeApi = function (timeoutMs) {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      if (!navigator.onLine) { reject(new Error("You're offline. YouTube mode needs a connection; file mode works offline.")); return; }
      const timer = setTimeout(() => reject(new Error("YouTube player didn't load (offline, blocked network, or a content blocker). File mode works offline.")), timeoutMs || 10000);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () { clearTimeout(timer); if (prev) try { prev(); } catch (e) {} resolve(window.YT); };
      const sc = document.createElement("script");
      sc.src = "https://www.youtube.com/iframe_api";
      sc.async = true;
      sc.onerror = () => { clearTimeout(timer); sc.remove(); reject(new Error("Couldn't reach YouTube to load the player (offline or blocked). File mode works offline.")); };
      document.head.appendChild(sc);
    }).catch((e) => { apiPromise = null; throw e; });
    return apiPromise;
  };

  NR.ytErrorText = function (code) {
    return ({ 2: "That video ID looks invalid.", 5: "This video can't play in an embedded HTML5 player.", 100: "Video not found or private.",
      101: "The owner doesn't allow this video to be embedded.", 150: "The owner doesn't allow this video to be embedded.", 153: "YouTube refused the embed (missing referrer). Run from http://localhost rather than file://." })[code] || "YouTube player error " + code + ".";
  };

  /** Tap tempo. Linear regression over recent taps gives the period; if video times are supplied it also gives the beat phase. */
  NR.TapTempo = class {
    constructor() { this.reset(); }
    reset() { this.taps = []; this.vids = []; }
    tap(perfMs, videoTime) {
      if (this.taps.length && perfMs - this.taps[this.taps.length - 1] > 2000) this.reset();
      this.taps.push(perfMs); this.vids.push(typeof videoTime === "number" ? videoTime : null);
      if (this.taps.length > 24) { this.taps.shift(); this.vids.shift(); }
      return this.result();
    }
    static fit(ys) {
      const n = ys.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx); return { slope, icpt: (sy - slope * sx) / n };
    }
    result() {
      const n = this.taps.length;
      if (n < 2) return { count: n, bpm: null, offset: null };
      const { slope } = NR.TapTempo.fit(this.taps);
      const bpm = 60000 / slope;
      let offset = null;
      if (n >= 4 && this.vids.every((v) => v !== null)) {
        const f = NR.TapTempo.fit(this.vids);
        if (f.slope > 0.15) { const p = 60 / bpm; offset = ((f.icpt % p) + p) % p; }
      }
      return { count: n, bpm, offset };
    }
  };

  /** Smoothed clock over player.getCurrentTime() (which updates coarsely). */
  NR.YTClock = class {
    constructor(player) { this.p = player; this.at = null; this.ap = 0; this.last = -Infinity; this.paused = false; this.ended = false; this.kind = "youtube"; }
    now() {
      let t = 0;
      try { t = this.p.getCurrentTime() || 0; } catch (e) {}
      const st = this.state();
      const pn = performance.now();
      if (st === 1) {
        if (this.at === null) { this.at = t; this.ap = pn; }
        const pred = this.at + (pn - this.ap) / 1000;
        if (Math.abs(t - pred) > 0.12) { this.at = t; this.ap = pn; }
        else { this.at = pred + (t - pred) * 0.04; this.ap = pn; }
        t = this.at;
      } else this.at = null;
      if (t < this.last && this.last - t < 0.2) t = this.last;
      this.last = t;
      return t;
    }
    state() { try { return this.p.getPlayerState(); } catch (e) { return -1; } }
    pause() { this.paused = true; try { this.p.pauseVideo(); } catch (e) {} }
    resume() { this.paused = false; this.at = null; try { this.p.playVideo(); } catch (e) {} }
    stop() { try { this.p.stopVideo(); } catch (e) {} }
    setVolume(v) { try { this.p.setVolume(Math.round(v * 100)); } catch (e) {} }
    isEnded() { return this.ended || this.state() === 0; }
  };
})();
