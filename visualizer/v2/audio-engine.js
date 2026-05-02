const SAMPLE_RATE = 44100;
const FFT_SIZE = 4096;

export class AudioEngine {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.ws = null;
    this.isReady = false;
  }

  init() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContext();

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.3;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;

    this.isReady = true;
    this.connectWebSocket();
  }

  connectWebSocket() {
    this.ws = new WebSocket(import.meta.env.VITE_AUDIO_WS_URL);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => console.log('v2: WS connected');
    this.ws.onmessage = (event) => {
      if (this.isReady) this.processAudioChunk(event.data);
    };
    this.ws.onclose = () => {
      console.warn('v2: WS disconnected, retrying in 3s');
      setTimeout(() => this.connectWebSocket(), 3000);
    };
    this.ws.onerror = () => this.ws.close();
  }

  async resumeContext() {
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  processAudioChunk(rawBuffer) {
    if (this.audioContext.state === 'suspended') return;

    const int16View = new Int16Array(rawBuffer);
    const float32View = new Float32Array(int16View.length);
    for (let i = 0; i < int16View.length; i++) {
      float32View[i] = int16View[i] / 32768.0;
    }

    const audioBuffer = this.audioContext.createBuffer(
      1,
      float32View.length,
      SAMPLE_RATE,
    );
    audioBuffer.copyToChannel(float32View, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.analyser);
    source.start();
  }
}
