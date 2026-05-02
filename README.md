# Audio Visualizer

Real-time audio visualization with Philips Hue reactive lighting.

## Architecture

```
listener (Node.js)  ──PCM/JSON──▶  server (WS relay)  ──▶  visualizer (browser)
```

## Quick start

```bash
yarn install
yarn start:server       # relay server on :3000
yarn start:listener     # audio source (mp3 streamer)
yarn dev:visualizer     # open http://localhost:5173
```

Open the visualizer, click **⬡ Tech** to see analysis data, **Hue** to control lights.

---

## Connecting Philips Hue

The Hue panel lets you sync your lights to the music in real time.

### 1. Find your bridge IP

Find the IP in the **Hue app** under *Settings → My Hue system → Bridge → IP address*, then enter it in the panel and click **Connect**.

> Auto-discover is removed: `discovery.meethue.com` blocks cross-origin browser requests.

### 2. Pair (first time only)

**Option A — in-browser (only works when the visualizer is served over HTTP)**

1. **Press the physical button on top of the bridge.**
2. Within 30 seconds, click **Pair** in the panel.
3. The API key is filled in automatically and saved to `localStorage`.

> The in-browser Pair button calls `http://[bridge-ip]/api` over plain HTTP.
> If the visualizer is served from an HTTPS origin (Railway, etc.) the browser
> silently blocks the request as mixed content — use Option B instead.

**Option B — manual via curl (works everywhere)**

Press the button on the bridge, then within ~10 seconds run:

```bash
curl -X POST http://BRIDGE_IP/api \
     -H "Content-Type: application/json" \
     -d '{"devicetype":"audio-visualizer#browser"}'
```

Copy the `username` value from the response and paste it into the **API Key** field in the Hue panel, then click **Connect**.

```json
[{"success":{"username":"a1b2c3d4e5..."}}]
```

The key is saved to `localStorage` — you only need to do this once per browser.

### 3. Select lights or a group

After connecting, click **↺ Refresh** to load your lights.

- **Group mode** (recommended): pick a room/zone from the *Group* dropdown — all lights in it update with a single request, staying within the bridge's rate limit.
- **Individual mode**: leave the dropdown on *— Individual lights —* and check the lights you want. With 3+ lights the panel warns you about potential rate-limit saturation.

### 4. Configure behavior

| Setting | Description |
|---|---|
| **Color source** | `Energy zone hue` — color follows spectral brightness. `Dominant band` — color maps to the loudest frequency band. `Static` — fixed color. |
| **Brightness source** | `RMS` — overall loudness. `Beat strength` — pulses on beats. `Static` — fixed level. |
| **Flash on beat** | Instantly jumps to full brightness on every detected beat, then returns to the brightness source. |
| **Beat source** | Which detection algorithm drives the flash: tempo tracker, flux detector, or both. |
| **Transition time** | `0` = instant (best for beat flash). Higher values smooth color changes between frames. |
| **Min / Max bri** | Clamps the dynamic brightness range so lights never go fully dark or blindingly bright. |

### Troubleshooting

| Symptom | Fix |
|---|---|
| Auto-discover finds nothing | `discovery.meethue.com` may be unreachable. Enter the IP manually (Hue app → *Settings → My Hue system → Bridge → IP address*). |
| Pair button does nothing / times out | First visit `https://BRIDGE_IP` in your browser and accept the self-signed certificate warning, then retry Pair. |
| "Unauthorized" after connecting | API key is wrong or expired. Re-pair with Option B and paste the new key. |
| Cannot reach bridge | Bridge and browser must be on the same local network. VLANs or guest WiFi will block access. |
| Lights lag behind the music | Set *Transition time* to `0` (instant) and use *Group mode* to halve the request count. |
| Beat flash not firing | Open the Tech panel and watch **Beat str** — if it stays at 0, the listener may not be sending beat data. Check the *Beat source* selector and try `Auto`. |

---

## Visualizer panels

| Panel | Toggle | Contents |
|---|---|---|
| **Tech** | `⬡ Tech` button | Waveform, FFT spectrum, per-band energy meters, spectral descriptors |
| **Visualizer** | always visible | Full-screen radial spectrum, waveform ring, particle bursts on beats |
| **Hue** | `Hue` button | Bridge connection, light selection, color/brightness/beat settings |
