const WebSocket = require('ws');

// --- CONFIGURATION ---
const WS_URL = 'ws://localhost:3000';
const SAMPLE_RATE = 44100;
const BUFFER_SIZE = 2048; // Taille du paquet (plus petit = plus fluide / plus grand = moins de charge)
const INTERVAL_MS = (BUFFER_SIZE / SAMPLE_RATE) * 1000;

let ws;
let time = 0; // Temps global pour la continuité de l'onde

function connect() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('📡 CONNECTED: Generating Retrowave Signal...');
    startStreaming();
  });

  ws.on('close', () => {
    console.log('❌ Disconnected. Reconnecting in 3s...');
    setTimeout(connect, 3000);
  });

  ws.on('error', (err) => {
    console.error('⚠️ Error:', err.message);
    ws.close();
  });
}

function startStreaming() {
  // Boucle d'envoi
  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(interval);
      return;
    }

    // Créer un buffer brut (16-bit PCM Mono)
    // 2 octets par sample
    const buffer = Buffer.alloc(BUFFER_SIZE * 2);

    for (let i = 0; i < BUFFER_SIZE; i++) {
      // Avancer le temps
      const t = time + i / SAMPLE_RATE;

      // --- SYNTHÈSE SONORE RETROWAVE ---

      // 1. KICK (Basse fréquence pulsée) - ~2Hz beat
      // Une onde sinus basse (60Hz) modulée par une enveloppe qui tape tous les ~0.5s
      const beatEnvelope = Math.max(0, Math.sin(t * Math.PI * 4)); // 2 beats par seconde
      const bass = Math.sin(t * 2 * Math.PI * 60) * beatEnvelope * 0.8;

      // 2. LEAD (Arpège rapide)
      // Fréquence qui change selon le temps
      const freq = 200 + Math.sin(t * 8) * 100;
      const lead = Math.sin(t * 2 * Math.PI * freq) * 0.3;

      // 3. GLITCH / NOISE (Bruit blanc aléatoire)
      // Apparait aléatoirement pour l'effet "Analog Glitch"
      const isGlitch = Math.random() > 0.99; // 1% de chance par sample
      const noise = isGlitch ? (Math.random() * 2 - 1) * 0.8 : 0;

      // Mixage final (-1.0 à 1.0)
      let signal = bass + lead + noise;

      // Soft Clipping (limiter le signal entre -1 et 1 sans distorsion dure)
      signal = Math.tanh(signal);

      // Conversion en 16-bit Signed Integer (-32768 à 32767)
      const int16Value = Math.floor(signal * 32000);

      // Écriture dans le buffer (Little Endian est standard pour l'audio PCM)
      buffer.writeInt16LE(int16Value, i * 2);
    }

    // Mettre à jour le temps global pour le prochain buffer
    time += BUFFER_SIZE / SAMPLE_RATE;

    // Envoyer au serveur
    ws.send(buffer);
  }, INTERVAL_MS);
}

// Démarrer
connect();
