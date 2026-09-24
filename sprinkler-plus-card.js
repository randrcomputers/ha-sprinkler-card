/**
 * Sprinkler Plus — Home Assistant Lovelace.
 * Zone pie with remaining time, manual run queue, and optional rain delay.
 */
(function () {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const { html, css } = LitElement.prototype;

  const DEFAULTS = Object.freeze({
    name: "Sprinklers",
    size: "100",
    default_duration: 15,
    show_actions: true,
    compact: false,
  });

  const ZONE_COLORS = Object.freeze([
    "#2e9a4a",
    "#3aaa62",
    "#1f8a6a",
    "#4c9a3a",
    "#2f7d46",
    "#3d8f7a",
    "#5aa04a",
    "#217a55",
  ]);

  const CX = 120;
  const CY = 120;
  const R0 = 54;
  const R1 = 96;
  const TRACK = 107;

  function sizeOf(config) {
    const id = String(config?.size ?? "100");
    return id === "50" || id === "75" || id === "100" ? id : "100";
  }

  function num(config, key, fallback) {
    const v = config?.[key];
    if (v === undefined || v === null || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function mergeConfig(config) {
    const merged = { ...DEFAULTS, ...(config || {}) };
    merged.size = sizeOf(merged);
    const duration = Number(merged.default_duration);
    merged.default_duration =
      Number.isFinite(duration) && duration > 0 ? Math.min(720, duration) : 15;
    merged.show_actions = merged.show_actions !== false;
    merged.compact = merged.compact === true;
    return merged;
  }

  function clampDurationMin(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(720, Math.max(1, n));
  }

  function parseDurationList(value) {
    if (Array.isArray(value)) {
      return value.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
    }
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? [value] : [];
    if (!value) return [];
    return String(value)
      .split(/[, ]+/)
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  function normalizeZones(config) {
    const raw = config?.zones;
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === "string") list = raw.split(/[\s,]+/).filter(Boolean);
    else if (raw) list = [raw];
    const fromList = parseDurationList(config?.durations);
    const fallback = clampDurationMin(config?.default_duration, 15);
    const out = [];
    list.forEach((item, index) => {
      let entity = "";
      let name = "";
      let remainingEntity = "";
      let explicit = null;
      if (typeof item === "string") entity = item.trim();
      else if (item && typeof item === "object") {
        entity = String(item.entity || item.entity_id || "").trim();
        name = item.name ? String(item.name) : "";
        remainingEntity = String(item.remaining_entity || item.remaining || "").trim();
        const d = Number(item.duration);
        if (Number.isFinite(d) && d > 0) explicit = d;
      }
      if (!entity || !entity.includes(".")) return;
      out.push({
        entity,
        name,
        remaining_entity: remainingEntity,
        durationMin: clampDurationMin(explicit || fromList[index], fallback),
        explicitDuration: explicit != null,
      });
    });
    return out;
  }

  function entityState(hass, entityId) {
    if (!entityId || !hass?.states?.[entityId]) return null;
    return hass.states[entityId];
  }

  function domainOf(entityId) {
    return String(entityId || "").split(".")[0];
  }

  function canControl(entityId) {
    const domain = domainOf(entityId);
    return domain === "switch" || domain === "valve" || domain === "input_boolean";
  }

  function isOn(st) {
    const state = st?.state;
    return state === "on" || state === "open" || state === "opening" || state === "active";
  }

  function isUnavailable(st) {
    if (!st) return true;
    return st.state === "unavailable" || st.state === "unknown";
  }

  function changedMs(st) {
    const t = Date.parse(st?.last_changed || "");
    return Number.isFinite(t) ? t : null;
  }

  function parseDurationSeconds(value, unit) {
    if (value == null) return null;
    const raw = String(value).trim().toLowerCase();
    if (!raw || raw === "unknown" || raw === "unavailable" || raw === "none" || raw === "null") {
      return null;
    }
    const clock = raw.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (clock) {
      if (clock[3] != null) {
        return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
      }
      return Number(clock[1]) * 60 + Number(clock[2]);
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    const u = String(unit || "").toLowerCase();
    if (u.startsWith("h")) return n * 3600;
    if (u.startsWith("min")) return n * 60;
    return n;
  }

  function readRemainingSeconds(hass, spec, st) {
    if (spec.remaining_entity) {
      const rs = entityState(hass, spec.remaining_entity);
      const fromSensor = parseDurationSeconds(rs?.state, rs?.attributes?.unit_of_measurement);
      if (fromSensor != null) return fromSensor;
    }
    const attrs = st?.attributes || {};
    const keys = ["remaining", "remaining_seconds", "time_remaining", "timer_remaining", "countdown"];
    for (const key of keys) {
      if (attrs[key] == null || attrs[key] === "") continue;
      const unit = key.includes("seconds") ? "s" : attrs.unit_of_measurement || "";
      const parsed = parseDurationSeconds(attrs[key], unit);
      if (parsed != null) return parsed;
    }
    return null;
  }

  function deviceRunSeconds(st) {
    const runtime = Number(st?.attributes?.current_runtime);
    if (!Number.isFinite(runtime) || runtime <= 0) return null;
    return runtime * 60;
  }

  function deviceStartedMs(st) {
    const t = Date.parse(st?.attributes?.started_watering_station_at || "");
    return Number.isFinite(t) ? t : null;
  }

  function runStoreKey(entity) {
    return `sprinkler-plus-card:run:${entity}`;
  }

  function saveRun(entity, seconds, started) {
    try {
      localStorage.setItem(runStoreKey(entity), JSON.stringify({ seconds, started }));
    } catch {
      /* private mode */
    }
  }

  function loadRun(entity) {
    try {
      const saved = JSON.parse(localStorage.getItem(runStoreKey(entity)) || "null");
      if (!saved || !Number.isFinite(saved.seconds) || saved.seconds <= 0 || !Number.isFinite(saved.started)) {
        return null;
      }
      const age = (Date.now() - saved.started) / 1000;
      if (age < -30 || age > saved.seconds + 180) return null;
      return saved;
    } catch {
      return null;
    }
  }

  function clearRun(entity) {
    try {
      localStorage.removeItem(runStoreKey(entity));
    } catch {
      /* private mode */
    }
  }

  const CYCLE_GAP_MS = 3 * 60 * 1000;

  function cycleStoreKey(ids) {
    return `sprinkler-plus-card:cycle:${ids}`;
  }

  function loadCycle(ids) {
    try {
      const saved = JSON.parse(localStorage.getItem(cycleStoreKey(ids)) || "null");
      if (!saved || !Number.isFinite(saved.started) || !Number.isFinite(saved.lastOn)) return null;
      if (Date.now() - saved.lastOn > CYCLE_GAP_MS) return null;
      const idsOf = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === "string") : []);
      return {
        started: saved.started,
        lastOn: saved.lastOn,
        floor: Number(saved.floor) || 0,
        program: String(saved.program || ""),
        done: idsOf(saved.done),
        seen: idsOf(saved.seen),
      };
    } catch {
      return null;
    }
  }

  function saveCycle(ids, cycle) {
    try {
      localStorage.setItem(cycleStoreKey(ids), JSON.stringify(cycle));
    } catch {
      /* private mode */
    }
  }

  function clearCycleStore(ids) {
    try {
      localStorage.removeItem(cycleStoreKey(ids));
    } catch {
      /* private mode */
    }
  }

  function historyForZone(hass, st) {
    if (!hass || !st) return null;
    const station = st.attributes?.station;
    if (station != null && station !== "") {
      const hit = entityState(hass, `sensor.zone_${station}_zone_history`);
      if (hit) return hit;
    }
    const device = st.attributes?.device_id;
    const zoneName = String(st.attributes?.zone_name || "").trim().toLowerCase();
    if (!device || !zoneName) return null;
    return (
      Object.values(hass.states).find((s) => {
        if (!s?.entity_id?.startsWith("sensor.") || !/history/i.test(s.entity_id)) return false;
        if (s.attributes?.device_id !== device) return false;
        return String(s.attributes?.friendly_name || "").toLowerCase().includes(zoneName);
      }) || null
    );
  }

  function programRunMs(st, program) {
    const key = String(program || "").toLowerCase();
    if (!key || key === "manual") return null;
    const plan = st?.attributes?.[`program_${key}`];
    const list = plan?.run_times;
    const hit = Array.isArray(list) ? list.find((row) => Number(row?.run_time) > 0) : null;
    const minutes = Number(hit?.run_time);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : null;
  }

  function formatClock(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return "—";
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  function formatMinutes(min) {
    if (!Number.isFinite(min)) return "—";
    const rounded = Math.round(min * 10) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${text} min`;
  }

  function sliceLayout(weights) {
    const n = weights.length;
    if (!n) return [];
    const gap = n > 1 ? 2.6 : 0;
    const available = 360 - gap * n;
    const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 1));
    const sum = safe.reduce((a, b) => a + b, 0);
    let spans = safe.map((w) => (w / sum) * available);
    if (n <= 12) {
      const min = Math.min(16, available / n);
      for (let guard = 0; guard < 4 && spans.some((s) => s < min - 0.01); guard += 1) {
        let deficit = 0;
        spans = spans.map((s) => {
          if (s < min) {
            deficit += min - s;
            return min;
          }
          return s;
        });
        const donors = spans
          .map((s, i) => ({ i, extra: s - min }))
          .filter((d) => d.extra > 0.5);
        const extraSum = donors.reduce((a, d) => a + d.extra, 0);
        if (extraSum <= 0) break;
        const take = Math.min(deficit, extraSum);
        for (const donor of donors) spans[donor.i] -= take * (donor.extra / extraSum);
      }
    }
    const slices = [];
    let cursor = 0;
    for (let i = 0; i < n; i += 1) {
      slices.push({ start: cursor, span: spans[i] });
      cursor += spans[i] + gap;
    }
    return slices;
  }

  function polar(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  function fmt(v) {
    return (Math.round(v * 100) / 100).toString();
  }

  function arcD(cx, cy, r, a0, a1) {
    const span = a1 - a0;
    if (span <= 0.4) return "";
    if (span >= 359.5) {
      return `${arcD(cx, cy, r, a0, a0 + 180)} ${arcD(cx, cy, r, a0 + 180, a0 + 359.2)}`;
    }
    const large = span > 180 ? 1 : 0;
    const [x0, y0] = polar(cx, cy, r, a0);
    const [x1, y1] = polar(cx, cy, r, a1);
    return `M ${fmt(x0)} ${fmt(y0)} A ${fmt(r)} ${fmt(r)} 0 ${large} 1 ${fmt(x1)} ${fmt(y1)}`;
  }

  function donutD(cx, cy, r0, r1, a0, a1) {
    const span = a1 - a0;
    if (span <= 0.4) return "";
    if (span >= 359.5) {
      return `${donutD(cx, cy, r0, r1, a0, a0 + 180)} ${donutD(cx, cy, r0, r1, a0 + 180, a0 + 359.2)}`;
    }
    const large = span > 180 ? 1 : 0;
    const [ox0, oy0] = polar(cx, cy, r1, a0);
    const [ox1, oy1] = polar(cx, cy, r1, a1);
    const [ix1, iy1] = polar(cx, cy, r0, a1);
    const [ix0, iy0] = polar(cx, cy, r0, a0);
    return `M ${fmt(ox0)} ${fmt(oy0)} A ${fmt(r1)} ${fmt(r1)} 0 ${large} 1 ${fmt(ox1)} ${fmt(oy1)} L ${fmt(ix1)} ${fmt(iy1)} A ${fmt(r0)} ${fmt(r0)} 0 ${large} 0 ${fmt(ix0)} ${fmt(iy0)} Z`;
  }

  function turn(hass, entityId, on) {
    const domain = domainOf(entityId);
    if (domain === "valve") {
      return hass.callService("valve", on ? "open_valve" : "close_valve", { entity_id: entityId });
    }
    if (domain === "switch" || domain === "input_boolean") {
      return hass.callService(domain, on ? "turn_on" : "turn_off", { entity_id: entityId });
    }
    return Promise.resolve();
  }

  function zoneColor(index) {
    return ZONE_COLORS[index % ZONE_COLORS.length];
  }

  class SprinklerPlusCard extends LitElement {
    static get properties() {
      return {
        hass: {},
        config: {},
        _selected: { state: true },
        _tick: { state: true },
        _error: { state: true },
        _zonesOpen: { state: true },
        _manualOpen: { state: true },
        _delayOpen: { state: true },
        _programOpen: { state: true },
      };
    }

    static getConfigElement() {
      return document.createElement("sprinkler-plus-card-editor");
    }

    static getStubConfig(hass) {
      const ids = Object.keys(hass?.states || {});
      const zones = ids
        .filter((id) => {
          const domain = domainOf(id);
          if (domain !== "switch" && domain !== "valve" && domain !== "input_boolean") return false;
          return /sprinkler|irrigat|zone|station|valve|lawn|yard|drip/i.test(id);
        })
        .slice(0, 8);
      const delay = ids.find((id) => /rain_delay|raindelay/i.test(id)) || "";
      const stub = {
        type: "custom:sprinkler-plus-card",
        name: "Sprinklers",
        size: "100",
        zones,
        default_duration: 15,
      };
      if (delay) stub.rain_delay_entity = delay;
      return stub;
    }

    constructor() {
      super();
      this._selected = 0;
      this._tick = 0;
      this._error = "";
      this._zonesOpen = false;
      this._manualOpen = false;
      this._delayOpen = false;
      this._programOpen = false;
      this._openReady = false;
      this._checked = {};
      this._minutes = {};
      this._queue = [];
      this._queueSawOn = {};
      this._runFor = {};
      this._bhyveRun = {};
      this._allMinutes = 15;
      this._delayPick = 24;
      this._advancing = false;
      this._picked = false;
      this._seenOn = {};
      this._wasOn = {};
      this._owned = {};
      this._done = {};
      this._cycle = null;
      this._cycleReady = false;
      this._cycleFloor = 0;
      this._ignoreOffUntil = 0;
      this._stopping = {};
      this._uid = `sp${Math.random().toString(36).slice(2, 8)}`;
    }

    getCardSize() {
      const count = normalizeZones(this.config).length;
      const size = Number(sizeOf(this.config));
      const base = count > 4 ? 6 : 5;
      return Math.max(3, Math.round((base * size) / 100));
    }

    setConfig(config) {
      if (!config || typeof config !== "object") throw new Error("Invalid configuration");
      this.config = mergeConfig(config);
      this.dataset.size = sizeOf(this.config);
      if (this.config.compact) this.setAttribute("compact", "");
      else this.removeAttribute("compact");
    }

    connectedCallback() {
      super.connectedCallback();
      this._clock = setInterval(() => this._onClock(), 1000);
    }

    disconnectedCallback() {
      super.disconnectedCallback();
      if (this._clock) clearInterval(this._clock);
      this._clock = null;
    }

    updated() {
      this.dataset.size = sizeOf(this.config);
    }

    _foldKey(name) {
      const ids = normalizeZones(this.config)
        .map((z) => z.entity)
        .join("|");
      return `sprinkler-plus-card:${name}:${ids}`;
    }

    _rememberOpen() {
      if (this._openReady || !this.config) return;
      this._openReady = true;
      const apply = (name, prop) => {
        try {
          if (localStorage.getItem(this._foldKey(name)) === "1") this[prop] = true;
        } catch {
          /* private mode */
        }
      };
      apply("zones", "_zonesOpen");
      apply("manual", "_manualOpen");
      apply("delay", "_delayOpen");
      apply("program", "_programOpen");
    }

    _toggleFold(name, prop) {
      this[prop] = !this[prop];
      try {
        localStorage.setItem(this._foldKey(name), this[prop] ? "1" : "0");
      } catch {
        /* private mode */
      }
    }

    _foldHead(label, count, open, name, prop) {
      return html`
        <button
          type="button"
          class="list-toggle"
          aria-expanded=${open ? "true" : "false"}
          @click=${() => this._toggleFold(name, prop)}
        >
          <span class="list-title">${label}</span>
          <span class="list-count">${count}</span>
          <span class="chev ${open ? "open" : ""}"></span>
        </button>
      `;
    }

    willUpdate() {
      this._rememberOpen();
      this._syncRunClocks();
      if (!this._picked && this.hass && this.config) {
        const zones = this._zoneModels();
        const running = zones.findIndex((z) => z.active);
        if (running >= 0 && this._selected !== running) this._selected = running;
      }
    }

    _onClock() {
      if (!this.hass || !this.config) return;
      this._autoOff();
      this._maybeAdvanceQueue();
      if (this._needsClock()) this._tick = (this._tick || 0) + 1;
    }

    _needsClock() {
      const zones = this._zoneModels();
      const cycleFresh = this._cycle && Date.now() - this._cycle.lastOn <= CYCLE_GAP_MS;
      return zones.some((z) => z.active || this._owned[z.entity]) || Boolean(this._queue?.length) || Boolean(cycleFresh);
    }

    _cycleIds() {
      return normalizeZones(this.config).map((z) => z.entity).join("|");
    }

    _loadCycle() {
      if (this._cycleReady || !this.config) return;
      this._cycleReady = true;
      this._cycle = loadCycle(this._cycleIds());
      if (!this._cycle) return;
      const done = {};
      for (const id of this._cycle.done) done[id] = true;
      this._done = done;
    }

    _saveCycle() {
      if (!this._cycle || !this.config) return;
      saveCycle(this._cycleIds(), this._cycle);
    }

    _clearCycle() {
      this._cycle = null;
      this._done = {};
      if (this.config) clearCycleStore(this._cycleIds());
    }

    _markDone(entity) {
      if (!entity || Date.now() < (this._ignoreOffUntil || 0)) return;
      if (!this._cycle) {
        this._cycle = {
          started: Date.now(),
          lastOn: Date.now(),
          floor: this._cycleFloor || 0,
          program: "",
          done: [],
          seen: [],
        };
      }
      if (!this._cycle.done.includes(entity)) this._cycle.done.push(entity);
      this._cycle.seen = (this._cycle.seen || []).filter((id) => id !== entity);
      this._cycle.lastOn = Date.now();
      if (!this._done[entity]) this._done = { ...this._done, [entity]: true };
      this._saveCycle();
    }

    _applyCloseChain(onStates) {
      if (!this._cycle || !onStates.length) return;
      const active = onStates.slice().sort((a, b) => (deviceStartedMs(b) || 0) - (deviceStartedMs(a) || 0))[0];
      const currentStart = deviceStartedMs(active) || changedMs(active);
      if (!currentStart) return;
      const program = String(this._cycle.program || active?.attributes?.current_program || "").toLowerCase();
      const floor = Number(this._cycle.floor) || 0;
      const specs = normalizeZones(this.config);
      const rows = [];
      for (const spec of specs) {
        const st = entityState(this.hass, spec.entity);
        if (!st || isOn(st)) continue;
        const closedAt = changedMs(st);
        if (!closedAt) continue;
        const runMs = programRunMs(st, program) || (Number(spec.durationMin) || 15) * 60000;
        rows.push({ entity: spec.entity, closedAt, runMs });
      }
      rows.sort((a, b) => b.closedAt - a.closedAt);
      let cursor = currentStart;
      let gapLimit = 5 * 60000;
      for (const row of rows) {
        if (floor && row.closedAt < floor - 15000) break;
        const gap = cursor - row.closedAt;
        if (gap < -90000) continue;
        if (gap > gapLimit) break;
        this._markDone(row.entity);
        cursor = row.closedAt;
        gapLimit = row.runMs + 5 * 60000;
      }
    }

    _applyHistoryDone(onStates) {
      if (!this._cycle || !onStates.length) return;
      const currentStart = onStates.reduce((min, st) => {
        const t = deviceStartedMs(st);
        return Number.isFinite(t) ? Math.min(min, t) : min;
      }, Date.now());
      const specs = normalizeZones(this.config);
      const lookback = specs.reduce((sum, spec) => sum + (Number(spec.durationMin) || 15), 0) * 60000 + 180000;
      const floor = Number(this._cycle.floor) || 0;
      const windowStart = Math.max(currentStart - lookback, floor ? floor - 15000 : 0);
      const program = String(this._cycle.program || "").toLowerCase();
      const events = [];
      for (const spec of specs) {
        const st = entityState(this.hass, spec.entity);
        if (!st || isOn(st)) continue;
        const hist = historyForZone(this.hass, st);
        const started = Date.parse(hist?.attributes?.start_time || "");
        if (!Number.isFinite(started) || started < windowStart || started > currentStart + 20000) continue;
        const hp = String(hist?.attributes?.program || "").toLowerCase();
        if (program && hp && hp !== program) continue;
        const runMin = Number(hist?.attributes?.run_time);
        const end = started + (Number.isFinite(runMin) && runMin > 0 ? runMin * 60000 : 0);
        events.push({ entity: spec.entity, start: started, end });
      }
      events.sort((a, b) => a.start - b.start);
      let cursor = currentStart;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i];
        if (cursor - ev.end > CYCLE_GAP_MS && cursor - ev.start > CYCLE_GAP_MS) break;
        this._markDone(ev.entity);
        cursor = ev.start;
      }
    }

    _syncRunClocks() {
      if (!this.hass || !this.config) return;
      this._loadCycle();
      const specs = normalizeZones(this.config);
      const now = Date.now();
      for (const spec of specs) {
        const st = entityState(this.hass, spec.entity);
        if (isOn(st)) {
          this._wasOn[spec.entity] = true;
          if (!this._seenOn[spec.entity]) {
            this._seenOn[spec.entity] = this._owned[spec.entity] || changedMs(st) || now;
          }
          if (this._queue?.[0]?.entity === spec.entity) this._queueSawOn[spec.entity] = true;
        } else if (this._wasOn[spec.entity]) {
          this._markDone(spec.entity);
          delete this._wasOn[spec.entity];
          delete this._seenOn[spec.entity];
          delete this._owned[spec.entity];
          delete this._stopping[spec.entity];
          delete this._bhyveRun[spec.entity];
          delete this._runFor[spec.entity];
          clearRun(spec.entity);
        }
      }
      const onStates = specs.map((spec) => entityState(this.hass, spec.entity)).filter((st) => isOn(st));
      if (onStates.length) {
        const program = String(onStates.map((st) => st.attributes?.current_program).find(Boolean) || "");
        const continuing =
          this._cycle &&
          now - this._cycle.lastOn <= CYCLE_GAP_MS &&
          (!program || !this._cycle.program || program === this._cycle.program);
        if (!continuing && now >= (this._ignoreOffUntil || 0)) {
          this._cycle = {
            started: now,
            lastOn: now,
            floor: this._cycleFloor || 0,
            program,
            done: [],
            seen: [],
          };
          this._done = {};
        }
        if (this._cycle) {
          this._cycle.lastOn = now;
          if (program) this._cycle.program = program;
          for (const st of onStates) {
            if (st.entity_id && !this._cycle.seen.includes(st.entity_id)) this._cycle.seen.push(st.entity_id);
          }
          const keep = [];
          for (const id of this._cycle.seen) {
            if (isOn(entityState(this.hass, id))) keep.push(id);
            else this._markDone(id);
          }
          this._cycle.seen = keep;
          if (now >= (this._ignoreOffUntil || 0)) {
            this._applyCloseChain(onStates);
            this._applyHistoryDone(onStates);
          }
          this._saveCycle();
        }
      } else if (this._cycle && !this._queue?.length && now - this._cycle.lastOn > CYCLE_GAP_MS) {
        this._clearCycle();
      }
      if (this._queue?.length && !this._advancing) {
        queueMicrotask(() => this._maybeAdvanceQueue());
      }
    }

    _autoOff() {
      const now = Date.now();
      for (const zone of this._zoneModels()) {
        const started = this._owned[zone.entity];
        if (!started || zone.deviceRemaining != null || !zone.controllable || this._bhyveRun[zone.entity]) continue;
        if ((now - started) / 1000 < zone.durationSec) continue;
        if (this._stopping[zone.entity]) continue;
        this._stopping[zone.entity] = true;
        turn(this.hass, zone.entity, false)
          .catch(() => {
            this._error = `Could not stop ${zone.name}.`;
          })
          .finally(() => {
            delete this._stopping[zone.entity];
            delete this._owned[zone.entity];
            this._tick = (this._tick || 0) + 1;
          });
      }
    }

    _zoneModels() {
      const specs = normalizeZones(this.config);
      const now = Date.now();
      return specs.map((spec, index) => {
        const st = entityState(this.hass, spec.entity);
        const on = isOn(st);
        const owned = Boolean(this._owned[spec.entity]);
        const active = on || owned;
        const chosen = Number(this._minutes?.[spec.entity]);
        const planMin = Number.isFinite(chosen) && chosen > 0 ? chosen : spec.durationMin;
        const deviceTotal = on ? deviceRunSeconds(st) : null;
        const deviceStart = on ? deviceStartedMs(st) : null;
        const saved = on && deviceTotal == null ? loadRun(spec.entity) : null;
        const durationSec = deviceTotal || saved?.seconds || this._runFor?.[spec.entity] || planMin * 60;
        const deviceRemaining = active ? readRemainingSeconds(this.hass, spec, st) : null;
        let started = deviceStart || (saved ? saved.started : null);
        if (!started && owned) started = this._owned[spec.entity];
        else if (!started && on) started = changedMs(st) || this._seenOn[spec.entity];
        const elapsed = started ? Math.max(0, (now - started) / 1000) : 0;
        const remaining =
          deviceRemaining != null ? deviceRemaining : active ? Math.max(0, durationSec - elapsed) : durationSec;
        const done = Boolean(this._done[spec.entity]) && !active;
        const progress = done
          ? 1
          : active
            ? Math.max(0, Math.min(1, deviceRemaining != null ? 1 - deviceRemaining / durationSec : elapsed / durationSec))
            : 0;
        const rawName =
          spec.name ||
          st?.attributes?.zone_name ||
          st?.attributes?.friendly_name ||
          spec.entity.replace(/^[^.]+\./, "").replace(/_/g, " ");
        const name = String(rawName)
          .replace(/^sprinklers\s+/i, "")
          .replace(/\s+zone$/i, "")
          .trim();
        return {
          ...spec,
          index,
          on,
          active,
          unavailable: isUnavailable(st),
          controllable: canControl(spec.entity),
          durationSec,
          planMin,
          deviceRemaining,
          elapsed: active ? elapsed : 0,
          remaining,
          progress,
          done,
          name,
        };
      });
    }

    _model() {
      const cfg = mergeConfig(this.config);
      const zones = this._zoneModels();
      const slices = sliceLayout(zones.map((z) => z.planMin || z.durationMin));
      const selected = zones.length ? Math.min(Math.max(this._selected || 0, 0), zones.length - 1) : 0;
      const running = zones.find((z) => z.active) || null;
      const focus = running || zones[selected] || null;
      const anyActive = Boolean(running);
      const delayState = cfg.rain_delay_entity ? entityState(this.hass, cfg.rain_delay_entity) : null;
      const rainDelay = isOn(delayState) || (delayState && Number(delayState.state) > 0);
      let delayHours = null;
      if (rainDelay && delayState) {
        const raw =
          delayState.attributes?.delay ??
          delayState.attributes?.hours ??
          delayState.attributes?.delay_hours ??
          (!isOn(delayState) ? delayState.state : null);
        const hours = Number(raw);
        if (Number.isFinite(hours) && hours > 0) delayHours = hours;
      }
      const allBad = zones.length > 0 && zones.every((z) => z.unavailable);
      const queuedNext = this._queue?.length > 1 ? zones.find((z) => z.entity === this._queue[1].entity) : null;
      const next =
        queuedNext ||
        (zones.length > 1 ? zones[((running ? running.index : selected) + 1) % zones.length] : null);
      let mode = "Idle";
      if (allBad) mode = "Unavailable";
      else if ((anyActive && running && this._owned[running.entity]) || this._queue?.length) mode = "Manual";
      else if (anyActive) mode = "Running";
      else if (rainDelay) mode = "Rain delay";
      const queued = Boolean(this._queue?.length);
      const badge = allBad ? "warn" : anyActive || queued ? "wet" : rainDelay ? "warn" : "dry";
      const badgeText = allBad ? "Unavailable" : anyActive || queued ? "Watering" : rainDelay ? "Rain delay" : "Idle";
      return {
        cfg,
        zones,
        slices,
        selected,
        running,
        focus,
        anyActive,
        rainDelay,
        delayState,
        allBad,
        next,
        mode,
        badge,
        badgeText,
        delayHours,
        onCount: zones.filter((z) => z.active).length,
      };
    }

    _moreInfo(entityId) {
      if (!entityId) return;
      this.dispatchEvent(
        new CustomEvent("hass-more-info", {
          bubbles: true,
          composed: true,
          detail: { entityId },
        })
      );
    }

    _hasService(domain, service) {
      return Boolean(this.hass?.services?.[domain]?.[service]);
    }

    _clampMinutes(value) {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return 1;
      return Math.min(240, Math.max(1, n));
    }

    _minutesFor(zone) {
      const chosen = Number(this._minutes?.[zone.entity]);
      if (Number.isFinite(chosen) && chosen > 0) return this._clampMinutes(chosen);
      return this._clampMinutes(zone.durationMin || zone.planMin || 15);
    }

    _touch() {
      this._tick = (this._tick || 0) + 1;
    }

    _setMinutes(entity, minutes) {
      this._minutes = { ...this._minutes, [entity]: this._clampMinutes(minutes) };
      this._touch();
    }

    _setAllMinutes(minutes) {
      const n = this._clampMinutes(minutes);
      const next = { ...this._minutes };
      for (const spec of normalizeZones(this.config)) next[spec.entity] = n;
      this._minutes = next;
      this._allMinutes = n;
      this._touch();
    }

    _toggleCheck(entity) {
      const zones = this._zoneModels();
      const zone = zones.find((z) => z.entity === entity);
      this._checked = { ...this._checked, [entity]: !this._checked[entity] };
      if (zone) {
        this._picked = true;
        this._selected = zone.index;
      }
      this._touch();
    }

    _setAllChecks(on) {
      const next = {};
      for (const spec of normalizeZones(this.config)) next[spec.entity] = Boolean(on);
      this._checked = next;
      this._touch();
    }

    _onRing(ev) {
      const node = ev.target?.closest?.("[data-zone]");
      if (!node) return;
      const idx = Number(node.getAttribute("data-zone"));
      if (!Number.isFinite(idx)) return;
      const zone = this._zoneModels()[idx];
      if (!zone) return;
      if (this.config?.compact) {
        this._picked = true;
        this._selected = idx;
        return;
      }
      this._toggleCheck(zone.entity);
    }

    _programs() {
      if (!this.hass || !this.config) return [];
      const device = normalizeZones(this.config)
        .map((z) => entityState(this.hass, z.entity)?.attributes?.device_id)
        .find(Boolean);
      if (!device) return [];
      return Object.keys(this.hass.states)
        .filter((id) => id.startsWith("switch.") && /program/i.test(id))
        .map((id) => this.hass.states[id])
        .filter((st) => st?.attributes?.device_id === device)
        .map((st) => ({
          entity: st.entity_id,
          on: isOn(st),
          name: String(st.attributes?.friendly_name || st.entity_id)
            .replace(/^sprinklers\s+/i, "")
            .replace(/\s+program$/i, "")
            .trim(),
        }));
    }

    async _startZone(zone, minutes) {
      const mins = this._clampMinutes(minutes);
      const now = Date.now();
      this._runFor = { ...this._runFor, [zone.entity]: mins * 60 };
      this._owned[zone.entity] = now;
      this._seenOn[zone.entity] = now;
      saveRun(zone.entity, mins * 60, now);
      this._picked = true;
      this._selected = zone.index;
      if (this._hasService("bhyve", "start_watering")) {
        this._bhyveRun[zone.entity] = true;
        await this.hass.callService("bhyve", "start_watering", {
          entity_id: zone.entity,
          minutes: mins,
        });
        return;
      }
      delete this._bhyveRun[zone.entity];
      await turn(this.hass, zone.entity, true);
    }

    async _stopZone(zone) {
      const entity = zone.entity;
      const watering = Boolean(zone.on || this._bhyveRun[entity] || isOn(entityState(this.hass, entity)));
      const useBhyve = watering && this._hasService("bhyve", "stop_watering");
      delete this._owned[entity];
      delete this._bhyveRun[entity];
      delete this._runFor[entity];
      clearRun(entity);
      if (useBhyve) {
        await this.hass.callService("bhyve", "stop_watering", { entity_id: entity });
        return;
      }
      if (zone.controllable && watering) {
        await turn(this.hass, entity, false);
      }
    }

    async _startHead() {
      while (this._queue.length) {
        const head = this._queue[0];
        const zone = this._zoneModels().find((z) => z.entity === head.entity);
        if (!zone || !zone.controllable || zone.unavailable) {
          this._queue.shift();
          continue;
        }
        this._queueStartedAt = Date.now();
        delete this._queueSawOn[head.entity];
        if (this._done[head.entity]) {
          const nextDone = { ...this._done };
          delete nextDone[head.entity];
          this._done = nextDone;
        }
        if (this._cycle) {
          this._cycle.done = (this._cycle.done || []).filter((id) => id !== head.entity);
          this._cycle.seen = (this._cycle.seen || []).filter((id) => id !== head.entity);
          this._saveCycle();
        }
        try {
          await this._startZone(zone, head.minutes);
          return;
        } catch {
          delete this._owned[zone.entity];
          delete this._bhyveRun[zone.entity];
          delete this._runFor[zone.entity];
          this._queue = [];
          this._error = `Could not start ${zone.name}.`;
          throw new Error(this._error);
        }
      }
    }

    async _beginQueue(items) {
      if (!items.length || this._advancing) return;
      this._advancing = true;
      this._error = "";
      this._cycleFloor = Date.now();
      this._ignoreOffUntil = this._cycleFloor + 8000;
      this._clearCycle();
      this._queue = items.slice();
      this._queueSawOn = {};
      try {
        for (const zone of this._zoneModels()) {
          if (zone.on || this._owned[zone.entity] || this._bhyveRun[zone.entity]) {
            await this._stopZone(zone);
          }
        }
        await this._startHead();
      } catch {
        if (!this._error) this._error = "Could not start watering.";
        this._queue = [];
      } finally {
        this._advancing = false;
        this._touch();
      }
    }

    _runPicked() {
      const model = this._model();
      if (model.anyActive || this._queue?.length) return;
      const picked = model.zones.filter((z) => this._checked?.[z.entity] && z.controllable && !z.unavailable);
      if (!picked.length) {
        this._error = "Select at least one zone.";
        this._touch();
        return;
      }
      this._beginQueue(
        picked.map((z) => ({
          entity: z.entity,
          name: z.name,
          minutes: this._minutesFor(z),
          index: z.index,
        }))
      );
    }

    _runAll() {
      const model = this._model();
      if (model.anyActive || this._queue?.length) return;
      const minutes = this._clampMinutes(this._allMinutes);
      this._setAllMinutes(minutes);
      const items = model.zones
        .filter((z) => z.controllable && !z.unavailable)
        .map((z) => ({
          entity: z.entity,
          name: z.name,
          minutes,
          index: z.index,
        }));
      if (!items.length) {
        this._error = "No zones can be started from the card.";
        this._touch();
        return;
      }
      this._beginQueue(items);
    }

    _maybeAdvanceQueue() {
      if (!this._queue?.length || this._advancing) return;
      const head = this._queue[0];
      const on = isOn(entityState(this.hass, head.entity));
      if (on) {
        this._queueSawOn[head.entity] = true;
        return;
      }
      if (!this._queueSawOn[head.entity]) {
        if (Date.now() - (this._queueStartedAt || Date.now()) > 45000) {
          const entity = head.entity;
          const useBhyve = Boolean(this._bhyveRun[entity]) && this._hasService("bhyve", "stop_watering");
          this._error = `${head.name} did not start.`;
          this._queue = [];
          delete this._owned[entity];
          delete this._bhyveRun[entity];
          delete this._runFor[entity];
          if (useBhyve) {
            this.hass.callService("bhyve", "stop_watering", { entity_id: entity }).catch(() => {});
          }
          this._touch();
        }
        return;
      }
      this._shiftQueue();
    }

    async _shiftQueue() {
      if (this._advancing || !this._queue.length) return;
      this._advancing = true;
      const done = this._queue.shift();
      if (done) {
        this._done = { ...this._done, [done.entity]: true };
        delete this._owned[done.entity];
        delete this._queueSawOn[done.entity];
        delete this._bhyveRun[done.entity];
        delete this._runFor[done.entity];
      }
      try {
        if (this._queue.length) await this._startHead();
      } catch {
        if (!this._error) this._error = "Could not start the next zone.";
        this._queue = [];
      } finally {
        this._advancing = false;
        this._touch();
      }
    }

    async _skip() {
      if (this._advancing) return;
      const model = this._model();
      const current =
        model.running || model.zones.find((z) => z.entity === this._queue?.[0]?.entity) || null;
      if (!current && !this._queue?.length) return;
      this._advancing = true;
      this._error = "";
      try {
        const manual = Boolean(this._queue?.length);
        if (!manual && current) {
          const rest = model.zones.filter((z) => z.index > current.index && z.controllable && !z.unavailable);
          this._queue = rest.map((z) => ({
            entity: z.entity,
            name: z.name,
            minutes: this._minutesFor(z),
            index: z.index,
          }));
        } else if (this._queue[0]?.entity === current?.entity || (!current && this._queue.length)) {
          this._queue.shift();
        }
        if (current) {
          this._done = { ...this._done, [current.entity]: true };
          await this._stopZone(current);
        }
        if (this._queue.length) await this._startHead();
      } catch {
        if (!this._error) this._error = "Could not skip to the next zone.";
        this._queue = [];
      } finally {
        this._advancing = false;
        this._touch();
      }
    }

    async _stop() {
      this._advancing = true;
      this._queue = [];
      this._queueSawOn = {};
      this._error = "";
      this._cycleFloor = 0;
      this._ignoreOffUntil = Date.now() + 8000;
      this._clearCycle();
      try {
        for (const zone of this._zoneModels()) {
          if (zone.on || this._owned[zone.entity] || this._bhyveRun[zone.entity]) {
            await this._stopZone(zone);
          }
        }
      } catch {
        this._error = "Could not stop the zones.";
      } finally {
        this._advancing = false;
        this._touch();
      }
    }

    async _setDelay(hours) {
      const h = Math.min(168, Math.max(1, Math.round(Number(hours) || this._delayPick || 24)));
      this._delayPick = h;
      this._error = "";
      const ids = normalizeZones(this.config).map((z) => z.entity);
      try {
        if (this._hasService("bhyve", "enable_rain_delay") && ids.length) {
          await this.hass.callService("bhyve", "enable_rain_delay", { entity_id: ids, hours: h });
        } else if (this.config?.rain_delay_entity && canControl(this.config.rain_delay_entity)) {
          await turn(this.hass, this.config.rain_delay_entity, true);
        }
      } catch {
        this._error = "Could not set rain delay.";
      }
      this._touch();
    }

    async _clearDelay() {
      this._error = "";
      const ids = normalizeZones(this.config).map((z) => z.entity);
      try {
        if (this._hasService("bhyve", "disable_rain_delay") && ids.length) {
          await this.hass.callService("bhyve", "disable_rain_delay", { entity_id: ids });
        }
        const sw = this.config?.rain_delay_entity;
        if (sw && canControl(sw) && isOn(entityState(this.hass, sw))) {
          await turn(this.hass, sw, false);
        }
      } catch {
        this._error = "Could not clear rain delay.";
      }
      this._touch();
    }

    async _startProgram(entity) {
      if (this._model().anyActive || this._queue?.length) return;
      this._error = "";
      this._cycleFloor = Date.now();
      this._ignoreOffUntil = this._cycleFloor + 8000;
      this._clearCycle();
      try {
        if (this._hasService("bhyve", "start_program")) {
          await this.hass.callService("bhyve", "start_program", { entity_id: entity });
        } else {
          await turn(this.hass, entity, true);
        }
      } catch {
        this._error = "Could not start the program.";
      }
      this._touch();
    }

    _ringSvg(model) {
      const uid = this._uid;
      const parts = [
        `<svg viewBox="0 0 240 240" aria-hidden="true">`,
        `<defs><linearGradient id="${uid}-run" x1="0" y1="0" x2="1" y2="1">`,
        `<stop offset="0%" stop-color="#49b7ff"/><stop offset="100%" stop-color="#1476c9"/>`,
        `</linearGradient></defs>`,
        `<circle cx="${CX}" cy="${CY}" r="${TRACK}" fill="none" stroke="var(--divider-color, rgba(127,127,127,.35))" stroke-width="8"/>`,
      ];
      model.zones.forEach((zone, i) => {
        const slice = model.slices[i];
        if (!slice) return;
        const a0 = slice.start;
        const a1 = slice.start + slice.span;
        const idle = zoneColor(i);
        let body = "";
        if (zone.unavailable && !zone.active) {
          body = `<path d="${donutD(CX, CY, R0, R1, a0, a1)}" fill="${idle}" opacity="0.35"/>`;
        } else if (zone.done) {
          body = `<path d="${donutD(CX, CY, R0, R1, a0, a1)}" fill="url(#${uid}-run)"/>`;
        } else if (zone.active) {
          const mid = a0 + slice.span * zone.progress;
          const elapsed = zone.progress > 0.012 ? donutD(CX, CY, R0, R1, a0, mid) : "";
          const rest = zone.progress < 0.988 ? donutD(CX, CY, R0, R1, Math.max(a0, mid), a1) : "";
          body = `${elapsed ? `<path d="${elapsed}" fill="url(#${uid}-run)"/>` : ""}${
            rest ? `<path d="${rest}" fill="#3cba64"/>` : ""
          }`;
        } else {
          const marked = i === model.selected || Boolean(this._checked?.[zone.entity]);
          const wash = marked
            ? `<path d="${donutD(CX, CY, R0, R1, a0, a1)}" fill="rgba(255,255,255,.16)"/>`
            : "";
          body = `<path d="${donutD(CX, CY, R0, R1, a0, a1)}" fill="${idle}"/>${wash}`;
        }
        const marked = i === model.selected || Boolean(this._checked?.[zone.entity]);
        const selected = marked
          ? `<path d="${arcD(CX, CY, R1 + 2, a0, a1)}" fill="none" stroke="#ffffff" stroke-width="2.5"/>`
          : "";
        parts.push(`<g data-zone="${i}" class="slice">${body}${selected}</g>`);
      });
      model.zones.forEach((zone, i) => {
        if (!zone.done) return;
        const slice = model.slices[i];
        if (!slice) return;
        parts.push(
          `<path d="${arcD(CX, CY, TRACK, slice.start, slice.start + slice.span)}" fill="none" stroke="#3cb0ff" stroke-width="8"/>`
        );
      });
      const active = model.running;
      if (active) {
        const slice = model.slices[active.index];
        if (slice) {
          const end = slice.start + slice.span * Math.min(1, Math.max(0, active.progress));
          if (active.progress > 0.01) {
            parts.push(
              `<path d="${arcD(CX, CY, TRACK, slice.start, end)}" fill="none" stroke="#3cb0ff" stroke-width="8" stroke-linecap="round"/>`
            );
          }
          const [px, py] = polar(CX, CY, TRACK, end);
          parts.push(
            `<circle cx="${fmt(px)}" cy="${fmt(py)}" r="6" fill="#2f9bff" stroke="#ffffff" stroke-width="2"/>`
          );
        }
      }
      model.slices.forEach((slice) => {
        const [x, y] = polar(CX, CY, TRACK, slice.start);
        parts.push(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="3.2" fill="var(--primary-text-color, #ddd)" opacity="0.85"/>`);
      });
      parts.push(
        `<circle cx="${CX}" cy="${CY}" r="${R0 - 1}" fill="var(--card-background-color, #111)" stroke="var(--divider-color, rgba(127,127,127,.35))" stroke-width="1"/>`
      );
      model.zones.forEach((zone, i) => {
        const slice = model.slices[i];
        if (!slice || slice.span < 18) return;
        const [x, y] = polar(CX, CY, (R0 + R1) / 2, slice.start + slice.span / 2);
        parts.push(
          `<text x="${fmt(x)}" y="${fmt(y)}" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-size="13" font-weight="700" pointer-events="none">${i + 1}</text>`
        );
      });
      parts.push(`</svg>`);
      return parts.join("");
    }

    render() {
      if (!this.hass || !this.config) return html``;
      const model = this._model();
      if (!model.zones.length) {
        return html`
          <ha-card>
            <div class="wrap setup">
              <p>Add sprinkler zones in the card editor. Switches, valves, and toggles all work.</p>
            </div>
          </ha-card>
        `;
      }
      const focus = model.focus;
      const holding = model.rainDelay && !model.anyActive;
      const remainLabel = model.anyActive ? "Remaining" : holding ? "Rain delay" : "Planned";
      const remainValue = holding && model.delayHours
        ? `${model.delayHours}h`
        : focus
          ? formatClock(model.anyActive ? focus.remaining : focus.durationSec)
          : "—";
      const runValue = focus && model.anyActive ? formatClock(focus.elapsed) : "0:00";
      const hubSub = model.anyActive ? "left" : holding ? "holding" : "ready";
      const hubName = holding ? "All zones" : focus?.name || "";
      const checkedCount = model.zones.filter((z) => this._checked?.[z.entity]).length;
      const busy = model.anyActive || Boolean(this._queue?.length);
      const programs = model.cfg.compact ? [] : this._programs();
      const delayChoices = [12, 24, 48, 72];
      const later = (this._queue || []).slice(1).map((q) => q.name);

      return html`
        <ha-card>
          <div class="wrap">
            <div class="header">
              <button type="button" class="title" @click=${() => this._moreInfo(focus?.entity)}>
                ${model.cfg.name || "Sprinklers"}
              </button>
              <span class="badge ${model.badge}">${model.badgeText}</span>
            </div>

            <div class="body">
              <div class="dial">
                <button
                  type="button"
                  class="side stop"
                  aria-label="Stop watering"
                  ?disabled=${!busy}
                  @click=${(ev) => {
                    ev.stopPropagation();
                    this._stop();
                  }}
                >
                  Stop
                </button>
                <div class="ring" @click=${this._onRing}>
                  <div class="ring-svg" .innerHTML=${this._ringSvg(model)}></div>
                  <button type="button" class="hub" @click=${() => this._moreInfo(focus?.entity)}>
                    <span class="hub-mode">${model.mode}</span>
                    <span class="hub-name">${hubName}</span>
                    <span class="hub-time">${remainValue}</span>
                    <span class="hub-sub">${hubSub}</span>
                  </button>
                </div>
                <button
                  type="button"
                  class="side skip"
                  aria-label="Skip to the next zone"
                  ?disabled=${!busy}
                  @click=${(ev) => {
                    ev.stopPropagation();
                    this._skip();
                  }}
                >
                  Skip
                </button>
              </div>

              <div class="info-col">
                ${model.cfg.compact
                  ? html`
                      <div class="tiles">
                        <div class="tile">
                          <span class="tile-k">${remainLabel}</span>
                          <span class="tile-v">${remainValue}</span>
                        </div>
                        <div class="tile">
                          <span class="tile-k">Time running</span>
                          <span class="tile-v">${runValue}</span>
                        </div>
                      </div>
                    `
                  : html`
                      <div class="facts">
                        <span><em>${remainLabel}</em>${remainValue}</span>
                        <span><em>Time running</em>${runValue}</span>
                        <span><em>Zone</em>${focus?.name || "—"}</span>
                        <span><em>Next</em>${model.next?.name || "—"}</span>
                        <span><em>On</em>${model.onCount}</span>
                      </div>
                    `}

                ${model.cfg.show_actions && !model.cfg.compact
                  ? html`
                      <div class="fold">
                        ${this._foldHead(
                          "Manual",
                          busy ? "Running" : checkedCount ? `${checkedCount} selected` : `${this._allMinutes} min`,
                          this._manualOpen,
                          "manual",
                          "_manualOpen"
                        )}
                        ${this._manualOpen
                          ? html`
                              <div class="fold-body">
                                <div class="time-row">
                                  <span class="time-k">All zones</span>
                                  <div class="step">
                                    <button
                                      type="button"
                                      aria-label="Fewer minutes for all zones"
                                      @click=${() => this._setAllMinutes(this._allMinutes - 1)}
                                    >
                                      −
                                    </button>
                                    <span>${this._allMinutes}</span>
                                    <button
                                      type="button"
                                      aria-label="More minutes for all zones"
                                      @click=${() => this._setAllMinutes(this._allMinutes + 1)}
                                    >
                                      +
                                    </button>
                                  </div>
                                  <span class="time-unit">min</span>
                                  <button
                                    type="button"
                                    class="act run"
                                    ?disabled=${busy || !model.zones.some((z) => z.controllable && !z.unavailable)}
                                    @click=${() => this._runAll()}
                                  >
                                    Run all
                                  </button>
                                </div>
                                <button
                                  type="button"
                                  class="act run wide"
                                  ?disabled=${busy || checkedCount === 0}
                                  @click=${() => this._runPicked()}
                                >
                                  ${checkedCount ? `Run ${checkedCount}` : "Run selected"}
                                </button>
                                <p class="hint">Zones run one at a time. Tap a slice or a row to include it.</p>
                                ${later.length ? html`<p class="queue">Then ${later.join(", ")}</p>` : ""}
                              </div>
                            `
                          : ""}
                      </div>
                      <div class="fold">
                        ${this._foldHead(
                          "Delay",
                          model.rainDelay ? (model.delayHours ? `${model.delayHours}h` : "On") : "Off",
                          this._delayOpen,
                          "delay",
                          "_delayOpen"
                        )}
                        ${this._delayOpen
                          ? html`
                              <div class="fold-body">
                                <div class="delay-row">
                                ${delayChoices.map(
                                  (hours) => html`
                                    <button
                                      type="button"
                                      class="chip ${this._delayPick === hours ? "on" : ""}"
                                      @click=${() => {
                                        this._delayPick = hours;
                                        this._touch();
                                      }}
                                    >
                                      ${hours}h
                                    </button>
                                  `
                                )}
                                <button type="button" class="act slim" @click=${() => this._setDelay(this._delayPick)}>
                                  Set
                                </button>
                                <button
                                  type="button"
                                  class="act slim"
                                  ?disabled=${!model.rainDelay}
                                  @click=${() => this._clearDelay()}
                                >
                                  Clear
                                </button>
                                </div>
                              </div>
                            `
                          : ""}
                      </div>
                      ${programs.length
                        ? html`
                            <div class="fold">
                              ${this._foldHead("Program", String(programs.length), this._programOpen, "program", "_programOpen")}
                              ${this._programOpen
                                ? html`
                                    <div class="fold-body">
                                      <div class="delay-row">
                                      ${programs.map(
                                        (program) => html`
                                          <button
                                            type="button"
                                            class="act slim"
                                            ?disabled=${busy}
                                            @click=${() => this._startProgram(program.entity)}
                                          >
                                            ${program.name}
                                          </button>
                                        `
                                      )}
                                      </div>
                                    </div>
                                  `
                                : ""}
                            </div>
                          `
                        : ""}
                    `
                  : ""}
                ${this._error && !model.cfg.compact ? html`<div class="err">${this._error}</div>` : ""}

                ${model.cfg.compact
                  ? ""
                  : html`
                <div class="zone-list">
                  ${this._foldHead(
                    "Zones",
                    checkedCount ? `${checkedCount} selected` : String(model.zones.length),
                    this._zonesOpen,
                    "zones",
                    "_zonesOpen"
                  )}
                  ${this._zonesOpen
                    ? html`
                        <div class="list-tools">
                          <button type="button" @click=${() => this._setAllChecks(true)}>Select all</button>
                          <button type="button" @click=${() => this._setAllChecks(false)}>Clear</button>
                        </div>
                        <div class="zone-rows">
                          ${model.zones.map((zone) => {
                            const picked = Boolean(this._checked?.[zone.entity]);
                            const minutes = this._minutesFor(zone);
                            return html`
                              <div
                                class="zrow ${picked || zone.index === model.selected ? "sel" : ""} ${zone.active ? "on" : ""}"
                                role="button"
                                tabindex="0"
                                @click=${() => this._toggleCheck(zone.entity)}
                                @keydown=${(ev) => {
                                  if (ev.key !== "Enter" && ev.key !== " ") return;
                                  ev.preventDefault();
                                  this._toggleCheck(zone.entity);
                                }}
                              >
                                <span class="check ${picked ? "on" : ""}"></span>
                                <span class="zname">${zone.index + 1}. ${zone.name}</span>
                                ${zone.unavailable && !zone.active
                                  ? html`<span class="zmeta">unavailable</span>`
                                  : zone.active
                                    ? html`<span class="zmeta">${formatClock(zone.remaining)}</span>`
                                    : html`
                                        <span class="step" @click=${(ev) => ev.stopPropagation()}>
                                          <button
                                            type="button"
                                            aria-label="Fewer minutes for ${zone.name}"
                                            @click=${(ev) => {
                                              ev.stopPropagation();
                                              this._setMinutes(zone.entity, minutes - 1);
                                            }}
                                          >
                                            −
                                          </button>
                                          <span>${minutes}</span>
                                          <button
                                            type="button"
                                            aria-label="More minutes for ${zone.name}"
                                            @click=${(ev) => {
                                              ev.stopPropagation();
                                              this._setMinutes(zone.entity, minutes + 1);
                                            }}
                                          >
                                            +
                                          </button>
                                        </span>
                                      `}
                              </div>
                            `;
                          })}
                        </div>
                      `
                    : ""}
                </div>
                  `}
              </div>
            </div>
          </div>
        </ha-card>
      `;
    }

    static get styles() {
      return css`
        :host {
          display: block;
        }
        :host([data-size="75"]) {
          zoom: 0.75;
        }
        :host([data-size="50"]) {
          zoom: 0.5;
        }
        ha-card {
          display: block;
          overflow: hidden;
          background: var(--card-background-color, var(--ha-card-background));
        }
        button {
          font: inherit;
        }
        .wrap {
          padding: 12px 14px 14px;
          display: flex;
          flex-direction: column;
          min-height: 0;
          container-type: inline-size;
        }
        .setup {
          min-height: 80px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--secondary-text-color);
          text-align: center;
        }
        .setup p {
          margin: 0;
          max-width: 36em;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: 8px;
          margin-bottom: 8px;
        }
        .title {
          border: 0;
          background: none;
          padding: 0;
          font-size: 1.05rem;
          font-weight: 650;
          color: var(--primary-text-color);
          cursor: pointer;
          text-align: left;
        }
        .badge {
          font-size: 0.72rem;
          font-weight: 700;
          letter-spacing: 0.02em;
          padding: 3px 8px;
          border-radius: 999px;
          white-space: nowrap;
        }
        .badge.wet {
          color: #dff6ff;
          background: #0b6aa2;
        }
        .badge.dry {
          color: var(--secondary-text-color);
          background: var(--secondary-background-color, rgba(255, 255, 255, 0.06));
        }
        .badge.warn {
          color: #3b1d00;
          background: #f8c15c;
        }
        .body {
          display: grid;
          grid-template-columns: minmax(200px, 0.92fr) minmax(220px, 1.15fr);
          gap: 8px 16px;
          align-items: center;
        }
        .dial {
          display: grid;
          grid-template-columns: 46px minmax(0, 1fr) 46px;
          align-items: center;
          gap: 2px;
          width: 100%;
          max-width: 380px;
          margin: 0 auto;
        }
        .side {
          width: 46px;
          height: 46px;
          justify-self: center;
          border: 0;
          border-radius: 50%;
          padding: 0;
          font-size: 0.66rem;
          font-weight: 800;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          cursor: pointer;
          color: var(--primary-text-color);
          background: var(--secondary-background-color, rgba(255, 255, 255, 0.06));
        }
        .side.stop {
          background: transparent;
          box-shadow: inset 0 0 0 1.5px var(--divider-color, rgba(255, 255, 255, 0.28));
        }
        .side.skip {
          background: #0b6aa2;
          color: #fff;
        }
        .side:disabled {
          opacity: 0.35;
          cursor: default;
        }
        .ring {
          position: relative;
          width: 100%;
          max-width: 300px;
          margin: 0 auto;
        }
        .ring-svg,
        .ring-svg svg {
          width: 100%;
          height: auto;
          display: block;
        }
        .ring-svg svg {
          filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.28));
        }
        .ring-svg [data-zone] {
          cursor: pointer;
        }
        .hub {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 42%;
          height: 42%;
          border: 0;
          border-radius: 50%;
          background: transparent;
          color: var(--primary-text-color);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1px;
          padding: 8px;
          text-align: center;
          cursor: pointer;
        }
        .hub-mode {
          font-size: 0.68rem;
          font-weight: 750;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--secondary-text-color);
        }
        .hub-name {
          font-size: 0.84rem;
          font-weight: 700;
          line-height: 1.15;
          max-width: 100%;
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .hub-time {
          font-size: 1.28rem;
          font-weight: 750;
          font-variant-numeric: tabular-nums;
          letter-spacing: -0.03em;
          line-height: 1.1;
        }
        .hub-sub {
          font-size: 0.66rem;
          font-weight: 650;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--secondary-text-color);
        }
        .info-col {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .facts {
          display: flex;
          flex-wrap: wrap;
          gap: 2px 14px;
          margin: 0;
        }
        .facts span {
          font-size: 0.92rem;
          font-weight: 750;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .facts em {
          font-style: normal;
          margin-right: 5px;
          font-size: 0.68rem;
          font-weight: 650;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--secondary-text-color);
        }
        .fold,
        .zone-list {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .fold-body {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 2px 0 4px;
        }
        .tiles {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
        .tile {
          border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
          background: var(--secondary-background-color, rgba(255, 255, 255, 0.04));
          color: var(--primary-text-color);
          border-radius: 12px;
          padding: 12px 12px 11px;
          text-align: left;
        }
        .tile-k,
        .stat-k,
        .list-title {
          display: block;
          font-size: 0.72rem;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          font-weight: 650;
        }
        .tile-v {
          display: block;
          margin-top: 4px;
          font-size: 1.35rem;
          font-weight: 750;
          letter-spacing: -0.02em;
          line-height: 1.1;
          font-variant-numeric: tabular-nums;
        }
        .stats {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
        }
        .stat {
          display: flex;
          flex-direction: column;
          min-width: 0;
          border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
          background: var(--secondary-background-color, rgba(255, 255, 255, 0.04));
          border-radius: 12px;
          padding: 10px 10px 9px;
        }
        .stat-v,
        .zname {
          display: block;
          min-width: 0;
          font-size: 0.98rem;
          font-weight: 650;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .actions {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 8px;
        }
        .act {
          border: 0;
          border-radius: 999px;
          padding: 8px 10px;
          font-weight: 700;
          font-size: 0.84rem;
          cursor: pointer;
          background: var(--secondary-background-color, rgba(255, 255, 255, 0.06));
          color: var(--primary-text-color);
        }
        .act.run {
          background: #0b6aa2;
          color: #fff;
        }
        .act.wide {
          width: 100%;
        }
        .act.stop {
          background: transparent;
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(255, 255, 255, 0.18));
        }
        .act.slim {
          padding: 6px 12px;
        }
        .act:disabled {
          opacity: 0.45;
          cursor: default;
        }
        .manual {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .time-row,
        .delay-row,
        .list-tools {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .time-k,
        .time-unit,
        .hint,
        .queue {
          font-size: 0.72rem;
          font-weight: 700;
          color: var(--secondary-text-color);
        }
        .time-k {
          min-width: 4.6rem;
        }
        .hint,
        .queue {
          margin: 0;
          font-weight: 650;
          line-height: 1.35;
        }
        .time-row .act {
          margin-left: auto;
        }
        .step {
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          background: var(--secondary-background-color, rgba(255, 255, 255, 0.06));
        }
        .step button {
          width: 28px;
          height: 28px;
          border: 0;
          border-radius: 999px;
          background: transparent;
          color: var(--primary-text-color);
          font-size: 1rem;
          font-weight: 700;
          cursor: pointer;
        }
        .step span {
          min-width: 1.7rem;
          text-align: center;
          font-variant-numeric: tabular-nums;
          font-weight: 700;
          font-size: 0.84rem;
        }
        .chip {
          border: 0;
          border-radius: 999px;
          padding: 5px 9px;
          font-size: 0.75rem;
          font-weight: 700;
          cursor: pointer;
          background: var(--secondary-background-color, rgba(255, 255, 255, 0.06));
          color: var(--primary-text-color);
        }
        .chip.on {
          background: #f8c15c;
          color: #3b1d00;
        }
        .check {
          width: 14px;
          height: 14px;
          border-radius: 4px;
          box-shadow: inset 0 0 0 1.5px var(--secondary-text-color, #8b8b8b);
        }
        .check.on {
          background: #0b6aa2;
          box-shadow: none;
        }
        .list-tools button {
          border: 0;
          background: transparent;
          color: var(--primary-color, #0b6aa2);
          font-weight: 700;
          font-size: 0.75rem;
          cursor: pointer;
          padding: 0 4px;
        }
        .err {
          font-size: 0.75rem;
          color: var(--error-color, #f87171);
        }
        .zone-list {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .list-toggle {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          border: 0;
          background: transparent;
          color: var(--secondary-text-color);
          padding: 2px 2px 0;
          cursor: pointer;
          text-align: left;
        }
        .list-count {
          font-size: 0.72rem;
          font-weight: 700;
        }
        .chev {
          margin-left: auto;
          width: 0;
          height: 0;
          border-left: 5px solid transparent;
          border-right: 5px solid transparent;
          border-top: 6px solid currentColor;
          transform: rotate(-90deg);
        }
        .chev.open {
          transform: rotate(0deg);
        }
        .zone-rows {
          display: flex;
          flex-direction: column;
          gap: 2px;
          max-height: 196px;
          overflow: auto;
        }
        .list-title {
          margin: 0;
        }
        .zrow {
          display: grid;
          grid-template-columns: 16px minmax(0, 1fr) auto;
          gap: 8px;
          align-items: center;
          border: 0;
          background: transparent;
          color: var(--primary-text-color);
          text-align: left;
          border-radius: 10px;
          padding: 4px 8px;
          cursor: pointer;
        }
        .zrow.sel {
          background: var(--secondary-background-color, rgba(255, 255, 255, 0.06));
        }
        .zdot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
        }
        .zdot.live {
          box-shadow: 0 0 0 4px rgba(26, 143, 212, 0.25);
        }
        .zmeta {
          font-size: 0.78rem;
          font-weight: 650;
          color: var(--secondary-text-color);
          font-variant-numeric: tabular-nums;
        }
        .title:focus-visible,
        .hub:focus-visible,
        .act:focus-visible,
        .side:focus-visible,
        .chip:focus-visible,
        .step button:focus-visible,
        .list-tools button:focus-visible,
        .list-toggle:focus-visible,
        .zrow:focus-visible {
          outline: 2px solid var(--primary-color, #0b6aa2);
          outline-offset: 2px;
        }
        :host([compact]) {
          height: 100%;
        }
        :host([compact]) ha-card,
        :host([compact]) .wrap {
          height: 100%;
          box-sizing: border-box;
        }
        :host([compact]) .wrap {
          padding: 8px 10px 16px;
        }
        :host([compact]) .header {
          margin-bottom: 4px;
        }
        :host([compact]) .body {
          flex: 1;
          min-height: 0;
          height: auto;
          grid-template-columns: minmax(0, 1.25fr) minmax(96px, 0.75fr);
          align-items: stretch;
        }
        :host([compact]) .dial {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          min-height: 0;
          min-width: 0;
          width: 100%;
          max-width: none;
          margin: 0;
          gap: 8px;
        }
        :host([compact]) .side {
          flex: 0 0 42px;
          width: 42px;
          height: 42px;
          padding: 0;
          font-size: 0.64rem;
          letter-spacing: 0.02em;
          line-height: 1;
        }
        :host([compact]) .ring {
          position: relative;
          flex: 0 1 auto;
          align-self: center;
          height: 100%;
          width: auto;
          max-width: calc(100% - 108px);
          max-height: 100%;
          aspect-ratio: 1;
          margin: 0;
          container-type: inline-size;
        }
        :host([compact]) .ring-svg,
        :host([compact]) .ring-svg svg {
          display: block;
          width: 100%;
          height: 100%;
        }
        :host([compact]) .hub {
          width: 40%;
          height: 40%;
          padding: 0;
          gap: 0;
        }
        :host([compact]) .hub-mode {
          font-size: 7cqi;
          letter-spacing: 0.06em;
        }
        :host([compact]) .hub-name {
          font-size: 9cqi;
          line-height: 1.05;
          -webkit-line-clamp: 1;
        }
        :host([compact]) .hub-time {
          font-size: 13cqi;
          line-height: 1;
        }
        :host([compact]) .hub-sub {
          font-size: 6.5cqi;
          letter-spacing: 0.04em;
        }
        :host([compact]) .info-col {
          justify-content: center;
          gap: 8px;
        }
        :host([compact]) .tiles {
          grid-template-columns: 1fr;
        }
        :host([compact]) .tile {
          padding: 8px 10px;
        }
        :host([compact]) .tile-v {
          font-size: 1.15rem;
        }
        @container (max-width: 560px) {
          .body {
            grid-template-columns: 1fr;
          }
          .ring {
            max-width: 280px;
          }
        }
        @media (max-width: 520px) {
          .body {
            grid-template-columns: 1fr;
          }
          .ring {
            max-width: 280px;
          }
        }
      `;
    }
  }

  class SprinklerPlusCardEditor extends LitElement {
    static get properties() {
      return { hass: {}, config: {} };
    }

    setConfig(config) {
      this.config = mergeConfig(config || {});
    }

    _valueChanged(ev) {
      const value = { ...(ev.detail?.value || {}) };
      const prev = normalizeZones(this.config);
      const ids = Array.isArray(value.zones) ? value.zones : [];
      const durations = parseDurationList(value.durations);
      value.size = sizeOf(value);
      value.default_duration = clampDurationMin(value.default_duration, 15);
      value.show_actions = value.show_actions !== false;
      value.durations = durations.length ? durations.join(", ") : "";
      value.zones = ids.map((id, i) => {
        const old = prev.find((z) => z.entity === id);
        const duration = durations[i];
        if (!old?.name && !old?.remaining_entity) return id;
        const obj = { entity: id };
        if (duration) obj.duration = duration;
        if (old?.name) obj.name = old.name;
        if (old?.remaining_entity) obj.remaining_entity = old.remaining_entity;
        return obj;
      });
      if (!value.rain_delay_entity) delete value.rain_delay_entity;
      if (!value.durations) delete value.durations;
      this.config = value;
      this.dispatchEvent(
        new CustomEvent("config-changed", {
          detail: { config: value },
        })
      );
    }

    render() {
      if (!this.hass) return html``;
      const merged = mergeConfig(this.config || {});
      const zones = normalizeZones(merged);
      const durationText = (() => {
        const list = parseDurationList(merged.durations);
        if (list.length) return list.join(", ");
        if (zones.some((z) => z.explicitDuration)) return zones.map((z) => z.durationMin).join(", ");
        return "";
      })();
      const data = {
        ...merged,
        zones: zones.map((z) => z.entity),
        durations: durationText,
      };
      return html`
        <ha-form
          .hass=${this.hass}
          .data=${data}
          .schema=${[
            { name: "name", selector: { text: {} } },
            {
              name: "size",
              selector: {
                select: {
                  mode: "dropdown",
                  options: [
                    { value: "100", label: "Full (100%)" },
                    { value: "75", label: "75%" },
                    { value: "50", label: "50%" },
                  ],
                },
              },
            },
            {
              name: "zones",
              selector: {
                entity: {
                  multiple: true,
                  filter: [
                    { domain: "switch" },
                    { domain: "valve" },
                    { domain: "input_boolean" },
                  ],
                },
              },
            },
            {
              name: "default_duration",
              selector: { number: { min: 1, max: 240, step: 1, mode: "box" } },
            },
            { name: "durations", selector: { text: {} } },
            {
              name: "rain_delay_entity",
              selector: {
                entity: {
                  filter: [
                    { domain: "switch" },
                    { domain: "input_boolean" },
                    { domain: "binary_sensor" },
                    { domain: "sensor" },
                  ],
                },
              },
            },
            { name: "show_actions", selector: { boolean: {} } },
            { name: "compact", selector: { boolean: {} } },
          ]}
          .computeLabel=${(s) =>
            ({
              name: "Card title",
              size: "Card size",
              zones: "Zones",
              default_duration: "Default zone minutes",
              durations: "Minutes per zone (optional)",
              rain_delay_entity: "Rain delay (optional)",
              show_actions: "Show run controls",
              compact: "Compact (rotation slot)",
            })[s.name] || s.name}
          @value-changed=${this._valueChanged}
        ></ha-form>
      `;
    }
  }

  customElements.define("sprinkler-plus-card", SprinklerPlusCard);
  customElements.define("sprinkler-plus-card-editor", SprinklerPlusCardEditor);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "sprinkler-plus-card",
    name: "Sprinkler Plus",
    description: "Zone pie for sprinklers with remaining time, run, skip, and rain delay",
    preview: true,
    documentationURL: "https://github.com/randrcomputers/ha-sprinkler-card#readme",
  });
})();
