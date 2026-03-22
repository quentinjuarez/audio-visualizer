#!/usr/bin/env python3
"""
Audio Listener
Captures any audio device and streams raw 16-bit mono PCM over WebSocket.

WASAPI loopback devices (prefixed with "🔊 Loopback:") capture everything
playing through that output — no virtual cable or VoiceMeeter needed.

Other devices (microphones, virtual cable outputs, etc.) are listed as-is.
"""

import json
import os
import queue
import sys
import threading
import tkinter as tk
from tkinter import ttk

import numpy as np
import pyaudiowpatch as pyaudio
import websocket

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
_BASE = os.path.dirname(
    sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__)
)
CONFIG_FILE = os.path.join(_BASE, "listener_config.json")
DEFAULT_WS_URL = "ws://localhost:3000"

SAMPLE_RATE = 44100
BLOCK_SIZE = 2048  # ~46 ms per chunk


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
class AudioListenerApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Audio Listener")
        self.root.geometry("500x450")
        self.root.resizable(False, False)

        self.config = self._load_config()
        self.ws: websocket.WebSocket | None = None
        self.stream = None
        self._pa: pyaudio.PyAudio | None = None
        self._capture_channels = 1
        self.is_running = False
        self.pcm_queue: queue.Queue[bytes] = queue.Queue(maxsize=100)
        self._vu_raw = 0.0      # last RMS measured in audio thread
        self._vu_smooth = 0.0   # smoothed value for rendering
        self.device_map: dict[str, int] = {}  # display_name → device index
        self.loopback_set: set[str] = set()  # loopback device labels
        self._gate_threshold = 0.01  # RMS linear; updated by UI slider

        self._setup_ui()
        self._refresh_devices()
        self._animate_vu()

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ── Persistence ──────────────────────────────────────────────────────────

    def _load_config(self) -> dict:
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return {"ws_url": DEFAULT_WS_URL, "device_name": None, "url_history": []}

    def _save_config(self):
        self.config["ws_url"] = self.url_var.get()
        self.config["device_name"] = self.device_var.get()
        self.config["gate_db"] = self._gate_db_var.get()
        self.config["url_history"] = list(self.url_combo["values"])
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=2)
        except Exception:
            pass

    # ── Devices ──────────────────────────────────────────────────────────────

    def _refresh_devices(self):
        # pyaudiowpatch exposes WASAPI loopback devices as real input devices
        # with isLoopbackDevice=True — no virtual cable needed.
        pa = pyaudio.PyAudio()
        self.device_map = {}
        self.loopback_set = set()

        # 1. WASAPI loopback devices first (prefixed so they sort to the top)
        for i in range(pa.get_device_count()):
            info = pa.get_device_info_by_index(i)
            if info.get("isLoopbackDevice") and info["maxInputChannels"] > 0:
                label = f"🔊 Loopback: {info['name']}"
                self.device_map[label] = i
                self.loopback_set.add(label)

        # 2. Regular input devices (microphones, virtual cable outputs, etc.)
        for i in range(pa.get_device_count()):
            info = pa.get_device_info_by_index(i)
            if not info.get("isLoopbackDevice") and info["maxInputChannels"] > 0:
                name = info["name"]
                if name not in self.device_map:
                    self.device_map[name] = i

        pa.terminate()

        names = list(self.device_map)
        self.device_combo["values"] = names

        saved = self.config.get("device_name")
        if saved in self.device_map:
            self.device_var.set(saved)
        elif names:
            self.device_var.set(names[0])

    # ── Audio callback (real-time thread) ────────────────────────────────────

    def _audio_callback(self, in_data, frame_count, time_info, status):
        if not self.is_running:
            return (None, pyaudio.paContinue)
        # in_data is raw Int16LE bytes; reshape to (frames, channels) then mix to mono
        samples = np.frombuffer(in_data, dtype=np.int16).reshape(-1, self._capture_channels)
        mono = samples.mean(axis=1).astype(np.int16)
        rms = float(np.sqrt(np.mean((mono.astype(np.float32) / 32768.0) ** 2)))
        self._vu_raw = rms
        # Noise gate: drop silent frames so the server receives nothing when idle
        if rms >= self._gate_threshold:
            try:
                self.pcm_queue.put_nowait(mono.tobytes())
            except queue.Full:
                pass  # drop frame — never block the real-time thread
        return (None, pyaudio.paContinue)

    # ── WebSocket send loop (background thread) ───────────────────────────────

    def _send_loop(self):
        while self.is_running:
            try:
                data = self.pcm_queue.get(timeout=0.5)
                if self.ws and self.ws.connected:
                    self.ws.send_binary(data)
            except queue.Empty:
                continue
            except Exception as exc:
                self._set_status(f"❌ Connection lost: {exc}", "#ff5555")
                self.root.after(0, self._stop_capture)
                return

    # ── Start / Stop ─────────────────────────────────────────────────────────

    def _toggle(self):
        if self.is_running:
            self._stop_capture()
        else:
            self._start_capture()

    def _start_capture(self):
        device_name = self.device_var.get()
        if not device_name or device_name not in self.device_map:
            self._set_status("❌ No device selected", "#ff5555")
            return

        url = self.url_var.get().strip()
        self.toggle_btn.config(state="disabled", text="Connecting…")
        self._set_status("🔗 Connecting…", "#f0a500")

        def _worker():
            # 1. Connect WebSocket
            ws = websocket.WebSocket()
            try:
                ws.connect(url, timeout=5)
            except Exception as exc:
                self._set_status(f"❌ WS: {exc}", "#ff5555")
                self.root.after(
                    0, lambda: self.toggle_btn.config(state="normal", text="▶  Start")
                )
                return
            self.ws = ws

            # 2. Open audio stream
            device_idx = self.device_map[device_name]
            self._pa = pyaudio.PyAudio()
            info = self._pa.get_device_info_by_index(device_idx)
            self._capture_channels = min(2, max(1, int(info["maxInputChannels"])))
            try:
                self.stream = self._pa.open(
                    format=pyaudio.paInt16,
                    channels=self._capture_channels,
                    rate=SAMPLE_RATE,
                    frames_per_buffer=BLOCK_SIZE,
                    input=True,
                    input_device_index=device_idx,
                    stream_callback=self._audio_callback,
                )
                self.stream.start_stream()
            except Exception as exc:
                self._set_status(f"❌ Audio: {exc}", "#ff5555")
                ws.close()
                self._pa.terminate()
                self._pa = None
                self.root.after(
                    0, lambda: self.toggle_btn.config(state="normal", text="▶  Start")
                )
                return

            self.is_running = True
            # Auto-add the URL to history on successful connect
            self.root.after(0, lambda: self.url_combo.__setitem__(
                "values",
                list(dict.fromkeys([url] + list(self.url_combo["values"])))
            ))
            self._save_config()

            # 3. Start send thread
            threading.Thread(target=self._send_loop, daemon=True).start()
            self.root.after(0, self._on_started)

        threading.Thread(target=_worker, daemon=True).start()

    def _on_started(self):
        self._set_status("🎵  Streaming…", "#22cc66")
        self.toggle_btn.config(state="normal", text="⏹  Stop")

    def _stop_capture(self):
        self.is_running = False
        if self.stream:
            try:
                self.stream.stop_stream()
                self.stream.close()
            except Exception:
                pass
            self.stream = None
        if self._pa:
            try:
                self._pa.terminate()
            except Exception:
                pass
            self._pa = None
        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None
        self._vu_raw = 0.0
        self._set_status("⏹  Stopped", "#888888")
        self.toggle_btn.config(text="▶  Start", state="normal")

    def _on_close(self):
        self._stop_capture()
        self.root.destroy()

    # ── VU meter (main thread, ~33 fps) ──────────────────────────────────────

    def _animate_vu(self):
        raw = self._vu_raw
        # Attack fast / decay slow — gives classic VU meter feel
        if raw > self._vu_smooth:
            self._vu_smooth += (raw - self._vu_smooth) * 0.6
        else:
            self._vu_smooth += (raw - self._vu_smooth) * 0.04

        normalized = min(1.0, self._vu_smooth * 8)  # scale RMS → 0..1

        w = max(460, self.vu_canvas.winfo_width() - 2)
        h = self.vu_canvas.winfo_height()
        self.vu_canvas.delete("all")

        # Coloured bar segments: green / yellow / red
        if normalized > 0:
            g = min(normalized, 0.6)
            y = min(normalized, 0.85)
            r = normalized
            if g > 0:
                self.vu_canvas.create_rectangle(
                    0, 2, int(w * g), h - 2, fill="#22cc66", outline=""
                )
            if y > 0.6:
                self.vu_canvas.create_rectangle(
                    int(w * 0.6), 2, int(w * y), h - 2, fill="#ffcc00", outline=""
                )
            if r > 0.85:
                self.vu_canvas.create_rectangle(
                    int(w * 0.85), 2, int(w * r), h - 2, fill="#ff4444", outline=""
                )

        # Gate threshold marker
        gate_normalized = min(1.0, self._gate_threshold * 8)
        gx = int(w * gate_normalized)
        self.vu_canvas.create_line(gx, 0, gx, h, fill="#ff8800", width=2)
        self.vu_canvas.create_text(
            gx + 3, 2, text="gate", fill="#ff8800", font=("Courier", 7), anchor="nw"
        )

        # Tick lines + labels
        for pct, lbl in ((0.6, "-10 dB"), (0.85, "-3 dB"), (1.0, "0 dB")):
            x = int(w * pct)
            self.vu_canvas.create_line(x, 0, x, h, fill="#333333")
            self.vu_canvas.create_text(
                x - 3, 2, text=lbl, fill="#555555", font=("Courier", 7), anchor="ne"
            )

        self.root.after(30, self._animate_vu)

    # ── Status helper (thread-safe) ───────────────────────────────────────────

    def _set_status(self, msg: str, color: str = "#aaaaaa"):
        def _do():
            self.status_label.config(text=msg, fg=color)

        if threading.current_thread() is threading.main_thread():
            _do()
        else:
            self.root.after(0, _do)

    # ── UI setup ─────────────────────────────────────────────────────────────

    def _setup_ui(self):
        BG = "#1a1a1a"
        FG = "#eeeeee"
        ENTRY = "#252525"
        ACCENT = "#0078d4"
        MUTED = "#777777"

        self.root.configure(bg=BG)

        style = ttk.Style()
        style.theme_use("clam")
        style.configure(
            "TCombobox",
            fieldbackground=ENTRY,
            background=ENTRY,
            foreground=FG,
            selectbackground=ACCENT,
            selectforeground=FG,
            arrowcolor=FG,
            bordercolor="#444",
            lightcolor=ENTRY,
            darkcolor=ENTRY,
        )
        style.map(
            "TCombobox",
            fieldbackground=[("readonly", ENTRY)],
            background=[("readonly", ENTRY)],
        )

        def _section(title: str) -> tk.Frame:
            f = tk.Frame(self.root, bg=BG)
            f.pack(fill=tk.X, padx=20, pady=(12, 0))
            tk.Label(
                f, text=title.upper(), bg=BG, fg="#555555", font=("Segoe UI", 7, "bold")
            ).pack(anchor="w")
            return f

        # Title
        tk.Label(
            self.root,
            text="Audio Listener",
            font=("Segoe UI", 15, "bold"),
            bg=BG,
            fg=FG,
        ).pack(pady=(18, 2))
        tk.Label(
            self.root,
            text="Captures audio and streams raw PCM over WebSocket",
            font=("Segoe UI", 9),
            bg=BG,
            fg=MUTED,
        ).pack()

        # WebSocket URL
        f = _section("WebSocket Server")
        url_row = tk.Frame(f, bg=BG)
        url_row.pack(fill=tk.X, pady=(4, 0))

        # Seed history: known URLs first, then any saved ones
        _known = [
            "ws://localhost:3000",
            "wss://audio-visualizer-server.up.railway.app",
        ]
        _saved_history: list = self.config.get("url_history", [])
        _history = list(dict.fromkeys(_known + _saved_history))  # deduplicate, preserve order

        self.url_var = tk.StringVar(value=self.config.get("ws_url", DEFAULT_WS_URL))
        self.url_combo = ttk.Combobox(
            url_row,
            textvariable=self.url_var,
            values=_history,
            font=("Segoe UI", 10),
            state="normal",
        )
        self.url_combo.pack(side=tk.LEFT, fill=tk.X, expand=True, ipady=5)

        def _add_url():
            url = self.url_var.get().strip()
            if not url:
                return
            current = list(self.url_combo["values"])
            if url not in current:
                current.append(url)
                self.url_combo["values"] = current
            self.url_var.set(url)

        tk.Button(
            url_row,
            text=" + ",
            command=_add_url,
            bg="#333333",
            fg=FG,
            relief="flat",
            font=("Segoe UI", 10),
            activebackground="#444444",
            cursor="hand2",
            bd=0,
        ).pack(side=tk.LEFT, padx=(8, 0), ipady=5)

        # Device selector
        f = _section("Audio Input Device")
        row = tk.Frame(f, bg=BG)
        row.pack(fill=tk.X, pady=(4, 0))
        self.device_var = tk.StringVar()
        self.device_combo = ttk.Combobox(
            row, textvariable=self.device_var, state="readonly", font=("Segoe UI", 10)
        )
        self.device_combo.pack(side=tk.LEFT, fill=tk.X, expand=True, ipady=5)
        tk.Button(
            row,
            text=" ↺ ",
            command=self._refresh_devices,
            bg="#333333",
            fg=FG,
            relief="flat",
            font=("Segoe UI", 10),
            activebackground="#444444",
            cursor="hand2",
            bd=0,
        ).pack(side=tk.LEFT, padx=(8, 0), ipady=5)

        # VU meter
        f = _section("Input Level")
        self.vu_canvas = tk.Canvas(
            f,
            height=30,
            bg="#0d0d0d",
            highlightthickness=1,
            highlightbackground="#333333",
        )
        self.vu_canvas.pack(fill=tk.X, pady=(4, 0))

        # Noise gate threshold slider
        f = _section("Noise Gate")
        gate_row = tk.Frame(f, bg=BG)
        gate_row.pack(fill=tk.X, pady=(4, 0))
        # Slider drives RMS threshold via dB mapping: linear = 10^(dB/20)
        # Range: -60 dB (0.001) to -10 dB (0.316); default -40 dB (0.01)
        self._gate_db_var = tk.DoubleVar(value=self.config.get("gate_db", -40.0))

        def _on_gate_change(val):
            db = float(val)
            self._gate_threshold = 10 ** (db / 20.0)
            self._gate_db_label.config(text=f"{db:.0f} dB")
            self.config["gate_db"] = db

        tk.Scale(
            gate_row,
            variable=self._gate_db_var,
            from_=-60,
            to=-10,
            resolution=1,
            orient=tk.HORIZONTAL,
            command=_on_gate_change,
            bg=BG,
            fg=FG,
            troughcolor="#333333",
            activebackground="#ff8800",
            highlightthickness=0,
            sliderrelief="flat",
            showvalue=False,
            bd=0,
        ).pack(side=tk.LEFT, fill=tk.X, expand=True)
        self._gate_db_label = tk.Label(
            gate_row, text="-40 dB", bg=BG, fg="#ff8800", font=("Segoe UI", 9), width=7
        )
        self._gate_db_label.pack(side=tk.LEFT)
        # Apply initial value
        _on_gate_change(self._gate_db_var.get())

        # Status
        self.status_label = tk.Label(
            self.root,
            text="⏹  Stopped",
            font=("Segoe UI", 9),
            bg=BG,
            fg=MUTED,
        )
        self.status_label.pack(pady=(10, 0))

        # Toggle button — use ipady in pack() for reliable vertical inner padding
        self.toggle_btn = tk.Button(
            self.root,
            text="▶  Start",
            command=self._toggle,
            bg=ACCENT,
            fg="white",
            font=("Segoe UI", 11, "bold"),
            relief="flat",
            bd=0,
            activebackground="#005fa3",
            activeforeground="white",
            cursor="hand2",
        )
        self.toggle_btn.pack(fill=tk.X, padx=20, pady=(10, 16), ipady=11)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    root = tk.Tk()
    app = AudioListenerApp(root)
    root.mainloop()
