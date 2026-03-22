// CSS hue (0-360°) per dominant band
const BAND_CSS_HUES = {
  sub: 0,
  bass: 20,
  low_mid: 45,
  mid: 120,
  high_mid: 200,
  high: 270,
  air: 300,
};

/** Convert a CSS hue (0-360) to the Hue bridge hue scale (0-65535) */
function cssToBridgeHue(h) {
  return Math.round(((((h % 360) + 360) % 360) / 360) * 65535);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function remap(v, inLo, inHi, outLo, outHi) {
  const t = inHi === inLo ? 0 : (v - inLo) / (inHi - inLo);
  return outLo + clamp(t, 0, 1) * (outHi - outLo);
}

function $(id) {
  return document.getElementById(id);
}

// ─────────────────────────────────────────────────────────────────────────────

export class HueView {
  constructor() {
    this._s = this._loadSettings();
    this._lights = {};
    this._groups = {};
    this._selectedLights = new Set(this._s.selectedLights ?? []);
    this._pending = null;
    this._inflight = false; // prevent request stacking
    this._lastSentHue = -1; // delta filter
    this._lastSentBri = -1;
    this._beatActive = false;
    this._beatTimer = null;
    this._pairing = false;
    this._flushInterval = null;

    this._bindUI();
    this._updateSettingsVisibility();
    this._rescheduleFlush();

    // Auto-connect if we already have credentials
    if (this._s.bridgeIp && this._s.apiKey) {
      this._fetchAll();
    } else if (this._s.bridgeIp) {
      this._setBridgeStatus("IP saved — pair to get API key");
    }
  }

  // ── Settings persistence ──────────────────────────────────────────────────

  _defaults() {
    return {
      enabled: false,
      bridgeIp: "",
      apiKey: "",
      selectedLights: [],
      selectedGroup: "", // "" = individual lights mode
      colorSource: "energy_hue", // "energy_hue" | "band_color" | "static"
      staticHue: 0,
      staticSat: 200,
      brightnessSource: "rms", // "rms" | "beat_strength" | "static"
      staticBri: 200,
      minBri: 30,
      maxBri: 254,
      beatFlash: true,
      beatSource: "auto", // "auto" | "tempo" | "flux"
      transitionTime: 1, // deciseconds (0 = instant)
      hueDeltaThreshold: 500, // skip send if hue delta < this (0-65535)
      briDeltaThreshold: 4, // skip send if bri delta < this (0-254)
    };
  }

  _loadSettings() {
    try {
      const raw = localStorage.getItem("hue-settings");
      return { ...this._defaults(), ...(raw ? JSON.parse(raw) : {}) };
    } catch {
      return this._defaults();
    }
  }

  _save() {
    this._s.selectedLights = [...this._selectedLights];
    localStorage.setItem("hue-settings", JSON.stringify(this._s));
  }

  // ── UI binding ────────────────────────────────────────────────────────────

  _bindUI() {
    // Sidebar toggle
    $("hue-toggle-btn").addEventListener("click", () =>
      $("hue-panel").classList.toggle("open"),
    );
    $("hue-panel-close").addEventListener("click", () =>
      $("hue-panel").classList.remove("open"),
    );

    // Enable switch
    $("hue-enabled").checked = this._s.enabled;
    $("hue-enabled").addEventListener("change", (e) => {
      this._s.enabled = e.target.checked;
      this._save();
    });

    // Bridge IP field
    $("hue-bridge-ip").value = this._s.bridgeIp;

    $("hue-discover-btn").addEventListener("click", () => this._discover());

    $("hue-connect-btn").addEventListener("click", () => {
      const ip = $("hue-bridge-ip").value.trim();
      if (!ip) return;
      this._s.bridgeIp = ip;
      this._save();
      if (this._s.apiKey) this._fetchAll();
      else this._setBridgeStatus("IP saved — pair to get API key");
    });

    // Pairing
    $("hue-pair-btn").addEventListener("click", () => this._pair());

    // API key (manual override)
    $("hue-api-key").value = this._s.apiKey;
    $("hue-api-key").addEventListener("change", (e) => {
      this._s.apiKey = e.target.value.trim();
      this._save();
      if (this._s.bridgeIp && this._s.apiKey) this._fetchAll();
    });

    // Refresh lights & groups
    $("hue-refresh-btn").addEventListener("click", () => this._fetchAll());

    // Group selector
    $("hue-group-select").value = this._s.selectedGroup;
    $("hue-group-select").addEventListener("change", (e) => {
      this._s.selectedGroup = e.target.value;
      this._save();
      this._rescheduleFlush();
      this._updateGroupModeUI();
    });

    // Color source
    $("hue-color-source").value = this._s.colorSource;
    $("hue-color-source").addEventListener("change", (e) => {
      this._s.colorSource = e.target.value;
      this._save();
      this._updateSettingsVisibility();
    });

    // Static hue slider
    this._bindSlider("hue-static-hue", "staticHue", (v) => {
      $("hue-static-hue-val").textContent = `${v}°`;
      $("hue-static-hue-swatch").style.background = `hsl(${v},90%,55%)`;
    });

    // Static sat slider
    this._bindSlider("hue-static-sat", "staticSat", (v) => {
      $("hue-static-sat-val").textContent = Math.round((v / 254) * 100) + "%";
    });

    // Brightness source
    $("hue-bri-source").value = this._s.brightnessSource;
    $("hue-bri-source").addEventListener("change", (e) => {
      this._s.brightnessSource = e.target.value;
      this._save();
      this._updateSettingsVisibility();
    });

    // Static bri slider
    this._bindSlider("hue-static-bri", "staticBri", (v) => {
      $("hue-static-bri-val").textContent = Math.round((v / 254) * 100) + "%";
    });

    // Min / max bri sliders
    this._bindSlider("hue-min-bri", "minBri", (v) => {
      $("hue-min-bri-val").textContent = Math.round((v / 254) * 100) + "%";
    });
    this._bindSlider("hue-max-bri", "maxBri", (v) => {
      $("hue-max-bri-val").textContent = Math.round((v / 254) * 100) + "%";
    });

    // Beat flash toggle
    $("hue-beat-flash").checked = this._s.beatFlash;
    $("hue-beat-flash").addEventListener("change", (e) => {
      this._s.beatFlash = e.target.checked;
      this._save();
    });

    // Beat source mode
    $("hue-beat-source").value = this._s.beatSource;
    $("hue-beat-source").addEventListener("change", (e) => {
      this._s.beatSource = e.target.value;
      this._save();
    });

    // Transition time slider
    this._bindSlider("hue-transition", "transitionTime", (v) => {
      $("hue-transition-val").textContent =
        v === 0 ? "instant" : `${(v / 10).toFixed(1)} s`;
    });

    // Trigger initial display of values
    this._refreshSliderDisplays();
  }

  _bindSlider(id, settingKey, display) {
    const el = $(id);
    el.value = this._s[settingKey];
    display(this._s[settingKey]);
    el.addEventListener("input", (e) => {
      const v = +e.target.value;
      this._s[settingKey] = v;
      display(v);
      this._save();
    });
  }

  _refreshSliderDisplays() {
    $("hue-static-hue-val").textContent = `${this._s.staticHue}°`;
    $("hue-static-hue-swatch").style.background =
      `hsl(${this._s.staticHue},90%,55%)`;
    $("hue-static-sat-val").textContent =
      Math.round((this._s.staticSat / 254) * 100) + "%";
    $("hue-static-bri-val").textContent =
      Math.round((this._s.staticBri / 254) * 100) + "%";
    $("hue-min-bri-val").textContent =
      Math.round((this._s.minBri / 254) * 100) + "%";
    $("hue-max-bri-val").textContent =
      Math.round((this._s.maxBri / 254) * 100) + "%";
    $("hue-transition-val").textContent =
      this._s.transitionTime === 0
        ? "instant"
        : `${(this._s.transitionTime / 10).toFixed(1)} s`;
  }

  _updateSettingsVisibility() {
    const colorSrc = this._s.colorSource;
    $("hue-static-color-row").style.display =
      colorSrc === "static" ? "flex" : "none";

    const briSrc = this._s.brightnessSource;
    $("hue-static-bri-row").style.display =
      briSrc === "static" ? "flex" : "none";
    $("hue-bri-range-row").style.display =
      briSrc !== "static" ? "flex" : "none";
  }

  // ── Bridge discovery & pairing ────────────────────────────────────────────

  async _discover() {
    this._setBridgeStatus("Scanning network via mDNS…");
    $("hue-discover-btn").disabled = true;
    try {
      const res = await fetch("https://discovery.meethue.com/");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!data.length) {
        this._setBridgeStatus("No bridge found — enter IP manually");
        return;
      }
      const bridges = data.map((b) => b.internalipaddress);
      const ip = bridges[0];
      $("hue-bridge-ip").value = ip;
      this._s.bridgeIp = ip;
      this._save();
      this._setBridgeStatus(
        `Found ${bridges.length} bridge(s) → ${bridges.join(", ")}`,
      );
      if (this._s.apiKey) this._fetchLights();
    } catch {
      this._setBridgeStatus(
        "Discovery service unreachable — enter your bridge IP manually",
      );
    } finally {
      $("hue-discover-btn").disabled = false;
    }
  }

  async _pair() {
    const ip = $("hue-bridge-ip").value.trim();
    if (!ip) {
      this._setBridgeStatus("Enter bridge IP first");
      return;
    }
    this._s.bridgeIp = ip;
    this._save();
    $("hue-pair-btn").disabled = true;
    this._setBridgeStatus("Press the button on your bridge, then wait…");

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://${ip}/api`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ devicetype: "audio-visualizer#browser" }),
        });
        const data = await res.json();
        const username = data[0]?.success?.username;
        if (username) {
          this._s.apiKey = username;
          this._save();
          $("hue-api-key").value = username;
          this._setBridgeStatus("Paired successfully!");
          $("hue-pair-btn").disabled = false;
          this._fetchLights();
          return;
        }
        // data[0].error.type === 101 means "link button not pressed" — keep polling
      } catch {
        this._setBridgeStatus("Cannot reach bridge at " + ip);
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    this._setBridgeStatus("Timed out — press the button and retry");
    $("hue-pair-btn").disabled = false;
  }

  async _fetchAll() {
    const { bridgeIp: ip, apiKey: key } = this._s;
    if (!ip || !key) return;
    this._setBridgeStatus("Loading…");
    try {
      const [lightsRes, groupsRes] = await Promise.all([
        fetch(`http://${ip}/api/${key}/lights`),
        fetch(`http://${ip}/api/${key}/groups`),
      ]);
      const lightsData = await lightsRes.json();
      const groupsData = await groupsRes.json();

      if (Array.isArray(lightsData) && lightsData[0]?.error) {
        this._setBridgeStatus("Unauthorized — re-pair or check API key");
        return;
      }
      this._lights = lightsData;
      this._groups = groupsData;
      this._renderLightList();
      this._renderGroupSelector();
      this._rescheduleFlush();
      this._setBridgeStatus(
        `${Object.keys(lightsData).length} light(s), ${Object.keys(groupsData).length} group(s) loaded`,
      );
    } catch {
      this._setBridgeStatus("Cannot reach bridge — check IP");
    }
  }
  _renderGroupSelector() {
    const sel = $("hue-group-select");
    if (!sel) return;
    sel.innerHTML = '<option value="">— Individual lights —</option>';
    for (const [id, group] of Object.entries(this._groups)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = `${group.name} (${group.lights?.length ?? 0} lights)`;
      if (id === this._s.selectedGroup) opt.selected = true;
      sel.appendChild(opt);
    }
    this._updateGroupModeUI();
  }

  _updateGroupModeUI() {
    const groupMode = !!this._s.selectedGroup;
    const lightsSection = $("hue-lights-individual");
    if (lightsSection)
      lightsSection.style.display = groupMode ? "none" : "flex";
    const reqRateEl = $("hue-req-rate");
    if (reqRateEl) {
      if (groupMode) {
        reqRateEl.textContent = "1 req/flush (group mode ✓)";
        reqRateEl.style.color = "var(--accent)";
      } else {
        const n = this._selectedLights.size;
        const rate = this._flushMs();
        reqRateEl.textContent =
          n === 0
            ? "0 req/flush"
            : `${n} req / ${rate} ms ${n >= 3 ? "⚠ may saturate bridge" : ""}`;
        reqRateEl.style.color = n >= 3 ? "var(--beat)" : "var(--muted)";
      }
    }
  }
  _renderLightList() {
    const container = $("hue-light-list");
    container.innerHTML = "";
    for (const [id, light] of Object.entries(this._lights)) {
      const row = document.createElement("label");
      row.className = "hue-light-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = this._selectedLights.has(id);

      const dot = document.createElement("span");
      dot.className = "hue-light-dot";
      dot.style.background = light.state?.on
        ? `hsl(${Math.round((light.state.hue / 65535) * 360)},60%,55%)`
        : "#333";

      const name = document.createElement("span");
      name.className = "hue-light-name";
      name.textContent = `${id}. ${light.name}`;

      const type = document.createElement("span");
      type.className = "hue-light-type";
      type.textContent = light.type ?? "";

      cb.addEventListener("change", () => {
        if (cb.checked) this._selectedLights.add(id);
        else this._selectedLights.delete(id);
        this._save();
        this._rescheduleFlush();
        this._updateGroupModeUI();
      });

      row.appendChild(cb);
      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(type);
      container.appendChild(row);
    }
  }

  _setBridgeStatus(msg) {
    const el = $("hue-bridge-status");
    if (el) el.textContent = msg;
  }

  // ── Frame processing ──────────────────────────────────────────────────────

  /** Called every WS frame. Computes the desired Hue state (no I/O here). */
  update(frame) {
    if (!this._s.enabled) return;
    if (!this._s.bridgeIp || !this._s.apiKey) return;
    if (this._selectedLights.size === 0) return;

    // ── Color ──────────────────────────────────────────────────────
    let bridgeHue, bridgeSat;

    if (this._s.colorSource === "energy_hue") {
      // frame.energy_zone_hue is already a 0-360 CSS hue
      bridgeHue = cssToBridgeHue(frame.energy_zone_hue);
      bridgeSat = 254;
    } else if (this._s.colorSource === "band_color") {
      bridgeHue = cssToBridgeHue(BAND_CSS_HUES[frame.dominant_band] ?? 120);
      bridgeSat = 254;
    } else {
      bridgeHue = cssToBridgeHue(this._s.staticHue);
      bridgeSat = this._s.staticSat;
    }

    // ── Brightness ─────────────────────────────────────────────────
    let bri;

    if (this._s.brightnessSource === "rms") {
      bri = Math.round(
        remap(frame.rms, 0, 0.5, this._s.minBri, this._s.maxBri),
      );
    } else if (this._s.brightnessSource === "beat_strength") {
      bri = Math.round(
        remap(frame.beat_strength, 0, 1, this._s.minBri, this._s.maxBri),
      );
    } else {
      bri = this._s.staticBri;
    }
    bri = clamp(bri, this._s.minBri, this._s.maxBri);

    // ── Beat flash override (configurable source) ─────────────────────
    const beatSourceMode = this._s.beatSource || "auto";
    let beatForHue = false;
    if (beatSourceMode === "tempo") {
      beatForHue =
        typeof frame.beat_tempo === "boolean" ? frame.beat_tempo : !!frame.beat;
    } else if (beatSourceMode === "flux") {
      beatForHue =
        typeof frame.beat_flux === "boolean" ? frame.beat_flux : !!frame.beat;
    } else {
      const hasSplitBeats =
        typeof frame.beat_tempo === "boolean" ||
        typeof frame.beat_flux === "boolean";
      beatForHue = hasSplitBeats
        ? !!frame.beat_tempo || !!frame.beat_flux
        : !!frame.beat;
    }

    if (this._s.beatFlash && beatForHue) {
      bri = 254;
      this._beatActive = true;
      clearTimeout(this._beatTimer);
      this._beatTimer = setTimeout(() => {
        this._beatActive = false;
      }, 150);
    }

    this._pending = {
      on: true,
      hue: bridgeHue,
      sat: bridgeSat,
      bri,
      transitiontime: this._s.transitionTime,
    };
  }

  // ── Flush helpers ─────────────────────────────────────────────────────────

  /** Safe flush interval: 100 ms for group or 1 light, scaled for more */
  _flushMs() {
    if (this._s.selectedGroup) return 100;
    const n = this._selectedLights.size || 1;
    // bridge rate limit ~10 req/s total → give each extra light 80 ms headroom
    return Math.min(500, 100 + Math.max(0, n - 1) * 80);
  }

  _rescheduleFlush() {
    if (this._flushInterval) clearInterval(this._flushInterval);
    const ms = this._flushMs();
    this._flushInterval = setInterval(() => this._flush(), ms);
  }

  /** Throttled, guarded flush — sends latest pending state */
  _flush() {
    if (!this._pending) return;
    if (this._inflight) return; // previous request still in flight — skip

    const state = this._pending;
    this._pending = null;

    // ── Delta filter: skip if values barely changed ──────────────────────
    const hueDiff = Math.abs(state.hue - this._lastSentHue);
    const briDiff = Math.abs(state.bri - this._lastSentBri);
    const isBeat = state.bri === 254 && this._beatActive;
    if (
      !isBeat &&
      this._lastSentHue !== -1 &&
      hueDiff < this._s.hueDeltaThreshold &&
      briDiff < this._s.briDeltaThreshold
    ) {
      return;
    }
    this._lastSentHue = state.hue;
    this._lastSentBri = state.bri;

    const { bridgeIp: ip, apiKey: key } = this._s;
    this._inflight = true;

    // ── Group mode: 1 request for all lights ──────────────────────────────
    if (this._s.selectedGroup) {
      fetch(`http://${ip}/api/${key}/groups/${this._s.selectedGroup}/action`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      })
        .catch(() => {})
        .finally(() => {
          this._inflight = false;
        });
      return;
    }

    // ── Individual mode: sequential sends to avoid burst ─────────────────
    const ids = [...this._selectedLights];
    const sendNext = (i) => {
      if (i >= ids.length) {
        this._inflight = false;
        return;
      }
      fetch(`http://${ip}/api/${key}/lights/${ids[i]}/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      })
        .catch(() => {})
        .finally(() => sendNext(i + 1));
    };
    sendNext(0);
  }
}
