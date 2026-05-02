import { Visualizer } from "../ui/visualizer.js";

/**
 * Maps the JSON frame produced by listener.py to the camelCase property
 * shape that Visualizer reads. Adds attack/release smoothing on band
 * envelopes so band-driven visuals don't flicker at the listener's ~43 fps
 * frame rate. `revision` increments on every ingest so the visualizer can
 * deposit exactly one new spectrogram column per audio frame.
 */
class FrameAdapter {
  constructor() {
    this.revision = 0;

    // Listener tells us when its noise gate is closed. The heartbeat frames
    // it sends in that state are zeroed, but the explicit flag lets the
    // header show "WAITING / NO SIGNAL" rather than an over-confident "LIVE".
    this.silent = false;

    // Loudness
    this.rms = 0;
    this.db = -90;
    this.peak = 0;

    // Beat / tempo
    this.beat = false;
    this.beatStrength = 0;
    this.beatSource = "none";
    this.tempoBpm = 0;
    this.tempoConfidence = 0;
    this.kickEnergy = 0;

    // Spectral descriptors (all 0–1)
    this.centroid = 0;
    this.flatness = 0;
    this.rolloff = 0;
    this.bandwidth = 0;
    this.zcr = 0;
    this.flux = 0;

    // Bands — raw + smoothed envelope
    this.bandsRaw = { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, high: 0, air: 0 };
    this.envelopes = { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, high: 0, air: 0 };

    // Identity
    this.dominantBand = "mid";
    this.energyZoneHue = 200;

    // Spectrum / waveform
    this.fft = new Float32Array(64);
    this.waveform = new Float32Array(256).fill(0.5);
  }

  ingest(frame) {
    this.silent = !!frame.silent;
    this.rms = frame.rms ?? 0;
    this.db = frame.db ?? -90;
    this.peak = frame.peak ?? 0;

    this.beat = !!frame.beat;
    this.beatStrength = frame.beat_strength ?? 0;
    this.beatSource = frame.beat_source ?? "none";
    this.tempoBpm = frame.tempo_bpm ?? 0;
    this.tempoConfidence = frame.tempo_confidence ?? 0;
    this.kickEnergy = frame.kick_energy ?? 0;

    this.centroid = frame.centroid ?? 0;
    this.flatness = frame.flatness ?? 0;
    this.rolloff = frame.rolloff ?? 0;
    this.bandwidth = frame.bandwidth ?? 0;
    this.zcr = frame.zcr ?? 0;
    this.flux = frame.flux ?? 0;

    const b = frame.bands ?? {};
    this.bandsRaw.sub = b.sub ?? 0;
    this.bandsRaw.bass = b.bass ?? 0;
    this.bandsRaw.lowMid = b.low_mid ?? 0;
    this.bandsRaw.mid = b.mid ?? 0;
    this.bandsRaw.highMid = b.high_mid ?? 0;
    this.bandsRaw.high = b.high ?? 0;
    this.bandsRaw.air = b.air ?? 0;
    for (const k of Object.keys(this.bandsRaw)) this._smooth(k, this.bandsRaw[k]);

    this.dominantBand = this._toCamel(frame.dominant_band ?? "mid");
    this.energyZoneHue = frame.energy_zone_hue ?? 200;

    if (frame.fft) this.fft = frame.fft;
    if (frame.waveform) this.waveform = frame.waveform;

    this.revision++;
  }

  _smooth(key, target) {
    const prev = this.envelopes[key];
    const coef = target > prev ? 0.45 : 0.06;
    this.envelopes[key] = prev + (target - prev) * coef;
  }

  _toCamel(name) {
    if (name === "low_mid") return "lowMid";
    if (name === "high_mid") return "highMid";
    return name;
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
