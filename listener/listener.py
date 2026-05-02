#!/usr/bin/env python3
"""
Audio Listener
Captures any audio device, analyses each block (FFT, bands, beat, spectral
descriptors) and broadcasts a compact JSON frame over WebSocket at ~43 fps.

WASAPI loopback devices (prefixed with "🔊 Loopback:") capture everything
playing through that output — no virtual cable or VoiceMeeter needed.

Other devices (microphones, virtual cable outputs, etc.) are listed as-is.

Analysis pipeline (per frame)
-----------------------------
1. 50 % overlap (HOP = BLOCK / 2) → frame rate doubles, transients land twice
2. High-pass at 30 Hz to kill DC / subsonic rumble
3. AGC: rolling peak normalises gain so quiet and loud sources read alike
4. A-weighting curve applied to a *separate* magnitude copy used for the
   musical-meaning fields (dominant_band, energy_zone_hue) — raw bands keep
   their physical levels for the visualiser
5. Per-band rolling baseline → "dominant" means *unusually* hot for this song,
   not just "bass is naturally loudest"
6. Multi-band onset: kick-band (40-90 Hz) OR broadband spectral flux

JSON frame schema
-----------------
{
  rms, db, peak,
  bands: { sub, bass, low_mid, mid, high_mid, high, air },  // 0-1, raw level
  bands_norm: { … same keys … },                            // 0-1, vs rolling baseline
  fft: float[64],        // log-spaced magnitude bins, 0-1
  waveform: float[256],  // downsampled time-domain, 0-1
  beat: bool,
    beat_flux: bool,
    beat_tempo: bool,
    beat_source: str,      // none | flux | tempo | both
  beat_strength: float,  // 0-1
    tempo_bpm: float,
    tempo_confidence: float,
  centroid, flux, rolloff, bandwidth, flatness, zcr: float in 0-1,
  dominant_band: str,    // perceptually weighted, baseline-normalised
  energy_zone_hue: int,  // 0-360, weighted-band hue mapping
  kick_energy: float,    // smoothed kick-band energy, 0-1
  gain: float            // current AGC gain (debug)
}
"""

import json
import os
import queue
import sys
from collections import deque
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
BLOCK_SIZE = 2048  # ~46 ms FFT window
HOP_SIZE   = BLOCK_SIZE // 2  # ~23 ms hop → 50 % overlap → ~43 fps

FFT_BINS = 64          # log-spaced bins sent to clients
WAVEFORM_POINTS = 256  # time-domain points sent to clients
FLUX_HISTORY_SIZE = 40 # frames kept for adaptive beat threshold (~1 s @43 fps)
BEAT_MULTIPLIER       = 1.7  # kick flux must exceed mean*this to register
BROADBAND_MULTIPLIER  = 1.9  # full-spectrum flux trigger (catches non-kick beats)

# Silence handling — when the noise gate is closed we still emit a zeroed
# heartbeat frame so the visualiser doesn't sit on the last loud frame.
# At ~43 fps audio, every 8 callbacks ≈ 5 fps heartbeat — enough to scroll
# the spectrogram into black without spamming the socket.
SILENCE_HEARTBEAT_FRAMES = 8
KICK_FREQ_LO = 40.0    # Hz — kick drum detection lower bound
KICK_FREQ_HI = 90.0    # Hz — kick drum detection upper bound
HPF_FREQ     = 30.0    # Hz — high-pass cutoff (kill DC / subsonic rumble)
MIN_TEMPO_BPM = 70.0
MAX_TEMPO_BPM = 180.0

# AGC — adaptive gain so quiet / loud sources both read in 0-1 range
AGC_TARGET   = 0.85    # target peak FFT magnitude after gain
AGC_GAIN_MIN = 5.0
AGC_GAIN_MAX = 80.0
AGC_ATTACK   = 0.05    # fraction-per-frame approach when gain too high
AGC_DECAY    = 0.005   # fraction-per-frame approach when signal weakens

