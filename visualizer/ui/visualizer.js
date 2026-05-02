// =============================================================================
// Tracker — a song-aware audio visualizer.
//
// The screen is treated as a real-time instrument panel:
//   • A scrolling spectrogram fills the centre — the song's structure is *seen*
//     as it plays (verses, drops, fills, breakdowns).
//   • Spectrogram colour ramp tracks `energy_zone_hue` from the listener so the
//     palette itself encodes whether we're in a warm, mid or cool moment.
//   • A tempo grid (faint vertical lines spaced at 60 / BPM) overlays the
//     spectrogram once the BPM lock is confident.
//   • A beat timeline at the bottom plots every detected onset over the last
//     ~14 s, height = strength.
//   • Editorial typography surfaces what we're hearing — dominant band, BPM,
//     timbre descriptors (TONAL/NOISY, DARK/BRIGHT, NARROW/WIDE) — so the
//     viewer can read the song, not just see colours move.
// =============================================================================

const F_MIN = 20;
const F_MAX = 20000;

// Bands match listener.py's _BAND_RANGES
const BANDS = [
  { key: "sub",     label: "SUB",   fLow: 20,    fHigh: 60 },
  { key: "bass",    label: "BASS",  fLow: 60,    fHigh: 250 },
  { key: "lowMid",  label: "L-MID", fLow: 250,   fHigh: 500 },
  { key: "mid",     label: "MID",   fLow: 500,   fHigh: 2000 },
  { key: "highMid", label: "H-MID", fLow: 2000,  fHigh: 4000 },
  { key: "high",    label: "HIGH",  fLow: 4000,  fHigh: 8000 },
  { key: "air",     label: "AIR",   fLow: 8000,  fHigh: 20000 },
];

// Spectrogram colour ramp — 5 stops, hue tracks the song. Black at silence,
// hot white at full intensity. The middle stops are saturated in the song's hue
// so the palette itself feels keyed to the music.
function buildPalette(hue) {
  const h2 = (hue + 18) % 360; // a touch warmer at the top end
  return [
    { t: 0.00, rgb: [6, 7, 10] },
    { t: 0.18, rgb: hsl(hue, 70, 14) },
    { t: 0.45, rgb: hsl(hue, 88, 38) },
    { t: 0.78, rgb: hsl(h2, 78, 64) },
    { t: 1.00, rgb: [248, 244, 232] },
  ];
}

function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function paletteColor(palette, t) {
  if (t <= 0.025) return null;
  const tc = t > 1 ? 1 : t;
  let i = 0;
  while (i < palette.length - 1 && palette[i + 1].t < tc) i++;
  if (i >= palette.length - 1) {
    const c = palette[palette.length - 1].rgb;
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  const a = palette[i], b = palette[i + 1];
  const k = (tc - a.t) / (b.t - a.t);
  const r = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k);
  const g = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k);
  const bl = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k);
  return `rgb(${r},${g},${bl})`;
}

const SCROLL_PX_SEC = 64;

export class Visualizer {
  constructor(canvas, analyzer) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.analyzer = analyzer;

    // Offscreen buffer for the spectrogram so we only ever paint one new column
    // per audio frame plus a self-blit shift each render frame.
    this.spec = document.createElement("canvas");
    this.specCtx = this.spec.getContext("2d", { alpha: false });

    this.lastRevision = -1;
    this.beatPulse = 0;
    this.beatHistory = [];   // [{t, strength}]
    this.tempoMarks = [];    // [{t}]
    this.lastTempoMark = 0;

    this.hueSmooth = 200;
    this.rmsSmooth = 0;
    this.beatSize = 0;        // visual scale impulse on the BPM number

    this.lastT = performance.now();
    this._palette = buildPalette(this.hueSmooth);

    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.offsetWidth;
    const h = this.canvas.offsetHeight;
    if (!w || !h) return;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    this.dpr = dpr;

    // Margins — editorial breathing room. Header carries identity, footer
    // carries time/rhythm, left axis carries frequency labels.
    this.headerH = clamp(h * 0.085, 56, 80);
    this.footerH = clamp(h * 0.105, 64, 110);
    this.axisW   = 88;
    this.specX0  = this.axisW;
    this.specY0  = this.headerH;
    this.specW   = Math.max(120, w - this.specX0 - 24);
    this.specH   = Math.max(120, h - this.headerH - this.footerH);

