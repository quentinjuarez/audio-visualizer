export class Visualizer {
  constructor(canvas, analyzer) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyzer = analyzer;
    this.particles = [];
    this.hue = 200;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width = window.innerWidth + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.cx = this.w / 2;
    this.cy = this.h / 2;
  }

  emitParticles(strength) {
    const count = Math.floor(40 + strength * 80);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 5 * (1 + strength);
      this.particles.push({
        x: this.cx,
        y: this.cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        hue: this.hue + (Math.random() * 80 - 40),
        size: 1 + Math.random() * 2,
      });
    }
  }

  draw() {
    const a = this.analyzer;
    const ctx = this.ctx;

    // Hue follows spectral centroid, low-passed so it doesn't flicker.
    const targetHue = a.centroid * 320;
    this.hue += (targetHue - this.hue) * 0.04;

    // Motion-blur clear: low-alpha black wash for trails.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.fillRect(0, 0, this.w, this.h);

    if (a.beat) this.emitParticles(a.beatStrength);

    this.drawParticles();
    this.drawRadialSpectrum();
    this.drawCorePulse();
    this.drawWaveformRing();
    this.drawHUD();
  }

  drawParticles() {
    const ctx = this.ctx;
    const next = [];
    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.97;
      p.vy *= 0.97;
      p.life -= 0.011;
      if (p.life <= 0) continue;

      ctx.fillStyle = `hsla(${p.hue}, 85%, 65%, ${p.life})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fill();
      next.push(p);
    }
    this.particles = next;
  }

  drawRadialSpectrum() {
    const a = this.analyzer;
    const ctx = this.ctx;
    const bins = a.freqData.length;
    const usable = Math.floor(bins * 0.55); // ignore very high bins
    const barCount = 200;
    const baseRadius = Math.min(this.w, this.h) * 0.17;
    const maxBarHeight = Math.min(this.w, this.h) * 0.27;

    ctx.save();
    ctx.translate(this.cx, this.cy);
    ctx.lineCap = 'round';

    for (let i = 0; i < barCount; i++) {
      const t = i / barCount;
      // Log-ish bin remap: more resolution in lows.
      const idx = Math.floor(usable * Math.pow(t, 2.2));
      const v = (a.freqData[idx] - a.minDb) / a.dbRange;
      const norm = v < 0 ? 0 : v > 1 ? 1 : v;
      const len = Math.pow(norm, 1.8) * maxBarHeight;
      if (len < 1) continue;

      const angle = t * Math.PI * 2 - Math.PI / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const x1 = cos * baseRadius;
      const y1 = sin * baseRadius;
      const x2 = cos * (baseRadius + len);
      const y2 = sin * (baseRadius + len);

      const h = (this.hue + t * 120) % 360;
      ctx.strokeStyle = `hsla(${h}, 85%, 62%, 0.92)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.restore();
  }

  drawCorePulse() {
    const a = this.analyzer;
    const ctx = this.ctx;
    const baseRadius = Math.min(this.w, this.h) * 0.17;
    const bass = a.envelopes.bass;
    const treble = a.envelopes.treble;
    const pulseRadius = baseRadius * (0.6 + bass * 0.7);

    ctx.save();
    ctx.translate(this.cx, this.cy);

    // Glow.
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, pulseRadius);
    grad.addColorStop(0, `hsla(${this.hue}, 90%, 70%, ${0.35 + bass * 0.5})`);
    grad.addColorStop(1, `hsla(${this.hue}, 90%, 30%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, pulseRadius, 0, Math.PI * 2);
    ctx.fill();

    // Treble-driven inner ring.
    ctx.strokeStyle = `hsla(${(this.hue + 60) % 360}, 90%, 75%, ${0.4 + treble * 0.6})`;
    ctx.lineWidth = 1 + treble * 4;
    ctx.beginPath();
    ctx.arc(0, 0, baseRadius * 0.4, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  drawWaveformRing() {
    const a = this.analyzer;
    const ctx = this.ctx;
    const data = a.timeData;
    const baseRadius = Math.min(this.w, this.h) * 0.17;
    const amp = baseRadius * 0.18;

    ctx.save();
    ctx.translate(this.cx, this.cy);
    ctx.strokeStyle = `hsla(${(this.hue + 180) % 360}, 80%, 70%, 0.5)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(data.length / 360));
    let first = true;
    for (let i = 0; i < data.length; i += step) {
      const t = i / data.length;
      const angle = t * Math.PI * 2;
      const r = baseRadius * 0.78 + data[i] * amp;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (first) { ctx.moveTo(x, y); first = false; }
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  drawHUD() {
    const a = this.analyzer;
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '11px monospace';
    const bar = (v) => '█'.repeat(Math.max(0, Math.min(20, Math.floor(v * 20))));
    const lines = [
      `BASS    ${bar(a.envelopes.bass)}`,
      `LOW-MID ${bar(a.envelopes.lowMid)}`,
      `MID     ${bar(a.envelopes.mid)}`,
      `HI-MID  ${bar(a.envelopes.highMid)}`,
      `TREBLE  ${bar(a.envelopes.treble)}`,
      ``,
      `RMS     ${a.rms.toFixed(3)}`,
      `BRIGHT  ${a.centroid.toFixed(3)}`,
      `BEAT    ${a.beat ? '●' : '·'}  ×${a.beatStrength.toFixed(2)}`,
    ];
    lines.forEach((l, i) => ctx.fillText(l, 20, this.h - 150 + i * 14));
  }
}