# Per-band baseline EMA — slower than AGC, learns the "normal" energy of each
# band over a song. Used to decide which band is *unusually* hot right now.
BAND_BASELINE_ALPHA = 0.002  # ~8 s half-life @43 fps
BAND_BASELINE_FLOOR = 0.005

# Frequency band definitions (Hz)
_BAND_RANGES = [
    ("sub",      20,    60),
    ("bass",     60,   250),
    ("low_mid",  250,  500),
    ("mid",      500,  2000),
    ("high_mid", 2000, 4000),
    ("high",     4000, 8000),
    ("air",      8000, 20000),
]


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
        self.frame_queue: queue.Queue[str] = queue.Queue(maxsize=100)
        self._prev_fft: np.ndarray | None = None
        self._kick_flux_history: deque = deque(maxlen=FLUX_HISTORY_SIZE)
        self._broad_flux_history: deque = deque(maxlen=FLUX_HISTORY_SIZE)
        self._kick_env = 0.0  # smoothed kick-band energy for continuous mapping
        self._agc_gain = 20.0  # adaptive gain replacing the old fixed BOOST
        self._frame_idx = 0
        self._onset_frames: list[int] = []
        self._last_onset_frame = -10_000
        self._tempo_bpm = 0.0
        self._tempo_confidence = 0.0
        self._tempo_period_frames = 0.0
        self._next_tempo_beat_frame: float | None = None
        self._vu_raw = 0.0      # last RMS measured in audio thread
        self._vu_smooth = 0.0   # smoothed value for rendering
        self.device_map: dict[str, int] = {}  # display_name → device index
        self.loopback_set: set[str] = set()  # loopback device labels
        self._gate_threshold = 0.01  # RMS linear; updated by UI slider
        self._silence_counter = 0    # consecutive callbacks below the gate
        self._silence_payload: str | None = None  # cached zeroed JSON frame

        # 50 %-overlap ring: previous hop concatenated with the new hop forms
        # one BLOCK_SIZE analysis window. Filled lazily on first callback.
        self._prev_hop: np.ndarray = np.zeros(HOP_SIZE, dtype=np.int16)
        self._have_prev_hop = False

        # Precompute FFT helpers (block size is fixed at startup)
        self._fft_window: np.ndarray = np.hanning(BLOCK_SIZE).astype(np.float32)
        self._fft_freqs: np.ndarray = np.fft.rfftfreq(BLOCK_SIZE, d=1.0 / SAMPLE_RATE).astype(np.float32)

        # High-pass curve — smooth ramp from 0 → 1 across HPF_FREQ ± a third
        self._hpf_curve: np.ndarray = np.clip(
            (self._fft_freqs - HPF_FREQ * 0.7) / (HPF_FREQ * 0.6), 0.0, 1.0
        ).astype(np.float32)

        # A-weighting curve (perceptual loudness) — used only for
        # dominant_band / energy_zone_hue, NOT for the raw band visualiser.
        self._a_weight: np.ndarray = self._compute_a_weight(self._fft_freqs)

        self._log_edges: np.ndarray = np.logspace(
            np.log10(20.0), np.log10(20000.0), FFT_BINS + 1
        )
        self._band_masks: list[tuple[str, np.ndarray]] = [
            (name, (self._fft_freqs >= lo) & (self._fft_freqs < hi))
            for name, lo, hi in _BAND_RANGES
        ]
        self._kick_mask: np.ndarray = (
            (self._fft_freqs >= KICK_FREQ_LO) & (self._fft_freqs <= KICK_FREQ_HI)
        )

        # Precompute log-spaced visualiser bin lookup once. Each FFT_BINS
        # entry is either a mask of FFT bins inside its log range, or — when
        # the range is narrower than a single FFT bin (common in bass) — the
        # index of the nearest FFT bin to use as a fallback.
        self._log_bin_masks: list[np.ndarray | None] = []
        self._log_bin_nearest: list[int] = []
        for i in range(FFT_BINS):
            lo, hi = self._log_edges[i], self._log_edges[i + 1]
            mask = (self._fft_freqs >= lo) & (self._fft_freqs < hi)
            if mask.any():
                self._log_bin_masks.append(mask)
                self._log_bin_nearest.append(-1)
            else:
                self._log_bin_masks.append(None)
                self._log_bin_nearest.append(
                    int(np.argmin(np.abs(self._fft_freqs - (lo + hi) / 2.0)))
                )

        # Per-band rolling baseline (slow EMA). Initial value is well above the
        # baseline floor so the first second of audio doesn't normalise to inf.
        self._band_baselines: dict[str, float] = {
            name: 0.05 for name, _, _ in _BAND_RANGES
        }

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

    # ── Analysis (called from real-time thread) ─────────────────────────────

    @staticmethod
    def _compute_a_weight(freqs: np.ndarray) -> np.ndarray:
        """A-weighting curve (IEC 61672-1) in linear amplitude domain.
        Normalised so the response at 1 kHz equals 1.0."""
        f2 = freqs.astype(np.float64) ** 2
        num = (12194.0 ** 2) * (f2 ** 2)
        den = (
            (f2 + 20.6 ** 2)
            * np.sqrt(np.maximum((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2), 1e-20))
            * (f2 + 12194.0 ** 2)
        )
        ra = num / np.maximum(den, 1e-20)
        # Reference at 1 kHz
        f0 = 1000.0 ** 2
        ra_ref = ((12194.0 ** 2) * (f0 ** 2)) / (
            (f0 + 20.6 ** 2)
            * np.sqrt((f0 + 107.7 ** 2) * (f0 + 737.9 ** 2))
            * (f0 + 12194.0 ** 2)
        )
        return (ra / ra_ref).astype(np.float32)

    def _analyze_frame(self, mono: np.ndarray) -> str:
        """Full spectral analysis of one Int16 mono block. Returns JSON string."""
        f = mono.astype(np.float32) / 32768.0  # → [-1, 1]
        self._frame_idx += 1
        frame_rate = SAMPLE_RATE / HOP_SIZE  # ~43 fps with 50 % overlap

        # Time domain
        rms  = float(np.sqrt(np.mean(f ** 2)))
        db   = round(20.0 * np.log10(max(rms, 1e-9)), 2)
        peak = float(np.max(np.abs(f)))
        zcr = float(np.mean(np.abs(np.diff(np.signbit(f)).astype(np.float32))))

        # Waveform: WAVEFORM_POINTS equidistant samples, mapped to [0, 1]
        step = max(1, len(f) // WAVEFORM_POINTS)
        waveform = np.clip((f[::step][:WAVEFORM_POINTS] + 1.0) / 2.0, 0.0, 1.0)

        # FFT magnitude (peak-normalised), then high-pass to kill DC / rumble.
        magnitude = np.abs(np.fft.rfft(f * self._fft_window)) / (BLOCK_SIZE / 2)
        magnitude *= self._hpf_curve

        # Adaptive gain — replaces the old fixed BOOST=20. Tracks rolling peak
        # so quiet tracks and loud tracks both fill the 0-1 range. Slow attack
        # prevents transients from clamping the gain; faster decay lets us
        # come back up after a loud hit.
        peak_mag = float(np.max(magnitude))
        if peak_mag > 1e-6:
            desired = AGC_TARGET / peak_mag
            coef = AGC_ATTACK if desired < self._agc_gain else AGC_DECAY
            self._agc_gain += (desired - self._agc_gain) * coef
            self._agc_gain = float(np.clip(self._agc_gain, AGC_GAIN_MIN, AGC_GAIN_MAX))
        gain = self._agc_gain

        # Magnitude scaled for visualiser-style 0-1 levels
        mag_scaled = magnitude * gain
        # Perceptually weighted copy used for musical-meaning fields (dominant,
        # energy_zone_hue). Keeps raw bands honest for the visualiser.
        mag_perceptual = mag_scaled * self._a_weight

        # Band energies (raw — what the visualiser shows)
        bands: dict[str, float] = {}
        for name, mask in self._band_masks:
            bands[name] = (
                round(float(np.clip(np.mean(mag_scaled[mask]), 0.0, 1.0)), 4)
                if mask.any() else 0.0
            )

        # Perceptual band energies (A-weighted) — used internally for hue/dominance
        bands_perceptual: dict[str, float] = {}
        for name, mask in self._band_masks:
            bands_perceptual[name] = (
                float(np.clip(np.mean(mag_perceptual[mask]), 0.0, 1.0))
                if mask.any() else 0.0
            )

        # 64 log-spaced visualiser bins (precomputed masks → no per-frame allocs)
        fft_bins: list[float] = []
        for i in range(FFT_BINS):
            mask = self._log_bin_masks[i]
            if mask is not None:
                val = float(np.clip(np.mean(mag_scaled[mask]), 0.0, 1.0))
            else:
                val = float(np.clip(mag_scaled[self._log_bin_nearest[i]], 0.0, 1.0))
            fft_bins.append(round(val, 3))

        # Spectral centroid (0-1)
        total = float(np.sum(magnitude))
        nyquist = SAMPLE_RATE / 2.0
        centroid = (
            float(np.sum(self._fft_freqs * magnitude) / total) / nyquist
            if total > 0 else 0.0
        )

        # Spectral spread around centroid (0-1)
        centroid_hz = centroid * nyquist
        bandwidth = (
            float(
                np.sqrt(
                    np.sum(((self._fft_freqs - centroid_hz) ** 2) * magnitude) / total
                )
            )
            / nyquist
            if total > 0
            else 0.0
        )

        # Spectral flatness (0-1): noise-like spectra -> high values
        eps = 1e-12
        flatness = (
            float(np.exp(np.mean(np.log(magnitude + eps))) / (np.mean(magnitude + eps)))
            if np.any(magnitude > 0)
            else 0.0
        )

        # Spectral rolloff — freq below which 85% of energy sits (0-1)
        cumsum = np.cumsum(magnitude)
        rolloff_idx = int(np.searchsorted(cumsum, 0.85 * cumsum[-1]))
        rolloff = float(self._fft_freqs[min(rolloff_idx, len(self._fft_freqs) - 1)]) / nyquist

        # Spectral flux — full-spectrum for Tech display; kick-band for beat
        # detection. Computed on the AGC-scaled magnitude so absolute floors
        # below stay meaningful across volume levels.
        if self._prev_fft is None:
            flux = 0.0
            kick_flux = 0.0
        else:
            diff = np.maximum(mag_scaled - self._prev_fft, 0.0)
            flux      = float(np.sum(diff))
            kick_flux = float(np.sum(diff[self._kick_mask]))
        self._prev_fft = mag_scaled.copy()

        # Kick-band instantaneous energy (already 0-1 from mag_scaled)
        kick_raw = float(np.mean(mag_scaled[self._kick_mask]))
        self._kick_env += (kick_raw - self._kick_env) * (0.85 if kick_raw > self._kick_env else 0.20)
        kick_energy = float(np.clip(self._kick_env, 0.0, 1.0))

        # Adaptive flux thresholds from rolling history (~1 s @43 fps)
        self._kick_flux_history.append(kick_flux)
        self._broad_flux_history.append(flux)
        avg_kick_flux  = float(np.mean(self._kick_flux_history))  if self._kick_flux_history  else 0.0
        avg_broad_flux = float(np.mean(self._broad_flux_history)) if self._broad_flux_history else 0.0

        # Beat detection with refractory period.
        # Two onset paths OR'd together so that:
        #   - kick_candidate fires on tracks with strong low-end transients
        #   - broad_candidate catches snares/claps/synth hits on tracks
        #     where the kick is weak or absent (acoustic, jazz, vocal-heavy)
        min_interval_frames = max(1, int(frame_rate * (60.0 / MAX_TEMPO_BPM)))
        max_interval_frames = max(min_interval_frames + 1, int(frame_rate * (60.0 / MIN_TEMPO_BPM)))
        kick_candidate = (
            kick_flux > avg_kick_flux * BEAT_MULTIPLIER
            and avg_kick_flux > 1e-5
            and kick_raw > 0.04
            and rms > 0.01
        )
        broad_candidate = (
            flux > avg_broad_flux * BROADBAND_MULTIPLIER
            and avg_broad_flux > 1e-4
            and rms > 0.015
        )
        beat_flux = False
        if (kick_candidate or broad_candidate) and (
            self._frame_idx - self._last_onset_frame
        ) >= min_interval_frames:
            beat_flux = True
            self._last_onset_frame = self._frame_idx
            # Collect onsets for tempo estimation
            self._onset_frames.append(self._frame_idx)
            history_window = int(frame_rate * 12.0)
            cutoff = self._frame_idx - history_window
            self._onset_frames = [t for t in self._onset_frames if t >= cutoff]

        # Tempo estimate from onset intervals
        tempo_bpm = self._tempo_bpm
        tempo_confidence = self._tempo_confidence
        if len(self._onset_frames) >= 5:
            intervals = np.diff(np.array(self._onset_frames[-20:], dtype=np.int32))
            valid_intervals = intervals[
                (intervals >= min_interval_frames) & (intervals <= max_interval_frames)
            ]
            if len(valid_intervals) >= 4:
                bpms = 60.0 * frame_rate / valid_intervals.astype(np.float32)
                tempo_bpm = float(np.median(bpms))
                bpm_std = float(np.std(bpms))
                sample_factor = min(1.0, len(valid_intervals) / 12.0)
                stability = 1.0 - min(1.0, bpm_std / 15.0)
                tempo_confidence = max(0.0, min(1.0, sample_factor * stability))
                self._tempo_bpm = tempo_bpm
                self._tempo_confidence = tempo_confidence
                self._tempo_period_frames = 60.0 * frame_rate / max(tempo_bpm, 1e-6)

                # Re-align phase on actual kick when tempo is confidently locked
                if beat_flux and tempo_confidence >= 0.5:
                    self._next_tempo_beat_frame = self._frame_idx + self._tempo_period_frames

        # Tempo-driven beat prediction — requires high confidence AND audible signal.
        # This fills in beats that flux misses (e.g. muffled kick), but does not
        # fire during breakdowns or near-silence.
        beat_tempo = False
        if tempo_confidence >= 0.5 and self._tempo_period_frames > 0.0 and rms > 0.02:
            if self._next_tempo_beat_frame is None:
                self._next_tempo_beat_frame = self._frame_idx + self._tempo_period_frames
            if self._frame_idx >= self._next_tempo_beat_frame - 0.5:
                beat_tempo = True
                while self._next_tempo_beat_frame <= self._frame_idx + 0.5:
                    self._next_tempo_beat_frame += self._tempo_period_frames

        beat = beat_flux or beat_tempo
        flux_strength  = min(1.0, kick_flux / max(avg_kick_flux * 3.0, 1e-6))
        # Tempo-predicted beats get a moderate fixed strength — they are timing markers,
        # not measured transients, so do not inflate beat_strength from confidence.
        tempo_strength = 0.5 if (beat_tempo and not beat_flux) else 0.0
        beat_strength  = round(max(flux_strength, tempo_strength), 4)
        if beat_flux and beat_tempo:
            beat_source = "both"
        elif beat_flux:
            beat_source = "flux"
        elif beat_tempo:
            beat_source = "tempo"
        else:
            beat_source = "none"

        # ── Per-band rolling baseline + normalised bands ──────────────────
        # Slow EMA — only updated when we're actually hearing music. This
        # learns the typical energy of each band over the song; "dominant"
        # then means *unusually* hot for *this* track instead of the
        # always-true "bass is naturally loudest in music".
        if rms > 0.01:
            for name, val in bands_perceptual.items():
                self._band_baselines[name] = (
                    self._band_baselines[name] * (1.0 - BAND_BASELINE_ALPHA)
                    + val * BAND_BASELINE_ALPHA
                )

        # bands_norm: 0.5 = at-baseline, 1.0 = ≥2× baseline, 0.0 = silent.
        bands_norm: dict[str, float] = {}
        for name, val in bands_perceptual.items():
            base = max(self._band_baselines[name], BAND_BASELINE_FLOOR)
            ratio = val / base
            bands_norm[name] = round(float(np.clip(0.5 * min(ratio, 4.0), 0.0, 1.0)), 4)

        # dominant_band uses the same ratio (no clipping) so the "winner" is
        # still picked even when several bands are saturated.
        ratios = {
            n: bands_perceptual[n] / max(self._band_baselines[n], BAND_BASELINE_FLOOR)
            for n in bands_perceptual
        }
        dominant_band = max(ratios, key=ratios.get)

        # Energy-weighted hue from the perceptual (A-weighted) bands so the
        # cool end isn't artificially suppressed by the natural 1/f spectrum.
        bw = bands_perceptual
        warm  = bw.get('sub', 0) * 0.3 + bw.get('bass', 0) + bw.get('low_mid', 0) * 0.4
        mid_e = bw.get('mid', 0)
        cool  = bw.get('high_mid', 0) * 0.4 + bw.get('high', 0) + bw.get('air', 0) * 0.8
        total_e = warm + mid_e + cool + 1e-9
        energy_zone_hue = int(np.clip(
            (warm * 30.0 + mid_e * 150.0 + cool * 260.0) / total_e,
            0, 359
        ))

        return json.dumps({
            "rms":             round(rms, 4),
            "db":              db,
            "peak":            round(peak, 4),
            "bands":           bands,
            "bands_norm":      bands_norm,
            "fft":             fft_bins,
            "waveform":        [round(float(v), 3) for v in waveform],
            "beat":            beat,
            "beat_flux":       beat_flux,
            "beat_tempo":      beat_tempo,
            "beat_source":     beat_source,
            "beat_strength":   beat_strength,
            "tempo_bpm":       round(tempo_bpm, 2),
            "tempo_confidence": round(tempo_confidence, 4),
            "centroid":        round(centroid, 4),
            "flux":            round(flux, 4),
            "rolloff":         round(rolloff, 4),
            "bandwidth":       round(float(np.clip(bandwidth, 0.0, 1.0)), 4),
            "flatness":        round(float(np.clip(flatness, 0.0, 1.0)), 4),
            "zcr":             round(float(np.clip(zcr, 0.0, 1.0)), 4),
            "dominant_band":   dominant_band,
            "energy_zone_hue": energy_zone_hue,
            "kick_energy":     round(kick_energy, 4),
            "gain":            round(gain, 2),
        }, separators=(",", ":"))

    @staticmethod
    def _build_silence_frame() -> str:
        """JSON frame emitted while the noise gate is closed. All energy fields
        are zeroed so the visualiser scrolls into a clean black state instead
        of holding the last loud reading."""
        return json.dumps({
            "rms":             0.0,
            "db":              -90.0,
            "peak":            0.0,
            "bands":           {name: 0.0 for name, _, _ in _BAND_RANGES},
            "bands_norm":      {name: 0.0 for name, _, _ in _BAND_RANGES},
            "fft":             [0.0] * FFT_BINS,
            "waveform":        [0.5] * WAVEFORM_POINTS,
            "beat":            False,
            "beat_flux":       False,
            "beat_tempo":      False,
            "beat_source":     "none",
            "beat_strength":   0.0,
            "tempo_bpm":       0.0,
            "tempo_confidence": 0.0,
            "centroid":        0.0,
            "flux":            0.0,
            "rolloff":         0.0,
            "bandwidth":       0.0,
            "flatness":        0.0,
            "zcr":             0.0,
            "dominant_band":   "mid",
            "energy_zone_hue": 220,
            "kick_energy":     0.0,
            "gain":            1.0,
            "silent":          True,
        }, separators=(",", ":"))

    # ── Audio callback (real-time thread) ────────────────────────────────────

    def _audio_callback(self, in_data, frame_count, time_info, status):
        if not self.is_running:
            return (None, pyaudio.paContinue)
        # Reshape to (frames, channels) then mix to mono
        samples = np.frombuffer(in_data, dtype=np.int16).reshape(-1, self._capture_channels)
        new_hop = samples.mean(axis=1).astype(np.int16)  # HOP_SIZE samples

        # 50 % overlap — each analysis frame is the previous hop concatenated
        # with the new one, giving a BLOCK_SIZE window every HOP_SIZE samples.
        if not self._have_prev_hop:
            self._prev_hop = new_hop.copy()
            self._have_prev_hop = True
            # First callback only fills the buffer; nothing to analyse yet.
            self._vu_raw = float(np.sqrt(np.mean(
                (new_hop.astype(np.float32) / 32768.0) ** 2
            )))
            return (None, pyaudio.paContinue)

        analysis = np.concatenate((self._prev_hop, new_hop))
        self._prev_hop = new_hop  # rotate

        rms = float(np.sqrt(np.mean((analysis.astype(np.float32) / 32768.0) ** 2)))
        self._vu_raw = rms
        # Noise gate. Above threshold → run analysis. Below → emit a throttled
        # zeroed heartbeat so the visualiser stops holding the last loud frame.
        if rms >= self._gate_threshold:
            self._silence_counter = 0
            try:
                self.frame_queue.put_nowait(self._analyze_frame(analysis))
            except queue.Full:
                pass  # drop frame — never block the real-time thread
        else:
            # Below gate. Don't touch _prev_fft / flux histories — the adaptive
            # beat thresholds depend on a populated rolling window and quiet
            # passages mid-song dip below the gate all the time. Just emit a
            # throttled heartbeat so the visualiser knows it's silence.
            if self._silence_counter % SILENCE_HEARTBEAT_FRAMES == 0:
                if self._silence_payload is None:
                    self._silence_payload = self._build_silence_frame()
                try:
                    self.frame_queue.put_nowait(self._silence_payload)
                except queue.Full:
                    pass
            self._silence_counter += 1
        return (None, pyaudio.paContinue)

    # ── WebSocket send loop (background thread) ───────────────────────────────

    def _send_loop(self):
        while self.is_running:
            try:
                payload = self.frame_queue.get(timeout=0.5)
                if self.ws and self.ws.connected:
                    self.ws.send(payload)  # JSON text frame
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
                    frames_per_buffer=HOP_SIZE,
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
        self._prev_fft = None
        self._kick_flux_history = deque(maxlen=FLUX_HISTORY_SIZE)
        self._broad_flux_history = deque(maxlen=FLUX_HISTORY_SIZE)
        self._kick_env = 0.0
        self._agc_gain = 20.0
        self._frame_idx = 0
        self._onset_frames = []
        self._last_onset_frame = -10_000
        self._tempo_bpm = 0.0
        self._tempo_confidence = 0.0
        self._tempo_period_frames = 0.0
        self._next_tempo_beat_frame = None
        self._have_prev_hop = False
        self._prev_hop = np.zeros(HOP_SIZE, dtype=np.int16)
        self._band_baselines = {name: 0.05 for name, _, _ in _BAND_RANGES}
        self._silence_counter = 0
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
            text="Captures audio · analyses FFT · streams JSON over WebSocket",
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
