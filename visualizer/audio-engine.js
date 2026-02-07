export class AudioEngine {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.ws = null;
    this.isReady = false;

    // Buffers pour stocker les données analysées
    this.dataArrayTime = null;
    this.dataArrayFreq = null;
  }

  async init() {
    // 1. Création du contexte audio (nécessite un clic utilisateur généralement)
    this.audioContext = new (
      window.AudioContext || window.webkitAudioContext
    )();

    // 2. Création de l'analyseur (C'est lui qui fait les maths FFT)
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048; // Résolution (plus haut = plus précis mais plus lent)
    this.analyser.smoothingTimeConstant = 0.8; // Lissage pour que ça soit moins nerveux

    // Préparation des tableaux de données
    const bufferLength = this.analyser.frequencyBinCount;
    this.dataArrayTime = new Uint8Array(bufferLength);
    this.dataArrayFreq = new Uint8Array(bufferLength);

    this.isReady = true;
    console.log('Audio Engine: Ready');

    // 3. Connexion WS
    this.connectWebSocket();
  }

  connectWebSocket() {
    this.ws = new WebSocket('ws://localhost:3000');
    this.ws.binaryType = 'arraybuffer';

    this.ws.onmessage = (event) => {
      if (!this.isReady) return;
      this.processAudioChunk(event.data);
    };
  }

  processAudioChunk(rawBuffer) {
    // Convertir les données brutes (PCM 16bit) en AudioBuffer jouable
    const int16View = new Int16Array(rawBuffer);
    const float32View = new Float32Array(int16View.length);

    // Normalisation (-1.0 à 1.0) pour l'AudioContext
    for (let i = 0; i < int16View.length; i++) {
      float32View[i] = int16View[i] / 32768.0;
    }

    // Créer une source audio éphémère
    const audioBuffer = this.audioContext.createBuffer(
      1,
      float32View.length,
      44100,
    );
    audioBuffer.copyToChannel(float32View, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;

    // Connecter la source à l'analyseur (mais PAS aux haut-parleurs pour éviter le larsen)
    source.connect(this.analyser);

    // Jouer immédiatement (pour que l'analyseur reçoive les données)
    source.start();
  }

  // Méthodes pour récupérer les données actuelles
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

  resume() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }
}
