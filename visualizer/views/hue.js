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

function _set(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ─────────────────────────────────────────────────────────────────────────────

export class HueView {
  constructor() {
    this._s = this._loadSettings();
    this._lights = {};
    this._groups = {};
    this._selectedLights = new Set(this._s.selectedLights ?? []);

    // Outgoing-state machine
    this._pending = null;
    this._inflight = false;
    this._lastSentHue = -1;
    this._lastSentBri = -1;
    this._lastSentSat = -1;
    this._beatEnv = 0;     // 0-1 exponential beat envelope (decays in update())
    this._smoothHue = 180; // low-passed CSS hue angle
    this._lastUpdate = null; // for time-based beat decay
    this._flushInterval = null;

    // Live monitor — what's actually being sent + counters
    this._stats = { total: 0, ok: 0, ratelimit: 0, error: 0 };
    this._reqLog = []; // {t, outcome} kept ~30 s for sparkline + req/s
    this._lastPayload = null;
    this._lastPayloadAt = 0;
    this._perTargetState = new Map(); // "light/3" or "group/1" → { …state, t }

    this._bindUI();
    this._rescheduleFlush();
    this._monitorTick();

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
      hueSpread: 60,     // total degrees spread across N selected lights
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
    this._bindSlider("hue-spread", "hueSpread", (v) => {
      $("hue-spread-val").textContent = v === 0 ? "off" : `±${Math.round(v / 2)}°`;
    });

    const resetBtn = $("hue-stats-reset");
    if (resetBtn) resetBtn.addEventListener("click", () => this.resetStats());
  }

  _bindSlider(id, settingKey, display) {
    const el = $(id);
    if (!el) return;
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
    // Time-based beat-envelope decay — runs even when disabled so the
    // monitor swatch decays consistently. Half-life ≈ 180 ms.
    const now = performance.now();
    if (this._lastUpdate != null) {
      const dt = Math.min((now - this._lastUpdate) / 1000, 0.5);
      this._beatEnv *= Math.pow(0.5, dt / 0.18);
    }
    this._lastUpdate = now;

    if (!this._s.enabled) return;
    if (!this._s.bridgeIp || !this._s.apiKey) return;
    if (!this._s.selectedGroup && this._selectedLights.size === 0) return;

    // Smooth the hue angle so lights don't jitter every frame
    const targetHue = frame.energy_zone_hue ?? this._smoothHue;
    this._smoothHue += (targetHue - this._smoothHue) * 0.12;

    // Saturation from spectral flatness — pure tones (single instrument) are
    // pushed toward fully saturated; noisy/dense spectra get a gentle desat
    // so the room doesn't blast eye-searing colour during a wash of noise.
    const flatness = clamp(frame.flatness ?? 0.2, 0, 1);
    const sat = Math.round(remap(flatness, 0.0, 0.7, 254, 170));

    // Ambient brightness follows overall loudness
    const ambientBri = clamp(
      Math.round(remap(frame.rms ?? 0, 0, 0.5, this._s.minBri, 200)),
      this._s.minBri, 200,
    );

    // Any beat (kick or broadband) → punch envelope to 1.0; decays above.
    if (frame.beat) this._beatEnv = Math.max(this._beatEnv, 1.0);

    const bri = Math.round(ambientBri + this._beatEnv * (254 - ambientBri));

    this._pending = {
      on: true,
      hue: cssToBridgeHue(this._smoothHue),
      sat,
      bri,
      transitiontime: this._beatEnv > 0.05 ? 0 : this._s.transitionTime,
    };
  }

  // ── Flush ──────────────────────────────────────────────────────────────────

  _flushMs() {
    // Bridge v1 REST API: ~10 req/s/light, ~20 req/s/group. We send all
    // lights in parallel (Promise.allSettled) so a 5-light setup at 50 ms
    // = 100 reqs/s sustained which is well within the limit.
    if (this._s.selectedGroup) return 50;
    return 50;
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

    // Suppress redundant sends — but always allow during a beat-flash so
    // the brightness pulse arrives even if hue/bri haven't moved much.
    const isBeat = this._beatEnv > 0.5;
    const hueDiff = Math.abs(state.hue - this._lastSentHue);
    const briDiff = Math.abs(state.bri - this._lastSentBri);
    const satDiff = Math.abs(state.sat - this._lastSentSat);
    if (
      !isBeat &&
      this._lastSentHue !== -1 &&
      hueDiff < 500 &&
      briDiff < 4 &&
      satDiff < 6
    ) {
      return;
    }
    this._lastSentHue = state.hue;
    this._lastSentBri = state.bri;
    this._lastSentSat = state.sat;
    this._lastPayload = state;
    this._lastPayloadAt = performance.now();

    this._inflight = true;
    if (this._s.selectedGroup) {
      const target = `group/${this._s.selectedGroup}`;
      const url = `https://${this._s.bridgeIp}/api/${this._s.apiKey}/groups/${this._s.selectedGroup}/action`;
      this._sendRequest(url, state, target).finally(() => {
        this._inflight = false;
      });
      return;
    }

    const ids = [...this._selectedLights];
    const promises = ids.map((id, i) => {
      const lightState = this._stateForLight(state, i, ids.length);
      const url = `https://${this._s.bridgeIp}/api/${this._s.apiKey}/lights/${id}/state`;
      return this._sendRequest(url, lightState, `light/${id}`);
    });
    Promise.allSettled(promises).finally(() => {
      this._inflight = false;
    });
  }

  // For N selected lights, spread the hue across the configured arc so the
  // room sweeps colour instead of every bulb flashing identical.
  _stateForLight(base, i, n) {
    const spread = this._s.hueSpread ?? 0;
    if (n <= 1 || spread <= 0) return base;
    const offset = (i / (n - 1) - 0.5) * spread;
    const css = ((this._smoothHue + offset) % 360 + 360) % 360;
    return { ...base, hue: cssToBridgeHue(css) };
  }

  async _sendRequest(url, body, target) {
    const t = performance.now();
    let outcome = "error";
    try {
      const r = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) outcome = "ok";
      else if (r.status === 429) outcome = "ratelimit";
      else outcome = "error";
    } catch {
      outcome = "error";
    }
    this._stats.total++;
    this._stats[outcome]++;
    this._reqLog.push({ t, outcome });
    this._perTargetState.set(target, { ...body, t, outcome });
    return outcome;
  }

  resetStats() {
    this._stats = { total: 0, ok: 0, ratelimit: 0, error: 0 };
    this._reqLog = [];
    this._perTargetState.clear();
    this._lastPayload = null;
    this._lastPayloadAt = 0;
  }

  // ── Live monitor render (10 Hz — independent of audio frame rate) ─────────

  _monitorTick() {
    this._renderMonitor();
    setTimeout(() => this._monitorTick(), 100);
  }

  _renderMonitor() {
    const now = performance.now();

    // Trim req log to last 30 s
    const cutoff = now - 30_000;
    while (this._reqLog.length && this._reqLog[0].t < cutoff) this._reqLog.shift();

    // Live target swatch — reflects the most recent sent state
    if (this._lastPayload) {
      const cssHue = (this._lastPayload.hue / 65535) * 360;
      const sat = (this._lastPayload.sat / 254) * 100;
      const bri = this._lastPayload.bri / 254;
      const lightness = 25 + bri * 45;
      const sw = $("hue-monitor-swatch");
      if (sw) sw.style.background = `hsl(${cssHue}, ${sat}%, ${lightness}%)`;

      _set(
        "hue-monitor-hue-val",
        `${Math.round(cssHue)}°  s${this._lastPayload.sat}  b${this._lastPayload.bri}`,
      );

      const fill = $("hue-monitor-bri");
      if (fill) fill.style.width = `${(this._lastPayload.bri / 254) * 100}%`;

      const json = $("hue-monitor-json");
      if (json) {
        const ageMs = Math.round(now - this._lastPayloadAt);
        json.textContent = `↑ ${ageMs} ms ago\n${JSON.stringify(this._lastPayload, null, 2)}`;
      }
    } else {
      const sw = $("hue-monitor-swatch");
      if (sw) sw.style.background = "#1a1a1a";
      _set("hue-monitor-hue-val", "—");
      const fill = $("hue-monitor-bri");
      if (fill) fill.style.width = "0%";
      const json = $("hue-monitor-json");
      if (json) json.textContent = "— nothing sent yet —";
    }

    // Counters
    _set("hue-stat-total", this._stats.total);
    _set("hue-stat-ok",    this._stats.ok);
    _set("hue-stat-429",   this._stats.ratelimit);
    _set("hue-stat-err",   this._stats.error);

    const inLast1s = this._reqLog.reduce(
      (n, r) => n + (r.t > now - 1000 ? 1 : 0), 0,
    );
    _set("hue-stat-rate", inLast1s);

    this._drawSparkline(now);
    this._renderPerLightList(now);
  }

  _drawSparkline(now) {
    const canvas = $("hue-rate-spark");
    if (!canvas) return;
    const W = canvas.width;
    const H = canvas.height;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);

    // 30 buckets of 1 s each — most-recent bucket is rightmost
    const BUCKETS = 30;
    const okBins  = new Array(BUCKETS).fill(0);
    const errBins = new Array(BUCKETS).fill(0);
    for (const r of this._reqLog) {
      const ageS = (now - r.t) / 1000;
      const idx = Math.floor(BUCKETS - 1 - ageS);
      if (idx < 0 || idx >= BUCKETS) continue;
      if (r.outcome === "ok") okBins[idx]++;
      else errBins[idx]++;
    }
    const max = Math.max(1, ...okBins.map((v, i) => v + errBins[i]));
    const bw = W / BUCKETS;

    for (let i = 0; i < BUCKETS; i++) {
      const okH  = (okBins[i]  / max) * H;
      const errH = (errBins[i] / max) * H;
      const x = i * bw;
      ctx.fillStyle = "rgba(34, 204, 102, 0.65)";
      ctx.fillRect(x + 1, H - okH, bw - 2, okH);
      if (errH > 0) {
        ctx.fillStyle = "rgba(255, 68, 68, 0.7)";
        ctx.fillRect(x + 1, H - okH - errH, bw - 2, errH);
      }
    }

    // Baseline
    ctx.strokeStyle = "#222";
    ctx.beginPath();
    ctx.moveTo(0, H - 0.5);
    ctx.lineTo(W, H - 0.5);
    ctx.stroke();
  }

  _renderPerLightList(now) {
    const container = $("hue-per-light-list");
    if (!container) return;
    const targets = this._s.selectedGroup
      ? [`group/${this._s.selectedGroup}`]
      : [...this._selectedLights].map((id) => `light/${id}`);

    // Build/refresh — recreate cheaply since the list is small (≤ 20 lights)
    container.innerHTML = "";
    for (const key of targets) {
      const state = this._perTargetState.get(key);
      const row = document.createElement("div");
      row.className = "hue-perlight-row";

      const dot = document.createElement("div");
      dot.className = "hue-perlight-dot";
      const label = document.createElement("span");
      label.className = "hue-perlight-label";
      const meta = document.createElement("span");
      meta.className = "hue-perlight-meta";

      label.textContent = key;
      if (state) {
        const cssHue = (state.hue / 65535) * 360;
        const sat = (state.sat / 254) * 100;
        const briL = 25 + (state.bri / 254) * 45;
        dot.style.background = `hsl(${cssHue}, ${sat}%, ${briL}%)`;
        const ageMs = Math.round(now - state.t);
        const ageStr = ageMs < 1000 ? `${ageMs}ms` : `${(ageMs / 1000).toFixed(1)}s`;
        const tag =
          state.outcome === "ok" ? ""
          : state.outcome === "ratelimit" ? " · 429"
          : " · err";
        meta.textContent = `${ageStr}${tag}`;
        meta.style.color =
          state.outcome === "ok" ? "var(--muted)"
          : state.outcome === "ratelimit" ? "#f0a500"
          : "var(--beat)";
      } else {
        dot.style.background = "#1a1a1a";
        meta.textContent = "—";
      }

      row.appendChild(dot);
      row.appendChild(label);
      row.appendChild(meta);
      container.appendChild(row);
    }
  }
}
