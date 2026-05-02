import { WsClient } from "./ws-client.js";
import { TechView } from "./views/tech.js";
import { HueView } from "./views/hue.js";
import { FullView } from "./views/full.js";

// ── Views ────────────────────────────────────────────────────────────────────

const tech = new TechView();
const hue = new HueView();
const viz = new FullView(document.getElementById("viz-canvas"));

// ── Panel toggles ────────────────────────────────────────────────────────────

const techPanel = document.getElementById("tech-panel");
const techBtn = document.getElementById("tech-toggle-btn");

techBtn.addEventListener("click", () => {
  const open = techPanel.classList.toggle("open");
  techBtn.classList.toggle("active", open);
  // Re-measure canvases after the CSS transition completes.
  techPanel.addEventListener("transitionend", () => tech.resize(), {
    once: true,
  });
});

// HueView manages its own toggle button internally (hue-toggle-btn / hue-panel-close).

// ── WebSocket ────────────────────────────────────────────────────────────────

new WsClient({
  onFrame(frame) {
    tech.update(frame);
    hue.update(frame);
    viz.update(frame);
  },
  onStatus(connected) {
    document.getElementById("ws-dot").classList.toggle("on", connected);
    document.getElementById("ws-label").textContent = connected
      ? "Connected"
      : "Disconnected";
  },
});
