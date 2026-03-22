// Color per frequency band
const BAND_COLORS = {
  sub: "#ff2244",
  bass: "#ff6600",
  low_mid: "#ffcc00",
  mid: "#22cc66",
  high_mid: "#22aaff",
  high: "#8844ff",
  air: "#dd22ff",
};

const BANDS = ["sub", "bass", "low_mid", "mid", "high_mid", "high", "air"];

export class DebugView {
  constructor() {
    this._waveCanvas = document.getElementById("waveform-canvas");
    this._fftCanvas = document.getElementById("fft-canvas");
    this._wCtx = this._waveCanvas.getContext("2d");
    this._fCtx = this._fftCanvas.getContext("2d");

    this._smoothFlux = 0;
    this._beatTimeout = null;
    this._peakSmooth = 0.01; // for waveform auto-gain
    this._smoothBins = []; // per-bin temporal smoothing

    this._buildBandBars();
    this._resizeCanvases();
    window.addEventListener("resize", () => this._resizeCanvases());
  }

  _buildBandBars() {
    const grid = document.getElementById("bands-grid");
    grid.innerHTML = "";
    for (const name of BANDS) {
      const col = document.createElement("div");
      col.className = "band-col";
      col.innerHTML = `
        <div class="band-value" id="bv-${name}">0.00</div>
        <div class="band-bar-wrap">
          <div class="band-bar" id="bb-${name}" style="height:0%;background:${BAND_COLORS[name]}"></div>
        </div>
        <div class="band-name">${name}</div>
      `;
      grid.appendChild(col);
    }
  }

  _resizeCanvases() {
    for (const c of [this._waveCanvas, this._fftCanvas]) {
      const rect = c.parentElement.getBoundingClientRect();
      c.width = Math.floor(rect.width);
      c.height = Math.floor(rect.height - 22); // subtract panel-title height
    }
  }

  // Frequency ticks drawn on the FFT canvas axis
  // Each entry: [Hz, label]
  static get FREQ_TICKS() {
    return [
      [20, "20"],
      [50, "50"],
      [100, "100"],
      [200, "200"],
      [500, "500"],
      [1000, "1k"],
      [2000, "2k"],
      [5000, "5k"],
      [10000, "10k"],
      [20000, "20k"],
    ];
  }

  // Map a frequency (Hz) to a 0-1 position on the log-spaced x axis
  static _freqToX(hz) {
    const LOG_MIN = Math.log10(20);
    const LOG_MAX = Math.log10(20000);
    return (
      (Math.log10(Math.max(20, Math.min(20000, hz))) - LOG_MIN) /
      (LOG_MAX - LOG_MIN)
    );
  }

  // ── Public ──────────────────────────────────────────────────────────────

  /** @param {object} frame — parsed JSON from listener */
  update(frame) {
    this._updateStatus(frame);
    this._updateBands(frame.bands);
    this._updateDescriptors(frame);
    this._drawWaveform(frame.waveform, frame.peak);
    this._drawFFT(frame.fft);
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────

  _updateStatus(frame) {
    _set("val-rms", frame.rms.toFixed(3));
    _set("val-db", frame.db.toFixed(1) + " dB");
    _set("val-peak", frame.peak.toFixed(3));
    _set("val-dominant", frame.dominant_band.toUpperCase());
    _set("val-beat-source", (frame.beat_source ?? "none").toUpperCase());

    const tempoBpm = Number(frame.tempo_bpm ?? 0);
    const tempoConfidence = Number(frame.tempo_confidence ?? 0);
    _set("val-tempo", `${tempoBpm.toFixed(1)} BPM`);
    _set("val-tempo-conf", `${Math.round(tempoConfidence * 100)}%`);

    const hue = frame.energy_zone_hue;
    _set("val-hue", hue + "°");
    document.getElementById("hue-swatch").style.background =
      `hsl(${hue},80%,55%)`;

    if (frame.beat) {
      const el = document.getElementById("beat-flash");
      el.classList.add("active");
      clearTimeout(this._beatTimeout);
      this._beatTimeout = setTimeout(() => el.classList.remove("active"), 100);
    }
  }

  _updateBands(bands) {
    for (const [name, val] of Object.entries(bands)) {
      const bar = document.getElementById(`bb-${name}`);
      const lbl = document.getElementById(`bv-${name}`);
      if (bar) bar.style.height = `${(val * 100).toFixed(1)}%`;
      if (lbl) lbl.textContent = val.toFixed(2);
    }
  }

  _updateDescriptors(frame) {
    // Smooth flux so the bar doesn't flicker wildly
    this._smoothFlux += (frame.flux - this._smoothFlux) * 0.3;

    _setBar("centroid", frame.centroid, 1);
    _setBar("rolloff", frame.rolloff, 1);
    _setBar("bandwidth", frame.bandwidth ?? 0, 1);
    _setBar("flatness", frame.flatness ?? 0, 1);
    _setBar("zcr", frame.zcr ?? 0, 1);
    _setBar("tempo-confidence", frame.tempo_confidence ?? 0, 1);
    _setBar("flux", this._smoothFlux, 2); // flux can exceed 1
    _setBar("beat-strength", frame.beat_strength, 1);
  }

  // ── Canvas drawing ───────────────────────────────────────────────────────

  _drawWaveform(waveform, peak) {
    const ctx = this._wCtx;
    const W = this._waveCanvas.width;
    const H = this._waveCanvas.height;

    ctx.fillStyle = "#0d0d0d";
    ctx.fillRect(0, 0, W, H);

    // Zero line
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    if (!waveform?.length) return;

    // Auto-gain: fast attack (instant), slow decay (~1.5 s to halve)
    if (peak > this._peakSmooth) {
      this._peakSmooth = peak;
    } else {
      this._peakSmooth += (peak - this._peakSmooth) * 0.015;
    }
    this._peakSmooth = Math.max(this._peakSmooth, 0.001);
    // Scale so the peak amplitude uses 90% of the canvas height
    const scale = (H * 0.45) / this._peakSmooth;

    ctx.strokeStyle = "#22cc66";
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const sliceW = W / waveform.length;
    for (let i = 0; i < waveform.length; i++) {
      // waveform[i] is 0–1; 0.5 = silence centre
      const amplitude = waveform[i] - 0.5;
      const y = H / 2 - amplitude * scale;
      i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * sliceW, y);
    }
    ctx.stroke();
  }

