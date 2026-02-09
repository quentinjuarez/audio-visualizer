const portAudio = require('naudiodon');
const WebSocket = require('ws');

// Configuration
const WS_URL = 'ws://localhost:3000';
const ws = new WebSocket(WS_URL);

// Fonction pour trouver le périphérique d'entrée (Loopback/Stereo Mix)
function getLoopbackDevice() {
  const devices = portAudio.getDevices();
  // Cherche un device qui contient "Stereo Mix" ou "Loopback" ou utilise le device par défaut
  // Sur Windows, il faut souvent activer "Mixage Stéréo" dans les paramètres son
  const device =
    devices.find((d) => d.name.includes('Mix') || d.name.includes('Stereo')) ||
    devices[0];
  console.log(`Using device: ${device.name}`);
  return device;
}

ws.on('open', () => {
  console.log('Connected to server');

  const device = getLoopbackDevice();

  const ai = new portAudio.AudioIO({
    inOptions: {
      channelCount: 1,
      sampleFormat: portAudio.SampleFormat16Bit,
      sampleRate: 44100,
      deviceId: device.id,
      closeOnError: false,
    },
  });

  ai.on('data', (buf) => {
    // Envoi du buffer audio brut
    ws.send(buf);
  });

  ai.start();
});

ws.on('error', console.error);
