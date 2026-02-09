const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const Throttle = require('throttle');

// --- CONFIGURATION ---
const WS_URL = 'wss://audio-visualizer-server.up.railway.app';
const MP3_FILE = path.join(__dirname, 'example.mp3');
const SAMPLE_RATE = 44100;
const CHANNELS = 1;

// 16-bit audio = 2 bytes par sample
const BYTES_PER_SAMPLE = 2;
const BYTE_RATE = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE; // = 88200 bytes/sec

// --- SETUP ---
ffmpeg.setFfmpegPath(ffmpegPath);
let ws;
let currentStream = null;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('📡 Connected to server. Starting Audio Stream...');
    playLoop();
  });

  ws.on('close', () => {
    console.log('❌ Disconnected. Stopping stream.');
    if (currentStream) currentStream.kill();
    setTimeout(connect, 3000);
  });

  ws.on('error', console.error);
}

function playLoop() {
  if (!fs.existsSync(MP3_FILE)) {
    console.error(`❌ ERROR: File not found at ${MP3_FILE}`);
    console.error(
      '👉 Please put a file named "example.mp3" in the listener folder.',
    );
    process.exit(1);
  }

  console.log(`🎵 Playing: ${path.basename(MP3_FILE)}`);

  // 1. On crée un "Throttle" qui va limiter le débit de données
  // à la vitesse réelle de lecture audio (88200 octets/seconde)
  const throttle = new Throttle(BYTE_RATE);

  // 2. On lance FFMPEG pour décoder le MP3 en RAW PCM
  const command = ffmpeg(MP3_FILE)
    .format('s16le') // Format brut 16-bit Little Endian
    .audioCodec('pcm_s16le')
    .audioChannels(CHANNELS)
    .audioFrequency(SAMPLE_RATE)
    .on('error', (err) => {
      console.error('FFmpeg error:', err.message);
    })
    .on('end', () => {
      console.log('🔄 Track finished. Looping...');
      playLoop(); // RESTART (Loop)
    });

  // 3. On connecte les tuyaux : FFMPEG -> Throttle -> WebSocket
  const ffStream = command.pipe(throttle);
  currentStream = command; // Pour pouvoir le tuer si besoin

  ffStream.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  });
}

// Start
connect();
