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
    this._inflight = false;
    this._lastSentHue = -1;
    this._lastSentBri = -1;
    this._beatEnv = 0;     // 0-1 exponential beat decay envelope
    this._smoothHue = 180; // low-passed hue angle
    this._flushInterval = null;

    this._bindUI();
    this._rescheduleFlush();

    if (this._s.bridgeIp && this._s.apiKey) {
      this._fetchAll();
    } else if (this._s.bridgeIp) {
      this._setBridgeStatus("IP saved — pair to get API key");
    }
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  _defaults() {
    return {
      enabled: false,
      bridgeIp: "",
      apiKey: "",
      selectedLights: [],
      selectedGroup: "",
      transitionTime: 0, // deciseconds; 0 = instant (best for beat flash)
      minBri: 30,        // minimum brightness between beats (1–254)
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

  // ── UI binding ─────────────────────────────────────────────────────────────

  _bindUI() {
    $("hue-toggle-btn").addEventListener("click", () =>
      $("hue-panel").classList.toggle("open"),
    );
    $("hue-panel-close").addEventListener("click", () =>
      $("hue-panel").classList.remove("open"),
    );

    $("hue-enabled").checked = this._s.enabled;
    $("hue-enabled").addEventListener("change", (e) => {
      this._s.enabled = e.target.checked;
      this._save();
    });

    $("hue-bridge-ip").value = this._s.bridgeIp;
    $("hue-connect-btn").addEventListener("click", () => {
      const ip = $("hue-bridge-ip").value.trim();
      if (!ip) return;
      this._s.bridgeIp = ip;
      this._save();
      if (this._s.apiKey) this._fetchAll();
      else this._setBridgeStatus("IP saved — pair to get API key");
    });

    $("hue-pair-btn").addEventListener("click", () => this._pair());

    $("hue-api-key").value = this._s.apiKey;
    $("hue-api-key").addEventListener("change", (e) => {
      this._s.apiKey = e.target.value.trim();
      this._save();
      if (this._s.bridgeIp && this._s.apiKey) this._fetchAll();
    });

    $("hue-refresh-btn").addEventListener("click", () => this._fetchAll());

    $("hue-group-select").value = this._s.selectedGroup;
    $("hue-group-select").addEventListener("change", (e) => {
      this._s.selectedGroup = e.target.value;
      this._save();
      this._rescheduleFlush();
      this._updateGroupModeUI();
    });

    this._bindSlider("hue-min-bri", "minBri", (v) => {
      $("hue-min-bri-val").textContent = Math.round((v / 254) * 100) + "%";
    });
    this._bindSlider("hue-transition", "transitionTime", (v) => {
      $("hue-transition-val").textContent =
        v === 0 ? "instant" : `${(v / 10).toFixed(1)} s`;
    });
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

  // ── Bridge pairing & connection ────────────────────────────────────────────

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
        // No Content-Type header → simple request, no CORS preflight.
        // generateclientkey: true is required for Bridge v2/Pro.
        const res = await fetch(`https://${ip}/api`, {
          method: "POST",
          body: JSON.stringify({
            devicetype: "audio-visualizer#browser",
            generateclientkey: true,
          }),
        });
        const data = await res.json();
        const username = data[0]?.success?.username;
        if (username) {
          this._s.apiKey = username;
          this._save();
          $("hue-api-key").value = username;
          this._setBridgeStatus("Paired successfully!");
          $("hue-pair-btn").disabled = false;
          this._fetchAll();
          return;
        }
        const errType = data[0]?.error?.type;
        const errDesc = data[0]?.error?.description ?? "";
        if (errType === 101) {
          const secsLeft = Math.round((deadline - Date.now()) / 1000);
          this._setBridgeStatus(`Waiting for button press… (${secsLeft}s)`);
        } else if (errType) {
          this._setBridgeStatus(`Bridge error ${errType}: ${errDesc}`);
          break;
        }
      } catch {
        this._setBridgeStatus(
          "Cannot reach bridge — if first time on HTTPS,",
          "accept certificate ↗",
          `https://${ip}`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    $("hue-pair-btn").disabled = false;
    const statusEl = $("hue-bridge-status");
    if (statusEl?.textContent?.startsWith("Waiting")) {
      this._setBridgeStatus("Timed out — press the button and retry");
    }
  }

  async _fetchAll() {
    const { bridgeIp: ip, apiKey: key } = this._s;
    if (!ip || !key) return;
    this._setBridgeStatus("Loading…");
    try {
      const [lightsRes, groupsRes] = await Promise.all([
        fetch(`https://${ip}/api/${key}/lights`),
        fetch(`https://${ip}/api/${key}/groups`),
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
      this._setBridgeStatus(
        "Cannot reach bridge — if first time on HTTPS,",
        "accept certificate ↗",
        `https://${ip}`,
      );
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
    if (lightsSection) lightsSection.style.display = groupMode ? "none" : "flex";
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
      });

      row.appendChild(cb);
      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(type);
      container.appendChild(row);
    }
  }

  _setBridgeStatus(msg, linkText, linkUrl) {
    const el = $("hue-bridge-status");
    if (!el) return;
    el.textContent = msg;
    if (linkText && linkUrl) {
      const a = document.createElement("a");
      a.href = linkUrl;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = " " + linkText;
      a.style.cssText = "color:var(--accent);text-decoration:underline;cursor:pointer";
      el.appendChild(a);
    }
  }

  // ── Frame processing ───────────────────────────────────────────────────────

  update(frame) {
    if (!this._s.enabled) return;
    if (!this._s.bridgeIp || !this._s.apiKey) return;
    if (!this._s.selectedGroup && this._selectedLights.size === 0) return;

    // Smooth the hue angle so lights don't jitter every frame
    const targetHue = frame.energy_zone_hue ?? this._smoothHue;
    this._smoothHue += (targetHue - this._smoothHue) * 0.12;
    const bridgeHue = cssToBridgeHue(this._smoothHue);

    // Ambient brightness follows overall loudness
    const ambientBri = clamp(
      Math.round(remap(frame.rms ?? 0, 0, 0.5, this._s.minBri, 200)),
      this._s.minBri, 200,
    );

    // Beat flux → punch envelope to 1.0; decays exponentially in _flush()
    if (frame.beat_flux) this._beatEnv = 1.0;

    const bri = Math.round(ambientBri + this._beatEnv * (254 - ambientBri));

    this._pending = {
      on: true,
      hue: bridgeHue,
      sat: 254,
      bri,
      transitiontime: this._beatEnv > 0.05 ? 0 : this._s.transitionTime,
    };
  }

  // ── Flush ──────────────────────────────────────────────────────────────────

  _flushMs() {
    // Bridge v2 REST API handles ~20 req/s total.
    if (this._s.selectedGroup) return 50;
    const n = this._selectedLights.size || 1;
    return n * 50;
  }

  _rescheduleFlush() {
    if (this._flushInterval) clearInterval(this._flushInterval);
    this._flushInterval = setInterval(() => this._flush(), this._flushMs());
  }

  _flush() {
    if (!this._pending) return;
    if (this._inflight) return;

    const state = this._pending;
    this._pending = null;

    const hueDiff = Math.abs(state.hue - this._lastSentHue);
    const briDiff = Math.abs(state.bri - this._lastSentBri);
    const isBeat = state.bri === 254 && this._beatActive;
    if (
      !isBeat &&
      this._lastSentHue !== -1 &&
      hueDiff < 500 &&
      briDiff < 4
    ) {
      return;
    }
    this._lastSentHue = state.hue;
    this._lastSentBri = state.bri;

    const { bridgeIp: ip, apiKey: key } = this._s;
    this._inflight = true;

    if (this._s.selectedGroup) {
      fetch(`https://${ip}/api/${key}/groups/${this._s.selectedGroup}/action`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      })
        .then((r) => { if (r.status === 429) console.warn("[hue] 429 rate limit"); })
        .catch(() => {})
        .finally(() => { this._inflight = false; });
      return;
    }

    const ids = [...this._selectedLights];
    const sendNext = (i) => {
      if (i >= ids.length) { this._inflight = false; return; }
      fetch(`https://${ip}/api/${key}/lights/${ids[i]}/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      })
        .then((r) => { if (r.status === 429) console.warn("[hue] 429 rate limit"); })
        .catch(() => {})
        .finally(() => sendNext(i + 1));
    };
    sendNext(0);
  }
}
