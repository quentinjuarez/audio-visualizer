import { WsClient } from "./ws-client.js";
import { DebugView } from "./views/debug.js";
import { HueView } from "./views/hue.js";

const view = new DebugView();
const hue = new HueView();

new WsClient({
  onFrame(frame) {
    view.update(frame);
    hue.update(frame);
  },
  onStatus(connected) {
    const dot = document.getElementById("ws-dot");
    const label = document.getElementById("ws-label");
    dot.classList.toggle("on", connected);
    label.textContent = connected ? "Connected" : "Disconnected";
  },
});
