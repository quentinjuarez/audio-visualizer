const BANDS = {
  bass:    [20,   140],
  lowMid:  [140,  400],
  mid:     [400,  1200],
  highMid: [1200, 3500],
  treble:  [3500, 12000],
};

export class Analyzer {
  constructor(audioContext, analyserNode) {
    this.ctx = audioContext;
    this.analyser = analyserNode;
    this.sampleRate = audioContext.sampleRate;
    this.binWidth = this.sampleRate / analyserNode.fftSize;

    this.freqData = new Float32Array(analyserNode.frequencyBinCount);
    this.timeData = new Float32Array(analyserNode.fftSize);

    this.minDb = analyserNode.minDecibels;
    this.maxDb = analyserNode.maxDecibels;
    this.dbRange = this.maxDb - this.minDb;

    // Hz ranges → bin index ranges
    this.bandBins = {};
    for (const [name, [lo, hi]] of Object.entries(BANDS)) {
      this.bandBins[name] = [
        Math.max(1, Math.floor(lo / this.binWidth)),
        Math.min(analyserNode.frequencyBinCount - 1, Math.ceil(hi / this.binWidth)),
      ];
    }

    // Smoothed energy per band (envelope follower).
    // Fast attack → snappy on hits; slow release → visuals don't strobe.
    this.envelopes = {};
    for (const name of Object.keys(BANDS)) this.envelopes[name] = 0;
    this.attack = 0.45;
    this.release = 0.06;

    // Adaptive beat detection on bass envelope.
    this.bassHistory = [];
    this.bassHistorySize = 43; // ~700ms @ 60fps
    this.beatCooldown = 0;
    this.beat = false;
    this.beatStrength = 0;

    this.rms = 0;
    this.centroid = 0; // 0..1, normalized to nyquist
  }

  update() {
    this.analyser.getFloatFrequencyData(this.freqData);
    this.analyser.getFloatTimeDomainData(this.timeData);

    // RMS from time domain (overall loudness, fast & cheap).
    let sumSq = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const s = this.timeData[i];
      sumSq += s * s;
    }
    this.rms = Math.sqrt(sumSq / this.timeData.length);

    // Per-band energy + spectral centroid in one pass.
    let totalEnergy = 0;
    let weightedFreq = 0;

    for (const name of Object.keys(BANDS)) {
      const [start, end] = this.bandBins[name];
      let sum = 0;
      let count = 0;
      for (let i = start; i <= end; i++) {
        const v = (this.freqData[i] - this.minDb) / this.dbRange;
        const norm = v < 0 ? 0 : v > 1 ? 1 : v;
        sum += norm;
        count++;
        totalEnergy += norm;
        weightedFreq += norm * (i * this.binWidth);
      }
      const energy = count > 0 ? sum / count : 0;

      const prev = this.envelopes[name];
      const coef = energy > prev ? this.attack : this.release;
      this.envelopes[name] = prev + (energy - prev) * coef;
    }

    if (totalEnergy > 0.0001) {
      const centroidHz = weightedFreq / totalEnergy;
      this.centroid = Math.min(1, centroidHz / (this.sampleRate / 2));
    }

    this.detectBeat();
  }

  detectBeat() {
    const bass = this.envelopes.bass;
    this.bassHistory.push(bass);
    if (this.bassHistory.length > this.bassHistorySize) this.bassHistory.shift();

    let avg = 0;
    for (const v of this.bassHistory) avg += v;
    avg /= this.bassHistory.length;

    if (this.beatCooldown > 0) this.beatCooldown--;

    // Hit if current bass is meaningfully above the rolling average,
    // gated on absolute energy and a refractory period (~133ms = max 450 BPM).
    const ratio = avg > 0 ? bass / avg : 0;
    this.beat = false;
    if (ratio > 1.35 && bass > 0.12 && this.beatCooldown === 0) {
      this.beat = true;
      this.beatStrength = Math.min(2, ratio - 1);
      this.beatCooldown = 8;
    }
  }
}
