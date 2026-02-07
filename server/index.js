const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.get('/', (req, res) => {
  res.send({ message: 'Audio Visualizer WS Server is running!' });
});

app.get('/health', (req, res) => {
  res.send({ status: 'ok' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (data) => {
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === client.OPEN) {
        client.send(data);
      }
    });
  });
});

const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log(`Server started on http://localhost:${port}`);
});
