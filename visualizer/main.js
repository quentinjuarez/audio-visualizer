const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const btnMode = document.getElementById('btn-mode');
const modeText = document.getElementById('mode-text');

// Configuration
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

let mode = 'REALTIME'; // ou 'FREQUENCY'
let audioData = new Uint8Array(0);

// WebSocket Setup
const ws = new WebSocket('ws://localhost:3000');
ws.binaryType = 'arraybuffer';

// Audio Context pour l'analyse (Fake audio processing pour convertir le buffer brut en FFT)
// Note: Idéalement on stream dans un AudioContext, ici on simule pour l'affichage visuel
// Basé sur les données brutes reçues (PCM 16bit)
let rawDataBuffer = [];

ws.onmessage = (event) => {
  // Conversion buffer ArrayBuffer -> Int16Array
  const int16View = new Int16Array(event.data);
  // Normalisation simple pour l'affichage (-1 to 1 -> 0 to 255 approx)
  audioData = int16View;
};

// --- RENDER LOOP ---
function draw() {
  requestAnimationFrame(draw);

  // 1. Fade effect (Trace / Retenance)
  ctx.fillStyle = 'rgba(5, 0, 16, 0.2)'; // Fond sombre semi-transparent pour le trail
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 2. Glitch Offset aléatoire
  const glitchX = Math.random() > 0.95 ? (Math.random() - 0.5) * 20 : 0;

  ctx.save();
  ctx.translate(glitchX, 0); // Applique le glitch horizontal

  ctx.lineWidth = 2;
  const centerY = canvas.height / 2;

  if (mode === 'REALTIME') {
    drawWaveform(centerY);
  } else {
    drawFrequency(centerY);
  }

  ctx.restore();

  // 3. Chromatic Aberration (Copie simple décalée)
  if (Math.random() > 0.9) {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    ctx.putImageData(imageData, -5, 0); // Décalage RGB rouge/bleu simulé
  }
}

function drawWaveform(centerY) {
  ctx.beginPath();
  // Couleur principale NEON CYAN
  ctx.strokeStyle = '#0ff';
  ctx.shadowBlur = 10;
  ctx.shadowColor = '#0ff';

  const sliceWidth = canvas.width / (audioData.length / 4); // Downsample pour perf
  let x = 0;

  for (let i = 0; i < audioData.length; i += 4) {
    const v = audioData[i] / 32768.0; // 16bit int max
    const y = centerY + v * (canvas.height / 2);

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);

    x += sliceWidth;
  }
  ctx.stroke();

  // Mirror effect (Reflet sol)
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255, 0, 255, 0.3)'; // Magenta faible
  ctx.shadowBlur = 0;
  for (let i = 0; i < audioData.length; i += 8) {
    const v = audioData[i] / 32768.0;
    const y = centerY + v * (canvas.height / 2);
    // Inversion et décalage vers le bas
    ctx.lineTo(x - (i / 4) * sliceWidth, canvas.height - (y - centerY) + 20);
  }
  ctx.stroke();
}

function drawFrequency(centerY) {
  // Simulation FFT basique sur les données brutes (pour l'effet visuel)
  const barWidth = canvas.width / 100;
  let x = 0;

  for (let i = 0; i < 100; i++) {
    // Prend un échantillon au hasard ou séquentiel
    const index = Math.floor(i * (audioData.length / 100));
    const val = Math.abs(audioData[index] || 0) / 32768.0;
    const barHeight = val * canvas.height;

    // Couleur dynamique (Bas: Magenta, Haut: Cyan)
    const r = 255 - i * 2;
    const g = i * 2;
    const b = 255;

    ctx.fillStyle = `rgb(${r},0,${b})`;
    ctx.shadowBlur = 15;
    ctx.shadowColor = `rgb(${r},0,${b})`;

    // Dessin barre vers le haut
    ctx.fillRect(x, canvas.height - barHeight, barWidth - 2, barHeight);

    x += barWidth;
  }
}

// Controls
btnMode.addEventListener('click', () => {
  mode = mode === 'REALTIME' ? 'FREQUENCY' : 'REALTIME';
  modeText.innerText = mode;
});

// Resize handler
window.addEventListener('resize', () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});

// Start loop
draw();