  _drawFFT(bins) {
    const ctx = this._fCtx;
    const W = this._fftCanvas.width;
    const H = this._fftCanvas.height;
    const AXIS_H = 18; // px reserved at bottom for frequency labels
    const CHART_H = H - AXIS_H;

    ctx.fillStyle = "#0d0d0d";
    ctx.fillRect(0, 0, W, H);

    if (!bins?.length) return;

    // Temporal smoothing per bin: fast attack, slow decay
    const ATTACK = 0.8;
    const DECAY = 0.15;
    if (this._smoothBins.length !== bins.length) {
      this._smoothBins = new Float32Array(bins.length);
    }
    for (let i = 0; i < bins.length; i++) {
      const v = bins[i];
      this._smoothBins[i] =
        v > this._smoothBins[i]
          ? this._smoothBins[i] + (v - this._smoothBins[i]) * ATTACK
          : this._smoothBins[i] + (v - this._smoothBins[i]) * DECAY;
    }

    // Pre-compute x positions (bin centres)
    const xs = Float32Array.from(
      { length: bins.length },
      (_, i) => ((i + 0.5) / bins.length) * W,
    );
    const ys = Float32Array.from(
      this._smoothBins,
      (v) => CHART_H - v * CHART_H,
    );

    // Filled gradient area
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "hsl(240,90%,50%)");
    grad.addColorStop(0.2, "hsl(180,90%,50%)");
    grad.addColorStop(0.45, "hsl(120,90%,50%)");
    grad.addColorStop(0.7, "hsl(60,90%,50%)");
    grad.addColorStop(1, "hsl(0,90%,50%)");

    ctx.beginPath();
    ctx.moveTo(0, CHART_H);
    ctx.lineTo(xs[0], ys[0]);
    for (let i = 1; i < bins.length; i++) {
      // Smooth curve through bin centres using quadratic bezier midpoints
      const mx = (xs[i - 1] + xs[i]) / 2;
      const my = (ys[i - 1] + ys[i]) / 2;
      ctx.quadraticCurveTo(xs[i - 1], ys[i - 1], mx, my);
    }
    ctx.lineTo(xs[bins.length - 1], ys[bins.length - 1]);
    ctx.lineTo(W, CHART_H);
    ctx.closePath();

    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Bright outline on top of the filled area
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 1; i < bins.length; i++) {
      const mx = (xs[i - 1] + xs[i]) / 2;
      const my = (ys[i - 1] + ys[i]) / 2;
      ctx.quadraticCurveTo(xs[i - 1], ys[i - 1], mx, my);
    }
    ctx.lineTo(xs[bins.length - 1], ys[bins.length - 1]);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Axis separator
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, CHART_H);
    ctx.lineTo(W, CHART_H);
    ctx.stroke();

    // Frequency tick marks + labels
    ctx.font = "9px Courier New";
    ctx.textAlign = "center";
    for (const [hz, label] of DebugView.FREQ_TICKS) {
      const x = Math.floor(DebugView._freqToX(hz) * W);
      // Tick line
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, CHART_H);
      ctx.lineTo(x, CHART_H + 4);
      ctx.stroke();
      // Label
      ctx.fillStyle = "#555";
      ctx.fillText(label, x, H - 2);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _set(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function _setBar(id, val, max) {
  const pct = Math.min(100, (val / max) * 100).toFixed(1);
  const bar = document.getElementById(`bar-${id}`);
  const lbl = document.getElementById(`val-${id}`);
  if (bar) bar.style.width = pct + "%";
  if (lbl) lbl.textContent = val.toFixed(3);
}