    this.spec.width = Math.max(1, Math.floor(this.specW * dpr));
    this.spec.height = Math.max(1, Math.floor(this.specH * dpr));
    this.specCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.specCtx.fillStyle = "#070809";
    this.specCtx.fillRect(0, 0, this.specW, this.specH);
  }

  draw() {
    const a = this.analyzer;
    const ctx = this.ctx;
    const now = performance.now();
    const dt = Math.min(0.066, (now - this.lastT) / 1000);
    this.lastT = now;

    // ---- Smoothing & state -------------------------------------------------
    this.hueSmooth = approachAngle(this.hueSmooth, a.energyZoneHue ?? 200, 0.06);
    this.rmsSmooth += (a.rms - this.rmsSmooth) * 0.15;
    this._palette = buildPalette(this.hueSmooth);
    this.beatSize *= Math.pow(0.0012, dt); // fast decay
    this.beatPulse *= Math.pow(0.025, dt);

    const fresh = this.lastRevision !== a.revision;
    if (fresh && a.beat) {
      this.beatHistory.push({ t: now, strength: a.beatStrength });
      this.beatPulse = Math.min(1, 0.4 + a.beatStrength);
      this.beatSize = Math.min(1, 0.25 + a.beatStrength * 0.9);
    }
    this.beatHistory = this.beatHistory.filter((b) => now - b.t < 14000);

    // Tempo marks — placed at exact BPM cadence in wall-clock time, then they
    // scroll across the screen at the same speed as the spectrogram.
    if (a.tempoBpm > 30 && a.tempoConfidence > 0.4) {
      const periodMs = 60000 / a.tempoBpm;
      if (this.lastTempoMark === 0) this.lastTempoMark = now;
      while (now - this.lastTempoMark >= periodMs) {
        this.lastTempoMark += periodMs;
        this.tempoMarks.push({ t: this.lastTempoMark });
      }
    } else {
      this.lastTempoMark = 0;
    }
    this.tempoMarks = this.tempoMarks.filter((m) => now - m.t < 14000);

    // ---- Spectrogram update ------------------------------------------------
    this._scrollSpec(dt);
    if (fresh && a.fft) {
      this._depositColumn();
      this.lastRevision = a.revision;
    }

    // ---- Compose -----------------------------------------------------------
    ctx.fillStyle = "#06070a";
    ctx.fillRect(0, 0, this.w, this.h);
    this._drawVignette();

    ctx.drawImage(
      this.spec,
      0, 0, this.spec.width, this.spec.height,
      this.specX0, this.specY0, this.specW, this.specH
    );

    this._drawTempoGrid(now);
    this._drawBandGuides();
    this._drawAxis();
    this._drawLiveSpectrum();
    this._drawHeader();
    this._drawFooter(now);
    this._drawBpmCenter();
    this._drawBeatFlash();
  }

  // ---------------------------------------------------------------------------
  // Spectrogram core
  // ---------------------------------------------------------------------------

  _scrollSpec(dt) {
    const dxF = SCROLL_PX_SEC * dt;
    const dx = Math.round(dxF);
    if (dx < 1) return;
    // Self-blit shift. drawImage from a canvas onto itself is well-defined in
    // all major browsers and avoids a second offscreen buffer.
    this.specCtx.globalCompositeOperation = "copy";
    this.specCtx.drawImage(this.spec, -dx, 0, this.specW, this.specH);
    this.specCtx.globalCompositeOperation = "source-over";
    this.specCtx.fillStyle = "#070809";
    this.specCtx.fillRect(this.specW - dx, 0, dx, this.specH);
  }

  _depositColumn() {
    const fft = this.analyzer.fft;
    const n = fft.length;
    if (!n) return;
    const ctx = this.specCtx;
    const colW = 2;
    const x = this.specW - colW;
    const binH = this.specH / n;

    for (let i = 0; i < n; i++) {
      const v = fft[i];
      const c = paletteColor(this._palette, v);
      if (!c) continue;
      const y = this.specH - (i + 1) * binH;
      ctx.fillStyle = c;
      ctx.fillRect(x, y, colW, binH + 0.6);
    }

    // Hot-edge accent on a real onset — faint vertical stripe baked into the
    // spectrogram, so it scrolls with the timeline as a permanent record.
    if (this.analyzer.beat) {
      ctx.fillStyle = `hsla(${this.hueSmooth} 60% 88% / 0.18)`;
      ctx.fillRect(x, 0, colW, this.specH);
    }
  }

  // ---------------------------------------------------------------------------
  // Overlays
  // ---------------------------------------------------------------------------

  _drawVignette() {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(
      this.w / 2, this.h / 2, 0,
      this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.7
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `hsla(${this.hueSmooth} 50% 6% / 0.55)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  _drawTempoGrid(now) {
    const a = this.analyzer;
    if (a.tempoConfidence < 0.4) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.specX0, this.specY0, this.specW, this.specH);
    ctx.clip();
    ctx.lineWidth = 1;
    for (const m of this.tempoMarks) {
      const age = (now - m.t) / 1000;
      const x = this.specX0 + this.specW - age * SCROLL_PX_SEC;
      if (x < this.specX0 - 1 || x > this.specX0 + this.specW + 1) continue;
      const fade = 1 - age / 14;
      ctx.strokeStyle = `hsla(${this.hueSmooth} 30% 90% / ${0.10 * fade})`;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, this.specY0);
      ctx.lineTo(Math.round(x) + 0.5, this.specY0 + this.specH);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawBandGuides() {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (const b of BANDS) {
      const y = this.specY0 + this._freqToYInSpec(b.fLow);
      ctx.beginPath();
      ctx.moveTo(this.specX0, Math.round(y) + 0.5);
      ctx.lineTo(this.specX0 + this.specW, Math.round(y) + 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawAxis() {
    const ctx = this.ctx;
    const a = this.analyzer;
    ctx.save();
    ctx.font = "500 9px 'Inter', system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (const b of BANDS) {
      const y = this.specY0 + this._freqToYInSpec((b.fLow + b.fHigh) / 2);
      const isDom = a.dominantBand === b.key;
      const env = a.envelopes[b.key] ?? 0;
      // tick
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.specX0 - 6, Math.round(y) + 0.5);
      ctx.lineTo(this.specX0 - 1, Math.round(y) + 0.5);
      ctx.stroke();
      // label
      ctx.fillStyle = isDom
        ? `hsl(${this.hueSmooth} 80% 78%)`
        : `rgba(220,220,225,${0.32 + env * 0.55})`;
      ctx.fillText(b.label, this.specX0 - 12, y);
      // micro-meter
      const mw = 28;
      const mx = this.specX0 - 12 - 36;
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.fillRect(mx, y - 1, mw, 2);
      ctx.fillStyle = isDom
        ? `hsl(${this.hueSmooth} 80% 65%)`
        : "rgba(220,220,225,0.55)";
      ctx.fillRect(mx, y - 1, mw * Math.min(1, env), 2);
    }
    ctx.restore();
  }

  _drawLiveSpectrum() {
    // Thin strip just outside the spectrogram's right edge — the *now* slice.
    const a = this.analyzer;
    const ctx = this.ctx;
    const xR = this.specX0 + this.specW;
    const stripX = xR + 6;
    const stripW = clamp(this.w - stripX - 14, 8, 22);
    if (stripW < 6) return;
    const n = a.fft.length;
    const binH = this.specH / n;

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.strokeRect(stripX + 0.5, this.specY0 + 0.5, stripW - 1, this.specH - 1);
    for (let i = 0; i < n; i++) {
      const v = a.fft[i];
      if (v < 0.04) continue;
      const y = this.specY0 + this.specH - (i + 1) * binH;
      const c = paletteColor(this._palette, Math.min(1, v * 1.1));
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(stripX + 1, y, (stripW - 2) * Math.min(1, v), binH + 0.5);
    }
    ctx.restore();
  }

  _drawHeader() {
    const a = this.analyzer;
    const ctx = this.ctx;
    const y = this.headerH * 0.5;
    // Listener emits `silent: true` while its noise gate is closed; we also
    // fall back to a tiny RMS check so the header still reads "WAITING" if
    // the listener is from an older build that didn't ship the flag.
    const silent = a.silent || this.rmsSmooth < 0.003;
    ctx.save();
    ctx.textBaseline = "middle";

    // ── Left: live dot + dominant band ────────────────────────────────────
    ctx.fillStyle = silent
      ? "rgba(120,120,128,0.5)"
      : `hsl(${this.hueSmooth} 75% 60%)`;
    ctx.beginPath();
    ctx.arc(20, y, 4 + (silent ? 0 : this.beatPulse * 2.5), 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = silent ? "rgba(180,180,188,0.45)" : "rgba(220,222,228,0.55)";
    ctx.font = "600 10px 'Inter', system-ui, sans-serif";
    ctx.fillText(silent ? "WAITING" : "LIVE", 32, y - 7);

    const bandLabel = (BANDS.find((b) => b.key === a.dominantBand) || BANDS[3]).label;
    ctx.fillStyle = silent ? "rgba(180,180,188,0.45)" : "rgba(245,245,248,0.95)";
    ctx.font = "600 14px 'Inter', system-ui, sans-serif";
    ctx.fillText(silent ? "NO SIGNAL" : `${bandLabel} DOMINANT`, 32, y + 7);

    // ── Center: timbre descriptors ────────────────────────────────────────
    const desc = silent
      ? "—   ·   —   ·   —"
      : [
          a.flatness > 0.45 ? "NOISY" : a.flatness < 0.18 ? "TONAL" : "MIXED",
          a.centroid > 0.32 ? "BRIGHT" : a.centroid < 0.12 ? "DARK" : "WARM",
          a.bandwidth > 0.32 ? "WIDE" : a.bandwidth < 0.12 ? "NARROW" : "OPEN",
        ].join("   ·   ");
    ctx.fillStyle = silent ? "rgba(180,180,188,0.35)" : "rgba(220,222,228,0.55)";
    ctx.font = "500 11px 'Inter', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(desc, this.w / 2, y);

    // ── Right: BPM + confidence ───────────────────────────────────────────
    ctx.textAlign = "right";
    const conf = Math.round((a.tempoConfidence ?? 0) * 100);
    const bpmTxt = a.tempoBpm > 30 ? a.tempoBpm.toFixed(1) : "—";
    ctx.fillStyle = "rgba(220,222,228,0.55)";
    ctx.font = "600 10px 'Inter', system-ui, sans-serif";
    ctx.fillText(`TEMPO   ${conf}% LOCK`, this.w - 20, y - 7);
    ctx.fillStyle = "rgba(245,245,248,0.95)";
    ctx.font = "600 14px 'Inter', system-ui, sans-serif";
    ctx.fillText(`${bpmTxt} BPM`, this.w - 20, y + 7);

    // ── Header underline ──────────────────────────────────────────────────
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, this.headerH - 0.5);
    ctx.lineTo(this.w, this.headerH - 0.5);
    ctx.stroke();
    ctx.restore();
  }

  _drawFooter(now) {
    const ctx = this.ctx;
    const a = this.analyzer;
    const y0 = this.h - this.footerH;
    ctx.save();

    // top hairline
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.moveTo(0, y0 + 0.5);
    ctx.lineTo(this.w, y0 + 0.5);
    ctx.stroke();

    // ── Beat timeline ─────────────────────────────────────────────────────
    const tlX0 = this.specX0;
    const tlW = this.specW;
    const tlY = y0 + 18;
    const tlH = this.footerH - 36;
    ctx.fillStyle = "rgba(255,255,255,0.025)";
    ctx.fillRect(tlX0, tlY, tlW, tlH);

    // tempo grid in the timeline
    if (a.tempoConfidence >= 0.4) {
      ctx.strokeStyle = `hsla(${this.hueSmooth} 30% 90% / 0.06)`;
      for (const m of this.tempoMarks) {
        const age = (now - m.t) / 1000;
        const x = tlX0 + tlW - age * SCROLL_PX_SEC;
        if (x < tlX0 || x > tlX0 + tlW) continue;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, tlY);
        ctx.lineTo(Math.round(x) + 0.5, tlY + tlH);
        ctx.stroke();
      }
    }

    // beats — vertical marks, height keyed to strength, fading with age
    for (const b of this.beatHistory) {
      const age = (now - b.t) / 1000;
      const x = tlX0 + tlW - age * SCROLL_PX_SEC;
      if (x < tlX0 || x > tlX0 + tlW) continue;
      const fade = 1 - age / 14;
      const len = clamp(b.strength, 0.15, 1) * tlH * 0.92;
      const yy = tlY + (tlH - len) / 2;
      ctx.fillStyle = `hsla(${this.hueSmooth} 78% 70% / ${0.85 * fade})`;
      ctx.fillRect(Math.round(x), yy, 2, len);
    }

    // playhead at the right edge of the timeline
    ctx.fillStyle = "rgba(245,245,248,0.85)";
    ctx.fillRect(tlX0 + tlW - 1, tlY - 2, 1, tlH + 4);

    // labels
    ctx.font = "500 9px 'Inter', system-ui, sans-serif";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(220,222,228,0.45)";
    ctx.textAlign = "left";
    ctx.fillText("BEAT  ·  14 s WINDOW", tlX0, y0 + 12);

    // RMS readout (bottom-left)
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(220,222,228,0.45)";
    ctx.font = "500 9px 'Inter', system-ui, sans-serif";
    ctx.fillText("RMS", 20, y0 + 14);
    ctx.fillStyle = "rgba(245,245,248,0.92)";
    ctx.font = "600 14px 'Inter', system-ui, sans-serif";
    const dbTxt = isFinite(a.db) ? a.db.toFixed(1) : "—";
    ctx.fillText(`${dbTxt} dB`, 20, y0 + 32);

    // mini VU bar
    const vuW = 64, vuH = 4;
    const vuX = 20, vuY = y0 + 40;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(vuX, vuY, vuW, vuH);
    const vuT = clamp(this.rmsSmooth * 8, 0, 1);
    ctx.fillStyle = `hsl(${this.hueSmooth} 75% 60%)`;
    ctx.fillRect(vuX, vuY, vuW * vuT, vuH);

    // Right side: window seconds
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(220,222,228,0.45)";
    ctx.font = "500 9px 'Inter', system-ui, sans-serif";
    ctx.fillText("NOW", this.w - 20, y0 + tlH + 30);
    ctx.fillText("−14 s", tlX0 + 22, y0 + tlH + 30);

    ctx.restore();
  }

  _drawBpmCenter() {
    // Big-but-restrained tempo number, sits over the spectrogram. Pulses on
    // every beat — the *only* element that animates loudly. Faded when the
    // tempo lock is weak, so the visual trust matches the data.
    const a = this.analyzer;
    if (a.tempoBpm < 30) return;
    const ctx = this.ctx;
    const cx = this.specX0 + this.specW * 0.5;
    const cy = this.specY0 + this.specH * 0.5;
    const conf = clamp(a.tempoConfidence, 0, 1);
    const baseAlpha = 0.10 + conf * 0.35;
    const scale = 1 + this.beatSize * 0.07;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // soft halo
    const haloR = 110;
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloR);
    halo.addColorStop(0, `hsla(${this.hueSmooth} 70% 50% / ${0.18 + this.beatPulse * 0.18})`);
    halo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloR, 0, Math.PI * 2);
    ctx.fill();

    // big BPM number
    const bpmStr = Math.round(a.tempoBpm).toString();
    ctx.font = "200 96px 'Inter', system-ui, sans-serif";
    ctx.fillStyle = `rgba(248,248,252,${baseAlpha + this.beatPulse * 0.25})`;
    ctx.fillText(bpmStr, 0, -8);

    // BPM caption
    ctx.font = "600 11px 'Inter', system-ui, sans-serif";
    ctx.fillStyle = `rgba(248,248,252,${0.35 + conf * 0.35})`;
    ctx.fillText("BPM", 0, 50);

    // tiny phase indicator: filled arc that completes once per beat
    if (a.tempoBpm > 30 && this.lastTempoMark > 0) {
      const periodMs = 60000 / a.tempoBpm;
      const phase = ((performance.now() - this.lastTempoMark) % periodMs) / periodMs;
      ctx.strokeStyle = `hsla(${this.hueSmooth} 70% 70% / ${0.2 + conf * 0.4})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 70, 14, -Math.PI / 2, -Math.PI / 2 + phase * Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawBeatFlash() {
    if (this.beatPulse < 0.04) return;
    const ctx = this.ctx;
    ctx.fillStyle = `hsla(${this.hueSmooth} 60% 70% / ${this.beatPulse * 0.05})`;
    ctx.fillRect(0, 0, this.w, this.h);

    // hot vertical line at the playhead
    const x = this.specX0 + this.specW;
    ctx.fillStyle = `hsla(${this.hueSmooth} 80% 80% / ${this.beatPulse * 0.85})`;
    ctx.fillRect(x - 1, this.specY0, 2, this.specH);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // FFT bins are log-spaced from F_MIN to F_MAX. Y in spectrogram with low
  // frequencies at the bottom matches the spectrogram convention.
  _freqToYInSpec(freq) {
    const t = Math.log(freq / F_MIN) / Math.log(F_MAX / F_MIN);
    return this.specH * (1 - clamp(t, 0, 1));
  }
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function approachAngle(current, target, k) {
  let d = target - current;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return (current + d * k + 360) % 360;
}
