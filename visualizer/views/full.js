import { Visualizer } from "../ui/visualizer.js";

/**
 * Bridges a JSON frame from the Python listener to the property shape
 * that Visualizer reads: beat, beatStrength, centroid, rms, envelopes, fft, waveform.
 *
 * All heavy analysis is done in Python. This class is a pure data mapping layer —
 * the only computation here is attack/release smoothing on band envelopes so
 * the canvas animation doesn't strobe at the listener's ~22 fps frame rate.
 */
class FrameAdapter {
  constructor() {
    this.beat = false;
    this.beatStrength = 0;
    this.centroid = 0; // 0-1, spectral brightness
    this.rms = 0; // 0-1, overall loudness

    // Smoothed per-band energies — Python names mapped to camelCase
    this.envelopes = { bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0 };

    // Raw arrays passed through from Python (no conversion)
    this.fft = new Float32Array(64).fill(0); // 0-1, log-spaced 20-20kHz
    this.waveform = new Float32Array(256).fill(0.5); // 0-1, centred at 0.5
  }

  ingest(frame) {
    this.beat = !!frame.beat;
    this.beatStrength = frame.beat_strength ?? 0;
    this.centroid = frame.centroid ?? 0;
    this.rms = frame.rms ?? 0;

    // Apply attack/release smoothing so band visuals don't flicker between frames
    const b = frame.bands ?? {};
    this._smooth("bass", b.bass ?? 0);
    this._smooth("lowMid", b.low_mid ?? 0);
    this._smooth("mid", b.mid ?? 0);
    this._smooth("highMid", b.high_mid ?? 0);
    this._smooth("treble", b.high ?? 0);

    if (frame.fft) this.fft = frame.fft;
    if (frame.waveform) this.waveform = frame.waveform;
  }

  // Fast attack (snappy on hits), slow release (visuals don't drop to zero instantly)
  _smooth(key, target) {
    const prev = this.envelopes[key];
    const coef = target > prev ? 0.45 : 0.06;
    this.envelopes[key] = prev + (target - prev) * coef;
  }
}

export class FullView {
  constructor(canvas) {
    this._adapter = new FrameAdapter();
    this._viz = new Visualizer(canvas, this._adapter);

    const ro = new ResizeObserver(() => this._viz.resize());
    ro.observe(canvas.parentElement);

    this._tick();
  }

  _tick() {
    requestAnimationFrame(() => this._tick());
    this._viz.draw();
  }

  update(frame) {
    this._adapter.ingest(frame);
  }
}
