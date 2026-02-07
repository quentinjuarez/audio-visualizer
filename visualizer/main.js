import { AudioEngine } from './audio-engine.js';
import { Renderer } from './renderer.js';

// DOM Elements
const canvas = document.getElementById('canvas');
const startBtn = document.getElementById('start-btn');
const switchBtn = document.getElementById('switch-mode');

// Instances
const audioEngine = new AudioEngine();
const renderer = new Renderer(canvas);

let currentMode = 'TIME'; // ou 'FREQ'
let animationId;

// 1. Initialisation (Clic requis par les navigateurs pour l'AudioContext)
startBtn.addEventListener('click', async () => {
  await audioEngine.init();
  startBtn.style.display = 'none'; // Cacher le bouton start
  switchBtn.style.display = 'inline-block';

  // Lancer la boucle de rendu
  renderLoop();
});

// 2. Gestion du redimensionnement
window.addEventListener('resize', () => renderer.resize());
renderer.resize(); // Premier appel

// 3. Changement de mode
switchBtn.addEventListener('click', () => {
  currentMode = currentMode === 'TIME' ? 'FREQ' : 'TIME';
  switchBtn.innerText = `MODE: ${currentMode}`;
});

// 4. Boucle d'animation (60fps)
function renderLoop() {
  animationId = requestAnimationFrame(renderLoop);

  // Toujours nettoyer l'écran avant de dessiner
  renderer.clear();

  // Récupérer et dessiner selon le mode
  if (currentMode === 'TIME') {
    const timeData = audioEngine.getTimeDomainData();
    renderer.drawWaveform(timeData);
  } else {
    const freqData = audioEngine.getFrequencyData();
    renderer.drawFrequencies(freqData);
  }
}
