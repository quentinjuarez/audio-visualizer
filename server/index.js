const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const cors = require("cors");
require("dotenv").config();

if (process.env.APP_PAUSED === "true") {
  console.log("🚫 Service paused.");
  setInterval(() => {}, 1000 * 60 * 60);
  return;
}

const app = express();
app.use(cors());
app.get("/", (req, res) => {
  res.send({ message: "Audio Visualizer WS Server is running!" });
});

app.get("/health", (req, res) => {
  res.send({ status: "ok" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (data, isBinary) => {
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === client.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
  });
});

const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log(`Running on http://localhost:${port}`);
});
