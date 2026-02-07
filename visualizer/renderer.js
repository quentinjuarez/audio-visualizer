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
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  drawWaveform(data) {
    if (!data || data.length === 0) return;

    this.ctx.lineWidth = 2;
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.beginPath();

    const sliceWidth = this.width / data.length;
    let x = 0;

    for (let i = 0; i < data.length; i++) {
      const v = data[i] / 128.0;
      const y = (v * this.height) / 2;

      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);

      x += sliceWidth;
    }
    this.ctx.stroke();
  }

  drawFrequencies(data) {
    if (!data || data.length === 0) return;

    // --- CONFIGURATION DU RENDU ---
    const barCount = 120; // Nombre de barres affichées (60 à 120 est bien)
    const gap = 2; // Espace entre les barres
    const barWidth = this.width / barCount - gap;

    // On ignore les fréquences au-dessus de ~16kHz (inutiles visuellement)
    // data.length est souvent 1024. On utilise 80% du buffer.
    const usableDataLength = Math.floor(data.length * 0.85);

    this.ctx.fillStyle = '#ffffff';

    for (let i = 0; i < barCount; i++) {
      // 1. CALCUL LOGARITHMIQUE DE L'INDEX
      // On veut piocher plus de données dans les basses (début du tableau)
      // et regrouper les aigus (fin du tableau).
      // La formule magique : index = total * (i / total)^scale
      // scale = 2.5 donne une bonne distribution log

      const percent = i / barCount;

      // Index de début de la "tranche" de fréquence pour cette barre
      const startIndex = Math.floor(usableDataLength * Math.pow(percent, 2.5));

      // Index de fin (la barre suivante)
      const nextPercent = (i + 1) / barCount;
      const endIndex = Math.floor(
        usableDataLength * Math.pow(nextPercent, 2.5),
      );

      // 2. MOYENNE (AVERAGE) DES VALEURS DANS CETTE TRANCHE
      let sum = 0;
      let count = 0;

      // On parcourt les données brutes entre startIndex et endIndex
      // On s'assure d'avoir au moins 1 sample (Math.max)
      for (let j = startIndex; j < Math.max(endIndex, startIndex + 1); j++) {
        // data[j] est entre 0 et 255
        sum += data[j];
        count++;
      }

      const average = sum / count;

      // 3. NORMALISATION & EFFETS (Min/Max fix)
      // Noise floor : On coupe tout ce qui est en dessous de 50 (bruit de fond)
      // Scale : On met au carré pour rendre les pics plus dynamiques

      let val = (average - 30) / (255 - 30); // Normalisation 0.0 à 1.0 avec seuil bas à 30
      if (val < 0) val = 0;

      // Application d'une courbe de puissance (ex: carré) pour contraster
      // Les sons faibles deviennent très petits, les forts restent forts.
      const barHeight = Math.pow(val, 2) * this.height;

      const x = i * (barWidth + gap);
      const y = this.height - barHeight;

      // Dessin
      if (barHeight > 0) {
        this.ctx.fillRect(x, y, barWidth, barHeight);
      }
    }
  }
}
