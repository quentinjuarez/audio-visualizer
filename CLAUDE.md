# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Yarn 3 workspaces monorepo (`packageManager: yarn@3.5.0`) with three packages:

- [server/](server/) — Express + `ws` WebSocket relay. No audio logic; just rebroadcasts each incoming binary message to every other connected client.
- [listener/](listener/) — Node.js audio sources that connect to the server as WS clients and push raw PCM frames. Three entry points (see below).
- [visualizer/](visualizer/) — Vite vanilla-JS web app that connects to the server, plays the received PCM through Web Audio, and renders an `AnalyserNode` output to a canvas.

## Common commands

Run from the repo root (workspaces are configured at the top-level [package.json](package.json)):

```bash
yarn install              # install all workspaces
yarn start:server         # node server/index.js
yarn start:listener       # node listener/audio.js  (mp3 file streamer — the default)
yarn dev:visualizer       # vite dev server for visualizer
yarn workspace visualizer build     # production build (outputs to visualizer/dist)
yarn workspace visualizer preview   # preview the prod build
```

To run an alternate listener source, invoke it directly — `yarn workspace listener start` only runs `audio.js`:

```bash
node listener/index.js    # captures system audio via naudiodon (loopback / Stereo Mix)
node listener/fake.js     # synthesized retrowave signal, no input file needed
```

There are no tests, linter, or formatter configured in this repo.

## Architecture: end-to-end audio pipeline

```
listener (node)  ─PCM s16le mono 44.1kHz─▶  server (ws relay)  ──▶  visualizer (browser)
```

Every link in the chain assumes the **same wire format**: 16-bit signed little-endian PCM, mono, 44100 Hz. If you change `SAMPLE_RATE`, `CHANNELS`, or sample format in one place you must update all three:

- [listener/audio.js](listener/audio.js) — `SAMPLE_RATE`, `CHANNELS`, `BYTES_PER_SAMPLE`, ffmpeg `s16le` settings
- [listener/index.js](listener/index.js) — `naudiodon` `inOptions`
- [listener/fake.js](listener/fake.js) — `SAMPLE_RATE` and `writeInt16LE`
- [visualizer/audio-engine.js](visualizer/audio-engine.js) — `Int16Array` decode, `createBuffer(1, …, 44100)`

### Server (relay-only)

[server/index.js](server/index.js) is intentionally dumb: on each WS message, it forwards `data` to every other client. There is no per-client state, authentication, or audio processing. `APP_PAUSED=true` short-circuits startup into a no-op sleep loop (used together with [railway.pause.toml](railway.pause.toml) to keep the Railway deploy idle without changing infra).

### Listener (audio source)

The listener is a producer — it must be running for the visualizer to show anything. The `audio.js` flow is the canonical one:

1. `fluent-ffmpeg` (with `ffmpeg-static`) decodes `example.mp3` to raw `s16le` PCM.
2. The PCM stream is piped through a `Throttle` set to `BYTE_RATE = SAMPLE_RATE * CHANNELS * 2` (= 88 200 B/s) so the producer matches real-time playback speed. Without the throttle the file would be sent in milliseconds and the visualizer would race through then go silent.
3. Each `data` chunk from the throttled stream is sent as a binary WS message.
4. On `end`, `playLoop()` is recursively invoked to loop the file.

`fake.js` is the same pattern with a `setInterval` synthesizer instead of ffmpeg, useful for development without an mp3.

⚠️ The WS URL is **hard-coded** inside each listener entry point (`WS_URL` constant). `audio.js` and `fake.js` point at the Railway deploy; `index.js` points at `ws://localhost:3000`. Edit the constant when switching environments.

### Visualizer

Two classes, no framework:

- [visualizer/audio-engine.js](visualizer/audio-engine.js) — owns the `AudioContext`, an `AnalyserNode` (`fftSize: 2048`, `smoothingTimeConstant: 0.8`), and the WS connection. Each incoming `ArrayBuffer` is reinterpreted as `Int16Array`, scaled to `[-1, 1]` `Float32Array`, wrapped in an `AudioBuffer`, and played as a one-shot `BufferSource` connected to the analyser. Browser autoplay policy: the context starts `suspended`; the global `click` handler in [main.js](visualizer/main.js) calls `resumeContext()` and hides the `#start-overlay`.
- [visualizer/renderer.js](visualizer/renderer.js) — Canvas 2D. `drawWaveform` uses `getByteTimeDomainData`; `drawFrequencies` uses `getByteFrequencyData` with a logarithmic bin remap (`Math.pow(percent, 2.5)`) into 120 bars, a noise-floor cutoff at 30/255, and a `pow(val, 2)` shaping curve. When tweaking the FFT visual, those three magic numbers (bin exponent, noise floor, shaping power) are the levers.

The WS endpoint is read from `VITE_AUDIO_WS_URL` (Vite env var, must be set in `visualizer/.env` or the shell at build/dev time).

## Deployment

The `server` workspace is the only thing deployed (Railway). [railway.toml](railway.toml) sets `startCommand = "yarn workspace server start"` with very tight limits (0.1 CPU, 128 MB). The listener and visualizer are run elsewhere — listener on a local/host machine that has the audio source, visualizer on any static host or `vite preview`.
