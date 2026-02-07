export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;
  }

  resize() {
    this.width = this.canvas.width = window.innerWidth;
    this.height = this.canvas.height = window.innerHeight;
  }

  clear() {
    this.ctx.fillStyle = '#000000'; // Fond noir uni
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  // Mode 1: Oscilloscope (Ligne temporelle)
  drawWaveform(data) {
    if (!data || data.length === 0) return;

    this.ctx.lineWidth = 2;
    this.ctx.strokeStyle = '#ffffff'; // Ligne blanche simple
    this.ctx.beginPath();

    const sliceWidth = this.width / data.length;
    let x = 0;

    for (let i = 0; i < data.length; i++) {
      // data[i] est entre 0 et 255. 128 est le "silence" (milieu)
      const v = data[i] / 128.0;
      const y = (v * this.height) / 2;

      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);

      x += sliceWidth;
    }

    this.ctx.lineTo(this.width, this.height / 2);
    this.ctx.stroke();
  }

  // Mode 2: Analyseur de spectre (Barres de fréquences)
  drawFrequencies(data) {
    if (!data || data.length === 0) return;

    // On ne dessine souvent que la moitié inférieure des fréquences (basses/médiums) car les très hautes sont souvent vides
    const bufferLength = data.length;
    const barWidth = (this.width / bufferLength) * 2.5;
    let x = 0;

    this.ctx.fillStyle = '#ffffff'; // Barres blanches

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (data[i] / 255) * this.height; // Normalisation hauteur

      // Dessin simple
      this.ctx.fillRect(x, this.height - barHeight, barWidth, barHeight);

      x += barWidth + 1; // +1 pour un petit espace entre les barres
    }
  }
}
