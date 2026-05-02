import { AudioEngine } from './audio-engine.js';
import { Analyzer } from './analyzer.js';
import { Visualizer } from './visualizer.js';

const canvas = document.getElementById('canvas');
const overlay = document.getElementById('start-overlay');

const engine = new AudioEngine();
engine.init();

const analyzer = new Analyzer(engine.audioContext, engine.analyser);
const visualizer = new Visualizer(canvas, analyzer);

window.addEventListener('resize', () => visualizer.resize());

document.addEventListener('click', async () => {
  await engine.resumeContext();
  checkAudioState();
});

function checkAudioState() {
  overlay.style.display =
    engine.audioContext.state === 'suspended' ? 'flex' : 'none';
}
checkAudioState();

function loop() {
  requestAnimationFrame(loop);
  analyzer.update();
  visualizer.draw();
}
requestAnimationFrame(loop);
