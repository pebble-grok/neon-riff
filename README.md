# Neon Riff: a Guitar Hero-style rhythm game (PWA)

You give it a song and it builds a note chart. Notes come down a neon highway in time with the music, and you hit them.
It's plain HTML/CSS/JS with no build step and no dependencies. It installs to your home screen and works offline (in audio-file mode).

## Run it locally

```bash
cd rhythm-pwa
python3 -m http.server 8000      # or: npx serve -l 8000
```

Then open **http://localhost:8000**.

Serve it over http(s). Opening `index.html` as a `file://` URL won't register the service worker, though the game still plays that way.

### Play on your phone
A service worker (needed for install + offline) only runs on `localhost` or HTTPS. You have two options:
- **Quick, on the same Wi-Fi:** open `http://<your-computer-ip>:8000` on the phone. The game plays fine, but install/offline won't work because it isn't HTTPS.
- **Proper install:** serve it over HTTPS. Any static host works, or use a tunnel such as `npx localtunnel --port 8000` or `cloudflared tunnel --url http://localhost:8000`, then open the https URL.

### Install it
- **Android (Chrome):** tap **Install app** in the menu, or use ⋮ → *Install app* / *Add to Home screen*.
- **iPhone/iPad (Safari):** Share → **Add to Home Screen**.
- **Desktop Chrome/Edge:** use the install icon in the address bar.

## How to play
1. **Pick a song.**
   - **Audio file (recommended):** drop or choose an mp3/wav/ogg/m4a. It's decoded and analysed on your device: onset detection, tempo, and beat grid. A chart is generated for each difficulty from the actual audio. Nothing gets uploaded.
   - **YouTube link (approximate):** paste a link and set the BPM by typing it or tapping along to the preview. Nudge the start offset until the beat lines up. The chart is a steady pattern on that tempo grid and is *not* derived from the audio (see Limitations).
2. **Pick a difficulty.** Easy has 3 lanes and is sparse. Medium has 4 lanes and a few chords. Hard has 5 lanes and more chords. Expert has 5 lanes, 16ths, and is fast.
3. Press **PLAY** and hit each note as it crosses the fret line.

| Action | Keyboard | Touch |
|---|---|---|
| Lanes | `D` `F` `J` `K` (`L` = 5th lane) | tap the lane (multi-touch for chords) |
| Overdrive (x2, once the meter is ≥ 50%) | `Space` / `Enter` | ⚡ button |
| Pause / resume | `Esc` / `P` | ❚❚ button |
| YouTube mode: nudge sync ±10 ms | `←` / `→` | — |

- Judgements are **Perfect** (±45 ms), **Great** (±90 ms), **Good** (±140 ms), and **Miss**. Windows are 1.4× wider in YouTube mode.
- The multiplier goes up every 10 combo, from x1 to x4. Hitting the glowing "star" phrases fills overdrive.
- The results screen shows a grade from S to F, stars, accuracy, max combo, and median timing (early or late). Best scores are saved per song and difficulty.

### Latency / sync
If notes feel consistently early or late (Bluetooth headphones especially), use **Calibrate** in Settings: tap along to 16 clicks and it sets the offset for you. You can also drag **Latency offset** yourself. Raise it if you're hitting late. The results screen's median timing tells you which way to go.

## Honest limitations
- **YouTube mode is approximate.** A web page can't read audio from a YouTube embed, so the game can't analyse the song. It uses the BPM and offset you give it and lays a generic pattern on that grid. The patterns follow the beat but not the actual riffs. It drifts on songs with tempo changes or a loose (non-click) tempo. It also needs internet, and some videos won't play embedded (the owner disabled it, or there are age/region restrictions). On phones, autoplay may need an extra tap to start. **Audio-file mode is far more accurate.**
- File-mode charting is a heuristic (spectral-flux onsets plus a single global tempo with beat tracking). It's good on steady-tempo pop/rock/electronic. It's weaker on rubato, tempo changes, very quiet or ambient tracks, and dense mixes where the vocal or guitar isn't the loudest onset. Lanes come from the frequency content of each hit, not from the actual guitar part.
- There are no sustain/hold notes, no hammer-ons, and no multiplayer.
- Long files (10+ minutes) take a few seconds to analyse, and very large files use a lot of memory on phones.
- iOS: audio only starts after a tap (Apple's rule). The silent switch can mute Web Audio on some iOS versions. Install/offline needs HTTPS.
- It's only been tested in headless desktop Chrome with phone emulation, not on real iOS/Android devices.

## Files
```
index.html            UI (menu, game, pause, results, calibration)
css/style.css
js/analyzer.js        FFT, spectral flux, onsets, tempo, beat tracking, 16th-note grid
js/chart.js           difficulty presets, chart from analysis, chart from BPM (YouTube)
js/youtube.js         URL parsing, IFrame API loader, tap tempo, YouTube clock
js/game.js            canvas highway, input, judging, scoring, overdrive, effects
js/app.js             screens, settings, file loading, YouTube flow, PWA install
manifest.webmanifest  sw.js  icons/  make_icons.py (regenerates icons with Pillow)
```
