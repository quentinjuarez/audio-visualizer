export class AudioEngine {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.ws = null;
    this.isReady = false;

    // Buffers de données
    this.dataArrayTime = null;
    this.dataArrayFreq = null;
  }

  init() {
    // 1. Création immédiate du contexte
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContext();

    // 2. Setup Analyseur
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    const bufferLength = this.analyser.frequencyBinCount;
    this.dataArrayTime = new Uint8Array(bufferLength);
    this.dataArrayFreq = new Uint8Array(bufferLength);

    this.isReady = true;

    // 3. Lancer la connexion WS (avec retry auto)
    this.connectWebSocket();
  }

  connectWebSocket() {
    console.log('AudioEngine: Connecting to WS...');
    this.ws = new WebSocket(import.meta.env.VITE_AUDIO_WS_URL);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('AudioEngine: WS Connected ✅');
    };

    this.ws.onmessage = (event) => {
      if (!this.isReady) return;
      this.processAudioChunk(event.data);
    };

    this.ws.onclose = () => {
      console.warn('AudioEngine: WS Disconnected ❌. Retrying in 3s...');
      setTimeout(() => this.connectWebSocket(), 3000); // Retry infini
    };

    this.ws.onerror = (err) => {
      console.error('AudioEngine: WS Error', err);
      this.ws.close(); // Force le close pour déclencher le retry
    };
  }

  // Appelée quand l'utilisateur clique (si le navigateur a bloqué le son)
  async resumeContext() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
      console.log('AudioContext: Resumed 🔊');
    }
  }

  processAudioChunk(rawBuffer) {
    if (this.audioContext.state === 'suspended') return; // On ne traite pas si c'est en pause

    const int16View = new Int16Array(rawBuffer);
    const float32View = new Float32Array(int16View.length);

    for (let i = 0; i < int16View.length; i++) {
      float32View[i] = int16View[i] / 32768.0;
    }

    const audioBuffer = this.audioContext.createBuffer(
      1,
      float32View.length,
      44100,
    );
    audioBuffer.copyToChannel(float32View, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.analyser);
    source.start();
  }

  getTimeDomainData() {
    if (!this.isReady) return new Uint8Array(0);
    this.analyser.getByteTimeDomainData(this.dataArrayTime);
    return this.dataArrayTime;
  }

  getFrequencyData() {
    if (!this.isReady) return new Uint8Array(0);
    this.analyser.getByteFrequencyData(this.dataArrayFreq);
    return this.dataArrayFreq;
  }
}
