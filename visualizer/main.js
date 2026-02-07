import { AudioEngine } from './audio-engine.js';
import { Renderer } from './renderer.js';

// DOM Elements
const canvas = document.getElementById('canvas');
const overlay = document.getElementById('start-overlay'); // Nouveau
const btnMode = document.getElementById('btn-mode');

// Instances
const audioEngine = new AudioEngine();
const renderer = new Renderer(canvas);

let currentMode = 'TIME';

// --- INITIALISATION ---
// On tente de démarrer tout de suite
audioEngine.init();
renderer.resize();

// Boucle de rendu immédiate
requestAnimationFrame(renderLoop);

// Gestion du blocage navigateur (Autoplay Policy)
checkAudioState();

function checkAudioState() {
  // Si le contexte est suspendu (bloqué), on affiche l'overlay
  if (audioEngine.audioContext.state === 'suspended') {
    overlay.style.display = 'flex';
  } else {
    overlay.style.display = 'none';
  }
}

// Interaction utilisateur (pour débloquer l'audio)
document.addEventListener('click', async () => {
  await audioEngine.resumeContext();
  checkAudioState(); // Cache l'overlay si c'est bon
});

// --- LOGIQUE VISUELLE ---

// Resize
window.addEventListener('resize', () => renderer.resize());

// Changement de mode
btnMode.addEventListener('click', (e) => {
  e.stopPropagation(); // Évite de déclencher le click global inutilement
  currentMode = currentMode === 'TIME' ? 'FREQ' : 'TIME';
  btnMode.innerText = `MODE: ${currentMode}`;
});

// Boucle d'animation
function renderLoop() {
  requestAnimationFrame(renderLoop);

  renderer.clear();

  if (currentMode === 'TIME') {
    renderer.drawWaveform(audioEngine.getTimeDomainData());
  } else {
    renderer.drawFrequencies(audioEngine.getFrequencyData());
  }
}
