import { WsClient } from "./ws-client.js";
import { DebugView } from "./views/debug.js";

const view = new DebugView();

new WsClient({
  onFrame(frame) {
    view.update(frame);
  },
  onStatus(connected) {
    const dot = document.getElementById("ws-dot");
    const label = document.getElementById("ws-label");
    dot.classList.toggle("on", connected);
    label.textContent = connected ? "Connected" : "Disconnected";
  },
});
