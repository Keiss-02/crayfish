require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const app = express();

const cors = require('cors');
app.use(cors());

const port = process.env.PORT;
const signalFile = process.env.SHARED_FILE;
const imageFile    = '/dev/shm/crayfish_frame.jpg';
const statusFile   = '/dev/shm/crayfish_status.json';
const snapshotFile = '/dev/shm/crayfish_snapshot.jpg';
const configFile   = '/dev/shm/crayfish_config.json';
const waterHtmlFile = path.join(__dirname, 'water.html');
const waterStatusFile = '/dev/shm/crayfish_water_status.json';
const waterConfigFile = '/dev/shm/crayfish_water_config.json';
const waterCommandFile = '/dev/shm/crayfish_water_cmd.json';

// ── MongoDB ───────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('[MongoDB] Connected'))
  .catch(e => console.error('[MongoDB] Connection error:', e));

const waterLogSchema = new mongoose.Schema({
  timestamp:      { type: Date, default: Date.now },
  turbidity_ntu:  Number,
  temperature_c:  Number,
  flow_lpm:       Number,
  total_liters:   Number,
  ammonia_raw:    Number,
  ammonia_status: String,
  pump_state:     String,
  uv_state:       String,
  peltier_state:  String,
  valve_state:    String,
  note:           String,
  connected:      Boolean,
  trigger:        String   // 'interval' | 'value_change' | 'actuator_change'
});

const alertSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  type:      String,   // 'high_ammonia' | 'high_temp' | 'high_turbidity'
  severity:  String,   // 'warning' | 'critical'
  value:     Number,
  threshold: Number,
  note:      String
});

const WaterLog   = mongoose.model('WaterLog',   waterLogSchema);
const AlertLog   = mongoose.model('AlertLog',   alertSchema);

// Last saved values for comparison
let lastSaved = {
  ammonia_raw:   null,
  temperature_c: null,
  turbidity_ntu: null,
  flow_lpm:      null,
  pump_state:    null,
  uv_state:      null,
  peltier_state: null,
  valve_state:   null
};

async function saveReading(status, trigger) {
  try {
    await WaterLog.create({
      turbidity_ntu:  status.turbidity_ntu,
      temperature_c:  status.temperature_c,
      flow_lpm:       status.flow_lpm,
      total_liters:   status.total_liters,
      ammonia_raw:    status.ammonia_raw,
      ammonia_status: status.note,
      pump_state:     status.pump_state,
      uv_state:       status.uv_state,
      peltier_state:  status.peltier_state,
      valve_state:    status.valve_state,
      note:           status.note,
      connected:      status.connected,
      trigger:        trigger
    });

    // Update last saved snapshot
    lastSaved = {
      ammonia_raw:   status.ammonia_raw,
      temperature_c: status.temperature_c,
      turbidity_ntu: status.turbidity_ntu,
      flow_lpm:      status.flow_lpm,
      pump_state:    status.pump_state,
      uv_state:      status.uv_state,
      peltier_state: status.peltier_state,
      valve_state:   status.valve_state
    };

    console.log(`[MongoDB] Saved (${trigger})`);
  } catch (e) {
    console.error('[MongoDB] Save error:', e.message);
  }
}

async function checkAlerts(status) {
  const checks = [
    { condition: status.ammonia_raw > 2500,  type: 'high_ammonia',   severity: 'critical', value: status.ammonia_raw,   threshold: 2500 },
    { condition: status.ammonia_raw > 2000,  type: 'high_ammonia',   severity: 'warning',  value: status.ammonia_raw,   threshold: 2000 },
    { condition: status.temperature_c > 30,  type: 'high_temp',      severity: 'critical', value: status.temperature_c, threshold: 30   },
    { condition: status.temperature_c > 28,  type: 'high_temp',      severity: 'warning',  value: status.temperature_c, threshold: 28   },
    { condition: status.turbidity_ntu > 2500,type: 'high_turbidity', severity: 'critical', value: status.turbidity_ntu, threshold: 2500 },
    { condition: status.turbidity_ntu > 2000,type: 'high_turbidity', severity: 'warning',  value: status.turbidity_ntu, threshold: 2000 },
  ];

  for (const check of checks) {
    if (check.condition) {
      try {
        await AlertLog.create({
          type:      check.type,
          severity:  check.severity,
          value:     check.value,
          threshold: check.threshold,
          note:      `${check.type} detected: ${check.value}`
        });
        console.log(`[ALERT] ${check.severity.toUpperCase()} — ${check.type}: ${check.value}`);
      } catch (e) {
        console.error('[MongoDB] Alert save error:', e.message);
      }
      break; // only log highest severity per check cycle
    }
  }
}

function hasSignificantChange(status) {
  if (lastSaved.ammonia_raw === null) return false; // first reading, skip

  const ammoniaChanged   = Math.abs((status.ammonia_raw   || 0) - (lastSaved.ammonia_raw   || 0)) >= 100;
  const tempChanged      = Math.abs((status.temperature_c || 0) - (lastSaved.temperature_c || 0)) >= 0.5;
  const turbidityChanged = Math.abs((status.turbidity_ntu || 0) - (lastSaved.turbidity_ntu || 0)) >= 100;
  const flowChanged      = Math.abs((status.flow_lpm      || 0) - (lastSaved.flow_lpm      || 0)) >= 0.2;

  return ammoniaChanged || tempChanged || turbidityChanged || flowChanged;
}

function hasActuatorChange(status) {
  if (lastSaved.pump_state === null) return false;

  return (
    status.pump_state    !== lastSaved.pump_state    ||
    status.uv_state      !== lastSaved.uv_state      ||
    status.peltier_state !== lastSaved.peltier_state ||
    status.valve_state   !== lastSaved.valve_state
  );
}

async function logWaterReading(status) {
  //if (!status.connected) return;

  const now = Date.now() / 1000;

  // First reading ever — save immediately as baseline
  if (lastSaved.ammonia_raw === null) {
    await saveReading(status, 'interval');
    lastLoggedTs = now;
    return;
  }

  // Actuator state changed — save immediately
  if (hasActuatorChange(status)) {
    await saveReading(status, 'actuator_change');
    lastLoggedTs = now;
    await checkAlerts(status);
    return;
  }

  // Significant sensor value change — save immediately
  if (hasSignificantChange(status)) {
    await saveReading(status, 'value_change');
    lastLoggedTs = now;
    await checkAlerts(status);
    return;
  }

  // Forced interval save (every 20 seconds)
  if ((now - lastLoggedTs) > 20) {
    await saveReading(status, 'interval');
    lastLoggedTs = now;
    await checkAlerts(status);
  }
}

// ── In-memory detection toggle ────────────────────────────────────────────────
let detectionPaused = false;
let lastLoggedTs = 0;

function initConfig() {
    if (!fs.existsSync(configFile)) {
        const defaultConfig = {
            activation_start: '08:00',
            activation_end: '20:00',
            motor_zone_left_steps: 200,
            motor_zone_left_dir: 'CW',
            motor_zone_right_steps: 200,
            motor_zone_right_dir: 'CCW',
            motor_zone_boundary: 320
        };
        try { fs.writeFileSync(configFile, JSON.stringify(defaultConfig)); } catch (_) {}
    }
}
initConfig();

function readJsonFile(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {}
  return fallback;
}

function writeJsonFile(filePath, payload) {
  try {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    console.error(`JSON write error for ${filePath}:`, e);
    return false;
  }
}

function initWaterConfig() {
  if (!fs.existsSync(waterConfigFile)) {
    const defaultWaterConfig = {
      sample_interval_sec: 5,
      alert_interval_sec: 15,
      max_turbidity_ntu: 10,
      max_ammonia_raw: 2000,
      max_temp_c: 28,
      min_flow_lpm: 0.2,
      pump_auto_enabled: true,
      pump_target_level_pct: 55,
      pump_max_runtime_sec: 180,
      pump_cooldown_sec: 60,
      alarm_hold_sec: 30,
      alarm_enabled: true
    };
    writeJsonFile(waterConfigFile, defaultWaterConfig);
  }
}
initWaterConfig();

function readConfig() {
    try {
        if (fs.existsSync(configFile)) return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (_) {}
    return {
        activation_start: '08:00',
        activation_end: '20:00',
        motor_zone_left_steps: 200,
        motor_zone_left_dir: 'CW',
        motor_zone_right_steps: 200,
        motor_zone_right_dir: 'CCW',
        motor_zone_boundary: 320
    };
}

function writeConfig(cfg) {
    try {
        const tmp = configFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
        fs.renameSync(tmp, configFile);
    } catch (e) { console.error('Config write error:', e); }
}

app.use(express.json());

// ── Water dashboard ───────────────────────────────────────────────────────────
app.get('/water', (req, res) => {
  res.sendFile(waterHtmlFile);
});

app.get('/api/water/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const fallback = {
    connected: false,
    note: 'Waiting for water monitor',
    serial_port: process.env.ESP32_SERIAL_PORT || '/dev/ttyUSB0',
    temperature_c: null,
    turbidity_ntu: null,
    ammonia_raw: null,
    flow_lpm: null,
    total_liters: null,
    pump_state: 'idle',
    uv_state: 'off',
    peltier_state: 'off',
    valve_state: 'unknown',
    last_command: null,
    last_reply: null,
    last_update: null,
    ts: Date.now() / 1000
  };
  const status = readJsonFile(waterStatusFile, fallback);

logWaterReading(status);

  res.json(status);
});

// ── NEW: History endpoint ─────────────────────────────────────────────────────
app.get('/api/water/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = await WaterLog.find()
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
    res.json({ ok: true, count: logs.length, data: logs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/water/alerts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const alerts = await AlertLog.find()
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
    res.json({ ok: true, count: alerts.length, data: alerts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/water/config', (req, res) => {
  const fallback = {
    sample_interval_sec: 5,
    alert_interval_sec: 15,
    max_turbidity_ntu: 10,
    max_ammonia_raw: 2000,
    max_temp_c: 28,
    min_flow_lpm: 0.2,
    pump_auto_enabled: true,
    pump_target_level_pct: 55,
    pump_max_runtime_sec: 180,
    pump_cooldown_sec: 60,
    alarm_hold_sec: 30,
    alarm_enabled: true
  };
  res.json(readJsonFile(waterConfigFile, fallback));
});

app.post('/api/water/config', (req, res) => {
  const existing = readJsonFile(waterConfigFile, {});
  const merged = Object.assign({}, existing, req.body || {});
  writeJsonFile(waterConfigFile, merged);
  res.json({ ok: true, config: merged });
});

app.post('/api/water/control', (req, res) => {
  const action = (req.body && req.body.action ? String(req.body.action) : 'refresh').trim().toLowerCase();
  const value = req.body && req.body.value !== undefined ? req.body.value : null;
  const command = { action, value, source: 'dashboard', ts: Date.now() };
  if (!writeJsonFile(waterCommandFile, command)) {
    return res.status(500).json({ ok: false, error: 'Failed to queue water command' });
  }
  res.json({ ok: true, queued: command });
});

// ── MJPEG broadcast ───────────────────────────────────────────────────────────
const streamClients = new Set();
function broadcastFrame() {
    if (streamClients.size === 0) return;
    if (!fs.existsSync(imageFile)) return;
    let frame;
    try { frame = fs.readFileSync(imageFile); } catch (_) { return; }
    const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
    for (const client of streamClients) {
        try { client.write(header); client.write(frame); client.write('\r\n'); }
        catch (_) { streamClients.delete(client); }
    }
}
setInterval(broadcastFrame, 100);

// ── Main dashboard ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    const config      = readConfig();
    const startTimeVal = config.activation_start || '08:00';
    const endTimeVal   = config.activation_end   || '20:00';
    const zoneLeftSteps   = config.motor_zone_left_steps  || 200;
    const zoneLeftDir     = config.motor_zone_left_dir    || 'CW';
    const zoneRightSteps  = config.motor_zone_right_steps || 200;
    const zoneRightDir    = config.motor_zone_right_dir   || 'CCW';
    const zoneBoundary    = config.motor_zone_boundary    || 320;
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CrayCheck · Aquatic Monitor</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
  <style>
    :root {
      --bg: #f4f6fa;
      --bg2: #eaf0fb;
      --surface: #ffffff;
      --surface2: #f8fafd;
      --border: #dde4f0;
      --border2: #c8d4ea;
      --navy: #0b1e3d;
      --navy2: #1a3260;
      --navy3: #2a4a8a;
      --accent: #0070f3;
      --accent2: #00b37e;
      --danger: #e53e5a;
      --warn: #f59e0b;
      --info: #06b6d4;
      --text: #0f1b2d;
      --text2: #3d5a80;
      --muted: #7a93b4;
      --mono: 'Share Tech Mono', monospace;
      --sans: 'Inter', sans-serif;
      --sidebar-w: 230px;
      --shadow: 0 1px 4px rgba(11,30,61,0.07), 0 4px 16px rgba(11,30,61,0.06);
      --shadow-md: 0 2px 8px rgba(11,30,61,0.09), 0 8px 32px rgba(11,30,61,0.08);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body { background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; display: flex; flex-direction: column; }

    /* ── Topbar ── */
    .topbar {
      height: 56px; min-height: 56px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 0;
      padding: 0; z-index: 100;
      box-shadow: 0 1px 0 var(--border);
    }
    .topbar-brand {
      width: var(--sidebar-w); min-width: var(--sidebar-w);
      display: flex; align-items: center; gap: 10px;
      padding: 0 20px;
      border-right: 1px solid var(--border);
      height: 100%;
    }
    .logo {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, var(--navy), var(--navy3));
      border-radius: 8px; display: flex; align-items: center;
      justify-content: center; font-size: 16px; flex-shrink: 0;
      box-shadow: 0 2px 8px rgba(11,30,61,0.25);
    }
    .brand-name { font-weight: 700; font-size: 16px; color: var(--navy); letter-spacing: -0.01em; }
    .brand-sub  { font-family: var(--mono); font-size: 9px; color: var(--muted); letter-spacing: 0.08em; margin-top: 1px; }
    .topbar-center {
      flex: 1; display: flex; align-items: center; gap: 12px;
      padding: 0 24px; height: 100%;
    }
    .page-title { font-weight: 600; font-size: 15px; color: var(--navy); white-space: nowrap; }
    .page-title .sub { color: var(--muted); font-weight: 400; font-size: 13px; margin-left: 6px; }
    .tunnel-wrap { display: flex; align-items: center; gap: 6px; margin-left: 12px; }
    .tunnel-icon { color: var(--muted); font-size: 14px; }
    .tunnel-input {
      width: 250px; padding: 7px 12px;
      background: var(--bg); border: 1px solid var(--border2);
      border-radius: 7px; color: var(--text); font-family: var(--mono); font-size: 11px;
      outline: none; transition: border-color 0.2s, box-shadow 0.2s;
    }
    .tunnel-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0,112,243,0.1); }
    .tunnel-input::placeholder { color: var(--muted); }
    .tunnel-set-btn {
      padding: 7px 14px; background: var(--navy); border: none; border-radius: 7px;
      color: #fff; font-family: var(--mono); font-size: 11px; font-weight: 700;
      cursor: pointer; letter-spacing: 0.06em; transition: background 0.15s, transform 0.1s;
    }
    .tunnel-set-btn:hover { background: var(--navy2); transform: translateY(-1px); }
    .topbar-right { display: flex; align-items: center; gap: 10px; padding: 0 20px; margin-left: auto; }
    .conn-pill {
      display: flex; align-items: center; gap: 7px;
      padding: 6px 14px; border-radius: 999px;
      border: 1px solid var(--border2);
      background: var(--surface2);
      font-size: 12px; font-weight: 500; color: var(--text2);
    }
    .conn-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .conn-dot.online  { background: var(--accent2); box-shadow: 0 0 0 2px rgba(0,179,126,0.2); }
    .conn-dot.offline { background: var(--danger);  box-shadow: 0 0 0 2px rgba(229,62,90,0.2); }
    .conn-dot.unknown { background: var(--muted); }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .conn-dot.online { animation: pulse 2.5s ease-in-out infinite; }

    /* ── App shell ── */
    .app-shell { flex: 1; display: flex; overflow: hidden; }

    /* ── Sidebar ── */
    .sidebar {
      width: var(--sidebar-w); min-width: var(--sidebar-w);
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex; flex-direction: column;
      overflow-y: auto; padding: 16px 10px;
    }
    .sidebar::-webkit-scrollbar { width: 3px; }
    .sidebar::-webkit-scrollbar-thumb { background: var(--border); }
    .nav-section { margin-bottom: 6px; }
    .nav-section-label {
      font-family: var(--mono); font-size: 9px; letter-spacing: 0.18em;
      text-transform: uppercase; color: var(--muted);
      padding: 8px 10px 4px; display: block;
    }
    .nav-item {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 12px; border-radius: 8px; cursor: pointer;
      color: var(--text2); font-size: 13px; font-weight: 500;
      transition: all 0.15s; text-decoration: none; border: none;
      background: none; width: 100%; text-align: left;
    }
    .nav-item:hover { background: var(--bg2); color: var(--navy); }
    .nav-item.active { background: rgba(0,112,243,0.08); color: var(--accent); font-weight: 600; }
    .nav-item .ni { font-size: 15px; width: 22px; text-align: center; flex-shrink: 0; }
    .nav-divider { height: 1px; background: var(--border); margin: 8px 10px; }
    .sidebar-footer {
      margin-top: auto; padding: 14px 12px 4px;
      font-size: 11px; color: var(--muted); line-height: 1.7;
      border-top: 1px solid var(--border);
    }

    /* ── Main content ── */
    .main-content {
      flex: 1; overflow-y: auto; overflow-x: hidden;
      padding: 24px; display: flex; flex-direction: column; gap: 18px;
      background: var(--bg);
    }
    .main-content::-webkit-scrollbar { width: 5px; }
    .main-content::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }

    /* ── Page sections ── */
    .page-section { display: none; flex-direction: column; gap: 18px; }
    .page-section.active { display: flex; }

    /* ── Metric cards ── */
    .metric-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
    @media (max-width: 1100px) { .metric-row { grid-template-columns: repeat(2, 1fr); } }
    .metric-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 18px 20px;
      box-shadow: var(--shadow);
      display: flex; flex-direction: column; gap: 4px;
      transition: box-shadow 0.2s, transform 0.2s;
      position: relative; overflow: hidden;
    }
    .metric-card:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
    .metric-card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
      background: linear-gradient(90deg, var(--card-color, var(--accent)), transparent);
    }
    .metric-card.c-blue  { --card-color: var(--accent); }
    .metric-card.c-green { --card-color: var(--accent2); }
    .metric-card.c-warn  { --card-color: var(--warn); }
    .metric-card.c-info  { --card-color: var(--info); }
    .metric-label { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; display: flex; align-items: center; gap: 6px; }
    .metric-value { font-size: 30px; font-weight: 700; color: var(--navy); line-height: 1.1; margin-top: 6px; }
    .metric-value .unit { font-size: 14px; font-weight: 500; color: var(--muted); margin-left: 3px; }
    .metric-badge {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
      margin-top: 6px; width: fit-content;
    }
    .metric-badge.ok   { background: rgba(0,179,126,0.1);  color: var(--accent2); }
    .metric-badge.warn { background: rgba(245,158,11,0.12); color: var(--warn); }
    .metric-badge.bad  { background: rgba(229,62,90,0.1);   color: var(--danger); }
    .metric-badge.off  { background: rgba(122,147,180,0.12);color: var(--muted); }

    /* ── Cards ── */
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; overflow: hidden;
      box-shadow: var(--shadow);
    }
    .card-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 13px 18px; border-bottom: 1px solid var(--border);
      font-size: 12px; font-weight: 700; color: var(--navy);
      letter-spacing: 0.02em; text-transform: uppercase;
      background: var(--surface2);
    }
    .card-header-left { display: flex; align-items: center; gap: 8px; }
    .card-body { padding: 18px; }

    /* ── Two-col ── */
    .two-col { display: grid; grid-template-columns: 1fr 360px; gap: 16px; align-items: start; }
    @media (max-width: 1050px) { .two-col { grid-template-columns: 1fr; } }
    .col-stack { display: flex; flex-direction: column; gap: 14px; }

    /* ── Camera ── */
    .camera-wrap { position: relative; background: #0a0e1a; aspect-ratio: 16/10; }
    canvas#feed { width: 100%; height: 100%; display: block; }
    .cam-corner { position: absolute; width: 14px; height: 14px; border-color: rgba(0,200,255,0.7); border-style: solid; }
    .cam-corner.tl { top: 8px; left: 8px; border-width: 2px 0 0 2px; }
    .cam-corner.tr { top: 8px; right: 8px; border-width: 2px 2px 0 0; }
    .cam-corner.bl { bottom: 8px; left: 8px; border-width: 0 0 2px 2px; }
    .cam-corner.br { bottom: 8px; right: 8px; border-width: 0 2px 2px 0; }
    .cam-overlay { position: absolute; bottom: 8px; left: 12px; font-family: var(--mono); font-size: 10px; color: rgba(0,200,255,0.75); pointer-events: none; }
    .cam-overlay-r { position: absolute; bottom: 8px; right: 12px; font-family: var(--mono); font-size: 10px; color: rgba(0,200,255,0.6); pointer-events: none; }
    .rec-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--danger); animation: pulse 1.2s ease-in-out infinite; }

    /* ── Camera bottom bar ── */
    .cam-bar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 16px; border-top: 1px solid var(--border);
      gap: 10px; flex-wrap: wrap; background: var(--surface2);
    }
    .cam-bar-left { display: flex; align-items: center; gap: 8px; }
    .detect-toggle {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 14px; border-radius: 999px; border: 1.5px solid var(--accent2);
      background: rgba(0,179,126,0.08); color: var(--accent2);
      font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s;
    }
    .detect-toggle:hover { background: rgba(0,179,126,0.15); }
    .detect-toggle.paused { border-color: var(--danger); background: rgba(229,62,90,0.07); color: var(--danger); }
    .fps-badge { font-family: var(--mono); font-size: 11px; color: var(--muted); }
    .feed-now-btn {
      padding: 7px 18px; background: var(--navy);
      border: none; border-radius: 999px;
      color: #fff; font-size: 12px; font-weight: 600;
      cursor: pointer; transition: all 0.15s; letter-spacing: 0.02em;
    }
    .feed-now-btn:hover { background: var(--navy2); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(11,30,61,0.2); }

    /* ── Detection strip ── */
    .detect-strip {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 16px; background: var(--bg2);
      border-top: 1px solid var(--border);
      font-size: 12px;
    }
    .status-chip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid;
    }
    .status-chip.idle     { background: rgba(122,147,180,0.1); border-color: rgba(122,147,180,0.25); color: var(--muted); }
    .status-chip.scanning { background: rgba(0,112,243,0.08);  border-color: rgba(0,112,243,0.25);  color: var(--accent); }
    .status-chip.detected { background: rgba(0,179,126,0.09);  border-color: rgba(0,179,126,0.25);  color: var(--accent2); }
    .status-chip.egg      { background: rgba(245,158,11,0.1);  border-color: rgba(245,158,11,0.3);  color: var(--warn); }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spin { display: inline-block; animation: spin 1s linear infinite; }

    /* ── Snapshot ── */
    .snapshot-wrap { position: relative; cursor: pointer; background: var(--bg); border-radius: 8px; overflow: hidden; display: none; border: 1px solid var(--border); }
    .snapshot-wrap:hover::after { content: '🔍 Click to enlarge'; position: absolute; inset: 0; background: rgba(11,30,61,0.45); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: #fff; }
    canvas#snapshotCanvas { width: 100%; height: auto; display: block; }
    .snapshot-placeholder { height: 80px; display: flex; align-items: center; justify-content: center; background: var(--bg2); border: 1.5px dashed var(--border2); border-radius: 8px; color: var(--muted); font-size: 12px; }

    /* ── Modal ── */
    #snapshotModal { display: none; position: fixed; inset: 0; z-index: 9999; background: rgba(11,30,61,0.75); backdrop-filter: blur(4px); align-items: center; justify-content: center; }
    #snapshotModal.open { display: flex; }
    .modal-inner { position: relative; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: var(--shadow-md); max-width: 90vw; }
    canvas#snapshotModalCanvas { display: block; max-width: 90vw; max-height: 80vh; }
    .modal-bar { background: var(--surface2); padding: 8px 16px; font-size: 12px; color: var(--muted); display: flex; justify-content: space-between; }
    .modal-close { position: absolute; top: 8px; right: 8px; background: rgba(255,255,255,0.9); border: 1px solid var(--border); color: var(--navy); width: 28px; height: 28px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; }

    /* ── Stat rows ── */
    .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { color: var(--text2); font-size: 12px; }
    .stat-value { font-family: var(--mono); font-size: 13px; color: var(--navy); font-weight: 600; }

    /* ── Actuator cards ── */
    .actuator-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .actuator-card {
      background: var(--surface2); border: 1px solid var(--border);
      border-radius: 10px; padding: 16px;
      transition: box-shadow 0.15s;
    }
    .actuator-card:hover { box-shadow: var(--shadow); }
    .actuator-icon { font-size: 22px; margin-bottom: 6px; }
    .actuator-name { font-size: 13px; font-weight: 600; color: var(--navy); margin-bottom: 4px; }
    .actuator-state { font-size: 11px; font-weight: 600; margin-bottom: 12px; }
    .actuator-state.on  { color: var(--accent2); }
    .actuator-state.off { color: var(--muted); }
    .actuator-btns { display: flex; gap: 6px; }
    .btn-on, .btn-off {
      flex: 1; padding: 7px 0; border-radius: 6px; border: 1.5px solid;
      font-size: 12px; font-weight: 700; cursor: pointer; transition: all 0.15s; letter-spacing: 0.04em;
    }
    .btn-on  { border-color: rgba(0,179,126,0.4); background: rgba(0,179,126,0.07); color: var(--accent2); }
    .btn-on:hover  { background: rgba(0,179,126,0.15); border-color: var(--accent2); }
    .btn-off { border-color: rgba(229,62,90,0.35); background: rgba(229,62,90,0.06); color: var(--danger); }
    .btn-off:hover { background: rgba(229,62,90,0.13); border-color: var(--danger); }

    /* ── Charts ── */
    .chart-wrap { position: relative; height: 150px; }

    /* ── Alert items ── */
    .alert-list { display: flex; flex-direction: column; gap: 8px; max-height: 280px; overflow-y: auto; }
    .alert-list::-webkit-scrollbar { width: 3px; }
    .alert-list::-webkit-scrollbar-thumb { background: var(--border); }
    .alert-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: 8px; border: 1px solid; }
    .alert-item.warning  { background: rgba(245,158,11,0.06); border-color: rgba(245,158,11,0.25); }
    .alert-item.critical { background: rgba(229,62,90,0.06);  border-color: rgba(229,62,90,0.22); }
    .alert-icon { font-size: 15px; flex-shrink: 0; margin-top: 1px; }
    .alert-title { font-size: 12px; font-weight: 700; }
    .alert-item.warning  .alert-title { color: var(--warn); }
    .alert-item.critical .alert-title { color: var(--danger); }
    .alert-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .alert-empty { font-size: 12px; color: var(--muted); text-align: center; padding: 20px 0; }

    /* ── No-connection banner ── */
    .no-conn-banner {
      display: none; align-items: center; gap: 10px;
      padding: 10px 16px; background: rgba(245,158,11,0.09);
      border: 1px solid rgba(245,158,11,0.3); border-radius: 8px;
      font-size: 12px; color: var(--warn); font-weight: 500;
    }
    .no-conn-banner.visible { display: flex; }

    /* ── Event log ── */
    .log-area { font-family: var(--mono); font-size: 11px; color: var(--muted); height: 220px; overflow-y: auto; line-height: 1.85; }
    .log-area::-webkit-scrollbar { width: 3px; }
    .log-area::-webkit-scrollbar-thumb { background: var(--border2); }
    .log-entry { display: flex; gap: 10px; }
    .log-time { color: var(--accent); opacity: 0.65; flex-shrink: 0; }
    .log-msg.ok   { color: var(--accent2); }
    .log-msg.warn { color: var(--warn); }
    .log-msg.err  { color: var(--danger); }

    /* ── Forms ── */
    input[type="time"], input[type="number"] {
      width: 100%; padding: 8px 12px; border: 1.5px solid var(--border2); border-radius: 7px;
      background: var(--surface); color: var(--navy); font-family: var(--mono); font-size: 12px; outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input[type="time"]:focus, input[type="number"]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0,112,243,0.1); }
    select {
      width: 100%; padding: 8px 12px; border: 1.5px solid var(--border2); border-radius: 7px;
      background: var(--surface); color: var(--navy); font-size: 12px; cursor: pointer; outline: none;
    }
    .form-label { font-size: 11px; font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: 0.06em; display: block; margin-bottom: 6px; }
    .form-group { margin-bottom: 14px; }
    .save-btn {
      width: 100%; padding: 10px; background: var(--navy);
      border: none; border-radius: 8px; color: #fff;
      font-size: 13px; font-weight: 700; cursor: pointer;
      transition: all 0.15s; letter-spacing: 0.03em;
    }
    .save-btn:hover { background: var(--navy2); transform: translateY(-1px); box-shadow: 0 4px 14px rgba(11,30,61,0.2); }
    .zone-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
    .zone-block { border: 1.5px solid var(--border); border-radius: 9px; padding: 12px; }
    .zone-block.left-z  { border-color: rgba(0,112,243,0.35); background: rgba(0,112,243,0.03); }
    .zone-block.right-z { border-color: rgba(0,179,126,0.35); background: rgba(0,179,126,0.03); }
    .zone-lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 10px; }
    .zone-lbl.left  { color: var(--accent); }
    .zone-lbl.right { color: var(--accent2); }

    /* ── Motor manual ── */
    .motor-manual { border-top: 1px solid var(--border); padding-top: 16px; margin-top: 16px; }
    .run-btn {
      width: 100%; padding: 9px; border-radius: 7px;
      border: 1.5px solid rgba(245,158,11,0.45); background: rgba(245,158,11,0.07);
      color: var(--warn); font-size: 12px; font-weight: 700;
      cursor: pointer; transition: all 0.15s;
    }
    .run-btn:hover { background: rgba(245,158,11,0.14); border-color: var(--warn); }
    .run-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    /* ── Motion bar ── */
    .motion-bg { height: 4px; background: var(--bg2); border-radius: 2px; overflow: hidden; margin-top: 5px; }
    .motion-fill { height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--accent), var(--info)); width: 0%; transition: width 0.3s; }
    .motion-fill.high { background: linear-gradient(90deg, var(--warn), var(--danger)); }

    /* ── Section grids ── */
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    @media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }

    /* ── Toast ── */
    #toastContainer { position: fixed; top: 70px; right: 20px; z-index: 99999; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
    .toast {
      background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent);
      border-radius: 8px; padding: 11px 14px;
      font-size: 12px; color: var(--navy);
      box-shadow: var(--shadow-md); display: flex; align-items: center; gap: 10px;
      max-width: 290px; pointer-events: all;
      animation: toastIn 0.3s cubic-bezier(0.34,1.56,0.64,1) forwards;
    }
    .toast.success { border-left-color: var(--accent2); }
    .toast.warning { border-left-color: var(--warn); }
    .toast.error   { border-left-color: var(--danger); }
    .toast-close { margin-left: auto; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 14px; line-height: 1; }
    @keyframes toastIn  { from { opacity:0; transform:translateX(40px); } to { opacity:1; transform:translateX(0); } }
    @keyframes toastOut { to   { opacity:0; transform:translateX(40px); } }
  </style>
</head>
<body>

<div id="toastContainer"></div>

<!-- Modal -->
<div id="snapshotModal">
  <div class="modal-inner">
    <button class="modal-close" onclick="closeModal()">✕</button>
    <canvas id="snapshotModalCanvas"></canvas>
    <div class="modal-bar">
      <span id="modalMeta">Snapshot</span>
      <span id="modalZone" style="color:var(--accent);font-weight:600;">—</span>
    </div>
  </div>
</div>

<!-- Topbar -->
<div class="topbar">
  <div class="topbar-brand">
    <div class="logo">🦞</div>
    <div>
      <div class="brand-name">CrayCheck</div>
      <div class="brand-sub">AQUATIC MONITOR v2.3</div>
    </div>
  </div>
  <div class="topbar-center">
    <div class="page-title" id="pageTitle">Live Feed <span class="sub">· Dashboard</span></div>
    <div class="tunnel-wrap">
      <span class="tunnel-icon">🔗</span>
      <input class="tunnel-input" id="tunnelInput" type="text" placeholder="Paste tunnel URL here…">
      <button class="tunnel-set-btn" onclick="setTunnelUrl(document.getElementById('tunnelInput').value)">Set</button>
    </div>
  </div>
  <div class="topbar-right">
    <div class="conn-pill">
      <div class="conn-dot unknown" id="esp32Dot"></div>
      <span>ESP32</span>
      <span id="esp32State" style="font-weight:700;">—</span>
    </div>
  </div>
</div>

<!-- App -->
<div class="app-shell">

  <!-- Sidebar -->
  <nav class="sidebar">
    <div class="nav-section">
      <span class="nav-section-label">Monitor</span>
      <button class="nav-item active" onclick="showSection('livefeed')" id="nav-livefeed"><span class="ni">📷</span>Live Feed</button>
      <button class="nav-item" onclick="showSection('sensors')" id="nav-sensors"><span class="ni">📊</span>Water Sensors</button>
      <button class="nav-item" onclick="showSection('actuators')" id="nav-actuators"><span class="ni">⚙️</span>Actuators</button>
    </div>
    <div class="nav-divider"></div>
    <div class="nav-section">
      <span class="nav-section-label">System</span>
      <button class="nav-item" onclick="showSection('schedule')" id="nav-schedule"><span class="ni">🕐</span>Schedule</button>
      <button class="nav-item" onclick="showSection('motorzones')" id="nav-motorzones"><span class="ni">⚡</span>Motor Zones</button>
      <button class="nav-item" onclick="showSection('alerts')" id="nav-alerts"><span class="ni">🔔</span>Alerts</button>
      <button class="nav-item" onclick="showSection('eventlog')" id="nav-eventlog"><span class="ni">📋</span>Event Log</button>
    </div>
    <div class="sidebar-footer">
      Group 6 · BSIT-S-3A-T<br>TUP Taguig
    </div>
  </nav>

  <!-- Main -->
  <div class="main-content">

    <!-- ══ LIVE FEED ══ -->
    <div class="page-section active" id="section-livefeed">

      <!-- No-connection banner -->
      <div class="no-conn-banner" id="noConnBanner">
        ⚠️ ESP32 not connected — sensor readings unavailable. Check serial connection on Pi.
      </div>

      <!-- Metrics -->
      <div class="metric-row">
        <div class="metric-card c-blue">
          <div class="metric-label">🧪 Ammonia (MQ-137)</div>
          <div class="metric-value"><span id="m-ammonia">--</span><span class="unit">raw</span></div>
          <div class="metric-badge off" id="m-ammonia-badge">— No data</div>
        </div>
        <div class="metric-card c-green">
          <div class="metric-label">🌡 Temperature</div>
          <div class="metric-value"><span id="m-temp">--</span><span class="unit">°C</span></div>
          <div class="metric-badge off" id="m-temp-badge">— No data</div>
        </div>
        <div class="metric-card c-warn">
          <div class="metric-label">〰 Turbidity</div>
          <div class="metric-value"><span id="m-turbidity">--</span><span class="unit">NTU</span></div>
          <div class="metric-badge off" id="m-turbidity-badge">— No data</div>
        </div>
        <div class="metric-card c-info">
          <div class="metric-label">≋ Water Flow</div>
          <div class="metric-value"><span id="m-flow">--</span><span class="unit">L/min</span></div>
          <div class="metric-badge off" id="m-flow-badge">— No data</div>
        </div>
      </div>

      <!-- Two col -->
      <div class="two-col">

        <!-- Left -->
        <div class="col-stack">
          <div class="card">
            <div class="card-header">
              <div class="card-header-left"><div class="rec-dot"></div> LIVE FEED · CAM-01</div>
              <span class="fps-badge" id="fpsBadge">-- FPS</span>
            </div>
            <div class="camera-wrap">
              <canvas id="feed" width="640" height="400"></canvas>
              <div class="cam-corner tl"></div><div class="cam-corner tr"></div>
              <div class="cam-corner bl"></div><div class="cam-corner br"></div>
              <div class="cam-overlay" id="camTime">--:--:--</div>
              <div class="cam-overlay-r">640×480</div>
            </div>
            <div class="cam-bar">
              <div class="cam-bar-left">
                <button class="detect-toggle" id="detectionToggleBtn" onclick="toggleDetection()">
                  <span id="detectionToggleIcon">⬤</span>
                  <span id="detectionToggleLabel">Auto-detection: ON</span>
                </button>
                <span class="fps-badge" id="motionPctBadge">0% motion</span>
              </div>
              <button class="feed-now-btn" id="feedBtn">🍤 Feed Now</button>
            </div>
            <div class="detect-strip">
              <div class="status-chip idle" id="detectBadge">◌ <span id="detectBadgeLabel">IDLE</span></div>
              <span id="detectNote" style="color:var(--text2);font-size:12px;">Watching for motion…</span>
              <span id="detectZone" style="margin-left:auto;font-size:11px;font-weight:600;color:var(--accent);display:none;"></span>
            </div>
          </div>

          <!-- Snapshot -->
          <div class="card">
            <div class="card-header">
              <div class="card-header-left">📸 LAST MOTION SNAPSHOT</div>
              <span id="snapshotScanBadge" style="display:none;font-size:11px;color:var(--accent);font-weight:600;"><span class="spin">⟳</span> SCANNING</span>
            </div>
            <div class="card-body" style="padding:12px;">
              <div class="snapshot-wrap" id="snapshotCanvasWrap" onclick="openModal()">
                <canvas id="snapshotCanvas"></canvas>
                <div id="snapshotEggBadge" style="display:none;position:absolute;bottom:6px;left:6px;background:var(--warn);border-radius:999px;padding:3px 9px;font-size:10px;font-weight:700;color:#fff;">🥚 EGGS DETECTED</div>
              </div>
              <div class="snapshot-placeholder" id="snapshotPlaceholder">Waiting for motion event…</div>
            </div>
          </div>
        </div>

        <!-- Right -->
        <div class="col-stack">
          <div class="card">
            <div class="card-header">📈 SENSOR TRENDS · LAST 20 READINGS</div>
            <div class="card-body">
              <div style="margin-bottom:16px;">
                <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Ammonia over time</div>
                <div class="chart-wrap"><canvas id="chartAmmonia"></canvas></div>
              </div>
              <div>
                <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Temperature (°C) over time</div>
                <div class="chart-wrap"><canvas id="chartTemp"></canvas></div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">🔔 RECENT ALERTS</div>
            <div class="card-body" style="padding:12px;">
              <div class="alert-list" id="alertList"><div class="alert-empty">No alerts yet</div></div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- ══ WATER SENSORS ══ -->
    <div class="page-section" id="section-sensors">
      <div class="no-conn-banner" id="noConnBanner2">
        ⚠️ ESP32 not connected — sensor readings unavailable.
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-header">🧪 AMMONIA · MQ-137</div>
          <div class="card-body">
            <div class="stat-row"><span class="stat-label">Raw ADC value</span><span class="stat-value" id="s-ammonia-raw">--</span></div>
            <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value" id="s-ammonia-status">--</span></div>
            <div class="stat-row"><span class="stat-label">Warning threshold</span><span class="stat-value" style="color:var(--muted)">2000</span></div>
            <div class="stat-row"><span class="stat-label">Critical threshold</span><span class="stat-value" style="color:var(--muted)">2500</span></div>
            <div style="margin-top:14px;"><div class="chart-wrap"><canvas id="chartAmmonia2"></canvas></div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-header">🌡 TEMPERATURE · DS18B20</div>
          <div class="card-body">
            <div class="stat-row"><span class="stat-label">Current (°C)</span><span class="stat-value" id="s-temp-val">--</span></div>
            <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value" id="s-temp-status">--</span></div>
            <div class="stat-row"><span class="stat-label">Peltier cooler</span><span class="stat-value" id="s-peltier-state">--</span></div>
            <div class="stat-row"><span class="stat-label">Warning above</span><span class="stat-value" style="color:var(--muted)">28 °C</span></div>
            <div style="margin-top:14px;"><div class="chart-wrap"><canvas id="chartTemp2"></canvas></div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-header">〰 TURBIDITY</div>
          <div class="card-body">
            <div class="stat-row"><span class="stat-label">NTU value</span><span class="stat-value" id="s-turbidity-val">--</span></div>
            <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value" id="s-turbidity-status">--</span></div>
            <div class="stat-row"><span class="stat-label">UV sterilizer</span><span class="stat-value" id="s-uv-state">--</span></div>
            <div style="margin-top:14px;"><div class="chart-wrap"><canvas id="chartTurbidity"></canvas></div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-header">≋ WATER FLOW</div>
          <div class="card-body">
            <div class="stat-row"><span class="stat-label">Flow rate</span><span class="stat-value" id="s-flow-val">--</span></div>
            <div class="stat-row"><span class="stat-label">Total volume</span><span class="stat-value" id="s-total-val">--</span></div>
            <div class="stat-row"><span class="stat-label">Valve state</span><span class="stat-value" id="s-valve-state">--</span></div>
            <div style="margin-top:14px;"><div class="chart-wrap"><canvas id="chartFlow"></canvas></div></div>
          </div>
        </div>
      </div>
    </div>

    <!-- ══ ACTUATORS ══ -->
    <div class="page-section" id="section-actuators">
      <div class="card">
        <div class="card-header">⚙️ ACTUATOR CONTROL PANEL</div>
        <div class="card-body">
          <div class="actuator-grid">
            <div class="actuator-card">
              <div class="actuator-icon">☀️</div>
              <div class="actuator-name">UV Sterilizer</div>
              <div class="actuator-state off" id="act-uv-state">● Offline / OFF</div>
              <div class="actuator-btns">
                <button class="btn-on"  onclick="sendControl('UV_ON')">ON</button>
                <button class="btn-off" onclick="sendControl('UV_OFF')">OFF</button>
              </div>
            </div>
            <div class="actuator-card">
              <div class="actuator-icon">💧</div>
              <div class="actuator-name">Water Pump</div>
              <div class="actuator-state off" id="act-pump-state">● Offline / OFF</div>
              <div class="actuator-btns">
                <button class="btn-on"  onclick="sendControl('PUMP_ON')">ON</button>
                <button class="btn-off" onclick="sendControl('PUMP_OFF')">OFF</button>
              </div>
            </div>
            <div class="actuator-card">
              <div class="actuator-icon">🚰</div>
              <div class="actuator-name">Solenoid Valve</div>
              <div class="actuator-state off" id="act-valve-state">● Offline / CLOSED</div>
              <div class="actuator-btns">
                <button class="btn-on"  onclick="sendControl('VALVE_ON')">OPEN</button>
                <button class="btn-off" onclick="sendControl('VALVE_OFF')">CLOSE</button>
              </div>
            </div>
            <div class="actuator-card">
              <div class="actuator-icon">❄️</div>
              <div class="actuator-name">Peltier Cooler</div>
              <div class="actuator-state off" id="act-peltier-state">● Offline / OFF</div>
              <div class="actuator-btns">
                <button class="btn-on"  onclick="sendControl('COOL_MAX')">ON MAX</button>
                <button class="btn-off" onclick="sendControl('COOL_OFF')">OFF</button>
              </div>
            </div>
          </div>
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin-bottom:10px;">Command Status</div>
            <div class="stat-row"><span class="stat-label">Last command</span><span class="stat-value" id="act-last-cmd">—</span></div>
            <div class="stat-row"><span class="stat-label">Reply</span><span class="stat-value" id="act-last-reply">—</span></div>
            <div class="stat-row"><span class="stat-label">Serial port</span><span class="stat-value" id="act-serial" style="color:var(--muted)">—</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- ══ SCHEDULE ══ -->
    <div class="page-section" id="section-schedule">
      <div class="card" style="max-width:480px;">
        <div class="card-header">🕐 FEEDING SCHEDULE</div>
        <div class="card-body">
          <div class="grid-2" style="margin-bottom:16px;">
            <div>
              <label class="form-label">Start Time</label>
              <input type="time" id="startTime" value="${startTimeVal}">
            </div>
            <div>
              <label class="form-label">End Time</label>
              <input type="time" id="endTime" value="${endTimeVal}">
            </div>
          </div>
          <button class="save-btn" onclick="saveSchedule()">✓ Save Schedule</button>
          <div class="stat-row" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px;border-bottom:none;">
            <span class="stat-label">Status</span>
            <span class="stat-value" id="scheduleStatus" style="color:var(--accent2)">Ready</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ══ MOTOR ZONES ══ -->
    <div class="page-section" id="section-motorzones">
      <div class="card" style="max-width:580px;">
        <div class="card-header">⚡ MOTOR ZONE SETTINGS</div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label">Zone Boundary (px, 0–640)</label>
            <input type="number" id="zoneBoundaryInput" min="0" max="640" value="${zoneBoundary}" placeholder="320">
          </div>
          <div class="zone-grid">
            <div class="zone-block left-z">
              <div class="zone-lbl left">◀ Left Zone</div>
              <div class="form-group"><label class="form-label">Steps</label><input type="number" id="zoneLeftSteps" min="1" max="9999" value="${zoneLeftSteps}"></div>
              <div class="form-group" style="margin-bottom:0"><label class="form-label">Direction</label>
                <select id="zoneLeftDir">
                  <option value="CW" ${zoneLeftDir === 'CW' ? 'selected' : ''}>CW — Clockwise</option>
                  <option value="CCW" ${zoneLeftDir === 'CCW' ? 'selected' : ''}>CCW — Counter-CW</option>
                </select>
              </div>
            </div>
            <div class="zone-block right-z">
              <div class="zone-lbl right">Right Zone ▶</div>
              <div class="form-group"><label class="form-label">Steps</label><input type="number" id="zoneRightSteps" min="1" max="9999" value="${zoneRightSteps}"></div>
              <div class="form-group" style="margin-bottom:0"><label class="form-label">Direction</label>
                <select id="zoneRightDir">
                  <option value="CW" ${zoneRightDir === 'CW' ? 'selected' : ''}>CW — Clockwise</option>
                  <option value="CCW" ${zoneRightDir === 'CCW' ? 'selected' : ''}>CCW — Counter-CW</option>
                </select>
              </div>
            </div>
          </div>
          <button class="save-btn" onclick="saveMotorSettings()">⚙ Save Motor Settings</button>

          <div class="motor-manual">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin-bottom:12px;">⚡ Manual Motor Run</div>
            <div class="grid-2" style="margin-bottom:12px;">
              <div><label class="form-label">Steps</label><input type="number" id="manualSteps" min="1" max="9999" value="200"></div>
              <div><label class="form-label">Direction</label>
                <select id="manualDir">
                  <option value="CW">CW — Clockwise</option>
                  <option value="CCW">CCW — Counter-CW</option>
                </select>
              </div>
            </div>
            <button class="run-btn" id="motorRunBtn" onclick="runMotorManual()">▶ Run Motor</button>
            <div class="stat-row" style="margin-top:10px;border-bottom:none;">
              <span class="stat-label">Motor status</span>
              <span class="stat-value" id="motorRunStatus" style="color:var(--muted);font-size:11px;">Idle</span>
            </div>
          </div>
          <div class="stat-row" style="margin-top:6px;border-bottom:none;">
            <span class="stat-label">Save status</span>
            <span class="stat-value" id="motorStatus" style="color:var(--accent2)">Ready</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ══ ALERTS ══ -->
    <div class="page-section" id="section-alerts">
      <div class="card">
        <div class="card-header">🔔 ALERT LOG</div>
        <div class="card-body">
          <div class="alert-list" id="alertListFull" style="max-height:500px;"><div class="alert-empty">Loading…</div></div>
        </div>
      </div>
    </div>

    <!-- ══ EVENT LOG ══ -->
    <div class="page-section" id="section-eventlog">
      <div class="card">
        <div class="card-header">📋 EVENT LOG</div>
        <div class="card-body">
          <div class="log-area" id="logArea" style="height:420px;"></div>
        </div>
      </div>
    </div>

  </div>
</div>

<script>
  // ── Tunnel URL ────────────────────────────────────────────────────────────
  let API_BASE = localStorage.getItem('tunnel_url') || '';
  function setTunnelUrl(url) {
    API_BASE = url.trim().replace(/\\/$/, '');
    localStorage.setItem('tunnel_url', API_BASE);
    showToast('✅ Tunnel URL saved', 'success', 2500);
  }
  document.addEventListener('DOMContentLoaded', () => {
    const inp = document.getElementById('tunnelInput');
    if (inp && API_BASE) inp.value = API_BASE;
  });

  // ── Nav ───────────────────────────────────────────────────────────────────
  const pageTitles = { livefeed:'Live Feed', sensors:'Water Sensors', actuators:'Actuators', schedule:'Feeding Schedule', motorzones:'Motor Zones', alerts:'Alerts', eventlog:'Event Log' };
  function showSection(id) {
    document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById('section-' + id).classList.add('active');
    document.getElementById('nav-' + id).classList.add('active');
    const pt = document.getElementById('pageTitle');
    pt.innerHTML = pageTitles[id] + ' <span class="sub">· CrayCheck</span>';
    if (id === 'alerts') fetchAlerts(true);
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  function showToast(msg, type='info', dur=4000) {
    const c = document.getElementById('toastContainer');
    const t = document.createElement('div'); t.className = \`toast \${type}\`;
    const s = document.createElement('span'); s.textContent = msg;
    const b = document.createElement('button'); b.className='toast-close'; b.textContent='✕';
    b.onclick = () => dismiss(t);
    t.appendChild(s); t.appendChild(b); c.appendChild(t);
    if (dur > 0) setTimeout(() => dismiss(t), dur);
  }
  function dismiss(t) { t.style.animation='toastOut 0.3s ease forwards'; setTimeout(()=>t.remove(),300); }

  // ── Log ───────────────────────────────────────────────────────────────────
  const logArea = document.getElementById('logArea');
  function addLog(msg, type='') {
    const t = new Date().toTimeString().slice(0,8);
    const e = document.createElement('div'); e.className='log-entry';
    e.innerHTML = \`<span class="log-time">\${t}</span><span class="log-msg \${type}">\${msg}</span>\`;
    logArea.prepend(e);
    while (logArea.children.length > 50) logArea.removeChild(logArea.lastChild);
  }

  // ── Camera ────────────────────────────────────────────────────────────────
  const canvas = document.getElementById('feed');
  const ctx    = canvas.getContext('2d');
  let fpsCounter=0, prevFrame=null, online=false;
  let boxOpacity=0, boxTarget=0;
  let isScanningState=false, isDetected=false, isEggColor=false;
  let detectionNote='', currentBbox=null, currentZone='';
  let zoneBoundaryPx=${zoneBoundary};
  let prevScanning=false, prevDetected=false, prevEggColor=false;
  let esp32Connected=false;

  function setOnline(state) {
    if (online===state) return; online=state;
    addLog(state?'Stream connected':'Stream lost', state?'ok':'warn');
  }

  function estimateMotion(id) {
    if (!prevFrame) { prevFrame=id; return 0; }
    let diff=0, cnt=0;
    const d1=id.data, d2=prevFrame.data;
    for (let i=0; i<d1.length; i+=40*4) {
      if ((Math.abs(d1[i]-d2[i])+Math.abs(d1[i+1]-d2[i+1])+Math.abs(d1[i+2]-d2[i+2]))/3>15) diff++;
      cnt++;
    }
    prevFrame=id;
    return Math.min(100, Math.round((diff/cnt)*300));
  }

  function drawZoneOverlay() {
    const w=canvas.width, h=canvas.height;
    const bx=Math.round(zoneBoundaryPx*(w/640));
    ctx.save();
    ctx.fillStyle='rgba(0,112,243,0.04)'; ctx.fillRect(0,0,bx,h);
    ctx.fillStyle='rgba(0,179,126,0.03)'; ctx.fillRect(bx,0,w-bx,h);
    ctx.setLineDash([5,4]); ctx.strokeStyle='rgba(255,255,255,0.22)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(bx,0); ctx.lineTo(bx,h); ctx.stroke(); ctx.setLineDash([]);
    ctx.font='9px "Share Tech Mono",monospace';
    ctx.fillStyle='rgba(0,200,255,0.5)'; ctx.fillText('◀ LEFT',5,14);
    ctx.fillStyle='rgba(0,255,157,0.5)'; ctx.fillText('RIGHT ▶',bx+5,14);
    ctx.restore();
  }

  function drawBoundingBox() {
    if (boxOpacity<=0) return;
    const w=canvas.width, h=canvas.height;
    let x1,y1,x2,y2;
    if (currentBbox&&currentBbox.length===4) {
      const sx=w/640, sy=h/480;
      x1=currentBbox[0]*sx; y1=currentBbox[1]*sy; x2=currentBbox[2]*sx; y2=currentBbox[3]*sy;
    } else { const p=14; x1=p; y1=p; x2=w-p; y2=h-p; }
    const bw=x2-x1, bh=y2-y1;
    const pulse=0.75+0.25*Math.sin(Date.now()/280);
    const col=isEggColor?'#f59e0b':(currentZone==='left'?'#00c8ff':'#00ff9d');
    const lbl=isEggColor?'🦞 CRAYFISH + 🥚 EGGS':(currentZone==='left'?'🦞 LEFT ZONE':currentZone==='right'?'🦞 RIGHT ZONE':'🦞 CRAYFISH DETECTED');
    ctx.save();
    ctx.globalAlpha=boxOpacity*pulse;
    ctx.shadowColor=col; ctx.shadowBlur=16;
    ctx.strokeStyle=col; ctx.lineWidth=2; ctx.strokeRect(x1,y1,bw,bh);
    const cs=12; ctx.lineWidth=3;
    [[x1,y1,cs,0,0,cs],[x2,y1,-cs,0,0,cs],[x1,y2,cs,0,0,-cs],[x2,y2,-cs,0,0,-cs]].forEach(([px,py,dx1,dy1,dx2,dy2])=>{
      ctx.beginPath(); ctx.moveTo(px+dx1,py+dy1); ctx.lineTo(px,py); ctx.lineTo(px+dx2,py+dy2); ctx.stroke();
    });
    ctx.globalAlpha=boxOpacity; ctx.shadowBlur=0;
    ctx.fillStyle='rgba(0,10,20,0.8)'; ctx.fillRect(x1,y1,210,24);
    ctx.strokeStyle=col; ctx.lineWidth=1; ctx.strokeRect(x1,y1,210,24);
    ctx.fillStyle=col; ctx.font='bold 10px "Share Tech Mono",monospace';
    ctx.fillText(lbl, x1+7, y1+16);
    if (detectionNote) { ctx.font='9px "Share Tech Mono",monospace'; ctx.fillStyle='rgba(0,255,157,0.65)'; ctx.fillText(detectionNote.slice(0,70),x1+3,y2+13); }
    ctx.restore();
  }

  function drawScanningOverlay() {
    if (!isScanningState) return;
    const w=canvas.width, h=canvas.height, t=Date.now();
    const alpha=0.45+0.35*Math.sin(t/400);
    ctx.save();
    ctx.setLineDash([10,6]); ctx.lineDashOffset=-(t/40)%16;
    ctx.strokeStyle=\`rgba(0,200,255,\${alpha})\`; ctx.lineWidth=2;
    ctx.strokeRect(8,8,w-16,h-16); ctx.setLineDash([]);
    ctx.fillStyle='rgba(0,15,30,0.82)'; ctx.fillRect(8,8,175,26);
    ctx.strokeStyle='rgba(0,200,255,0.55)'; ctx.lineWidth=1; ctx.strokeRect(8,8,175,26);
    ctx.fillStyle=\`rgba(0,200,255,\${0.7+0.3*Math.sin(t/300)})\`;
    ctx.font='10px "Share Tech Mono",monospace';
    ctx.fillText('⟳  ANALYZING FRAME…',18,26);
    ctx.restore();
  }

  function fetchFrame() {
    const img=new Image();
    img.onload=()=>{
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      drawZoneOverlay();
      if (boxOpacity<boxTarget) boxOpacity=Math.min(boxTarget,boxOpacity+0.08);
      if (boxOpacity>boxTarget) boxOpacity=Math.max(boxTarget,boxOpacity-0.05);
      drawBoundingBox(); drawScanningOverlay();
      const id=ctx.getImageData(0,0,canvas.width,canvas.height);
      const ml=estimateMotion(id);
      document.getElementById('motionPctBadge').textContent=ml+'% motion';
      fpsCounter++; setOnline(true);
      setTimeout(fetchFrame,33);
    };
    img.onerror=()=>{ setOnline(false); setTimeout(fetchFrame,1000); };
    img.src=\`\${API_BASE}/snapshot?t=\${Date.now()}\`;
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────
  const snapshotCanvas=document.getElementById('snapshotCanvas');
  let snapshotDataUrl=null, snapshotBbox=null, snapshotZone='', lastSnapshotTs=0;

  function drawSnapshotBbox(imgEl,bbox,zone,egg,isModal) {
    const tc=isModal?document.getElementById('snapshotModalCanvas'):snapshotCanvas;
    const tCtx=tc.getContext('2d');
    const nw=imgEl.naturalWidth||640, nh=imgEl.naturalHeight||480;
    tc.width=nw; tc.height=nh; tCtx.drawImage(imgEl,0,0,nw,nh);
    if (!bbox||bbox.length!==4) return;
    const [x1,y1,x2,y2]=bbox, bw=x2-x1, bh=y2-y1;
    const col=egg?'#f59e0b':(zone==='left'?'#00c8ff':'#00ff9d');
    const lbl=egg?'🦞+🥚 EGGS':(zone==='left'?'🦞 LEFT':zone==='right'?'🦞 RIGHT':'🦞 DETECTED');
    tCtx.save();
    tCtx.shadowColor=col; tCtx.shadowBlur=10;
    tCtx.strokeStyle=col; tCtx.lineWidth=2; tCtx.strokeRect(x1,y1,bw,bh);
    const cs=10; tCtx.lineWidth=3;
    [[x1,y1,cs,0,0,cs],[x2,y1,-cs,0,0,cs],[x1,y2,cs,0,0,-cs],[x2,y2,-cs,0,0,-cs]].forEach(([px,py,dx1,dy1,dx2,dy2])=>{
      tCtx.beginPath(); tCtx.moveTo(px+dx1,py+dy1); tCtx.lineTo(px,py); tCtx.lineTo(px+dx2,py+dy2); tCtx.stroke();
    });
    tCtx.shadowBlur=0;
    const lw=Math.min(bw,180);
    tCtx.fillStyle='rgba(0,0,0,0.75)'; tCtx.fillRect(x1,y1-20,lw,20);
    tCtx.fillStyle=col; tCtx.font='bold 10px "Share Tech Mono",monospace';
    tCtx.fillText(lbl,x1+5,y1-6);
    tCtx.restore();
  }

  function fetchAndDisplaySnapshot(bbox,zone,egg) {
    const img=new Image();
    img.onload=()=>{
      snapshotCanvas.width=img.naturalWidth||640; snapshotCanvas.height=img.naturalHeight||480;
      drawSnapshotBbox(img,bbox,zone,egg,false);
      document.getElementById('snapshotCanvasWrap').style.display='block';
      document.getElementById('snapshotPlaceholder').style.display='none';
      snapshotDataUrl=img.src; snapshotBbox=bbox; snapshotZone=zone;
    };
    img.onerror=()=>{ document.getElementById('snapshotCanvasWrap').style.display='none'; document.getElementById('snapshotPlaceholder').style.display='flex'; };
    img.src=\`\${API_BASE}/snapshot-captured?t=\${Date.now()}\`;
  }

  function openModal() {
    if (!snapshotDataUrl) return;
    const img=new Image();
    img.onload=()=>{
      const mc=document.getElementById('snapshotModalCanvas');
      mc.width=img.naturalWidth||640; mc.height=img.naturalHeight||480;
      drawSnapshotBbox(img,snapshotBbox,snapshotZone,isEggColor,true);
      document.getElementById('modalMeta').textContent='Captured · '+new Date().toLocaleTimeString();
      document.getElementById('modalZone').textContent=snapshotZone?'Zone: '+snapshotZone.toUpperCase():'—';
      document.getElementById('snapshotModal').classList.add('open');
    };
    img.src=\`\${API_BASE}/snapshot-captured?t=\${Date.now()}\`;
  }
  function closeModal() { document.getElementById('snapshotModal').classList.remove('open'); }
  document.getElementById('snapshotModal').addEventListener('click',function(e){ if(e.target===this) closeModal(); });

  // ── Status poll ───────────────────────────────────────────────────────────
  let geminiConnected=null;
  async function pollStatus() {
    try {
      const res=await fetch(\`\${API_BASE}/status\`);
      const data=await res.json();
      if (geminiConnected===null) { geminiConnected=true; addLog('AI backend connected','ok'); }

      const scanning=!!data.scanning, detected=!!data.crayfish, egg=!!data.egg_color;
      const note=data.note||'', bbox=Array.isArray(data.bbox)?data.bbox:null, zone=data.zone||'';

      isDetected=detected; isEggColor=egg; isScanningState=scanning;
      detectionNote=note; currentBbox=bbox; currentZone=zone;
      if (typeof data.zone_boundary==='number') zoneBoundaryPx=data.zone_boundary;
      if (typeof data.detection_paused==='boolean') syncDetectionUI(data.detection_paused);

      boxTarget=detected?1:0;

      if (data.snapshot_ts&&data.snapshot_ts!==lastSnapshotTs) {
        lastSnapshotTs=data.snapshot_ts;
        fetchAndDisplaySnapshot(bbox,zone,egg);
        addLog('📸 Motion snapshot captured','ok');
        showToast('📸 Snapshot captured','info',2500);
      }

      document.getElementById('snapshotEggBadge').style.display=(detected&&egg)?'block':'none';
      document.getElementById('snapshotScanBadge').style.display=scanning?'inline-flex':'none';

      const db=document.getElementById('detectBadge');
      const dl=document.getElementById('detectBadgeLabel');
      const dn=document.getElementById('detectNote');
      const dz=document.getElementById('detectZone');

      if (scanning) { db.className='status-chip scanning'; dl.textContent='SCANNING…'; dn.textContent='Analyzing frame…'; }
      else if (detected) {
        db.className='status-chip detected'; dl.textContent='DETECTED'; dn.textContent=note.slice(0,55)||'Crayfish confirmed';
        if (zone) { dz.style.display='inline'; dz.textContent='📍 ZONE: '+zone.toUpperCase(); }
      } else {
        db.className='status-chip idle'; dl.textContent='IDLE'; dn.textContent=note.slice(0,55)||'Watching for motion…'; dz.style.display='none';
      }

      if (scanning&&!prevScanning) { addLog('🚨 Motion — scanning…','warn'); showToast('🚨 Motion detected!','info',4000); }
      if (!scanning&&prevScanning&&!detected) { addLog('Scan complete — no crayfish',''); showToast('No crayfish detected','info',3000); }
      if (detected&&!prevDetected) {
        const zm=zone?' ('+zone.toUpperCase()+')':'';
        addLog('🦞 Crayfish confirmed!'+zm+' ('+(data.confidence||'?')+')','ok');
        showToast('🦞 Crayfish confirmed!'+zm,'success',6000);
      }
      if (detected&&egg&&!prevEggColor) { addLog('🥚 Eggs detected!','warn'); showToast('🥚 Eggs detected!','warning',6000); }

      prevScanning=scanning; prevDetected=detected; prevEggColor=egg;
    } catch(_) { if(geminiConnected===null) addLog('AI backend unavailable','warn'); }
  }

  // ── Water poll ────────────────────────────────────────────────────────────
  async function pollWater() {
    try {
      const res=await fetch(\`\${API_BASE}/api/water/status\`,{cache:'no-store'});
      const s=await res.json();

      esp32Connected=!!s.connected;
      const dot=document.getElementById('esp32Dot');
      const stEl=document.getElementById('esp32State');
      dot.className='conn-dot '+(esp32Connected?'online':'offline');
      stEl.textContent=esp32Connected?'Online':'Offline';
      stEl.style.color=esp32Connected?'var(--accent2)':'var(--danger)';

      // No-connection banners
      const b1=document.getElementById('noConnBanner');
      const b2=document.getElementById('noConnBanner2');
      if(b1) b1.className='no-conn-banner'+(esp32Connected?'':' visible');
      if(b2) b2.className='no-conn-banner'+(esp32Connected?'':' visible');

      const nh3=s.ammonia_raw, tmp=s.temperature_c, trb=s.turbidity_ntu, flw=s.flow_lpm;
      const hasData=esp32Connected&&nh3!==null&&tmp!==null;

      // Metric values
      document.getElementById('m-ammonia').textContent   = nh3!==null?nh3:'--';
      document.getElementById('m-temp').textContent      = tmp!==null?parseFloat(tmp).toFixed(1):'--';
      document.getElementById('m-turbidity').textContent = trb!==null?trb:'--';
      document.getElementById('m-flow').textContent      = flw!==null?parseFloat(flw).toFixed(2):'--';

      // Badges
      function setBadge(id, val, ok, warn, badTxt, warnTxt, okTxt, noDataTxt='— No data') {
        const el=document.getElementById(id);
        if (val===null||val===undefined||!esp32Connected) { el.className='metric-badge off'; el.textContent=noDataTxt; return; }
        if (val>warn)    { el.className='metric-badge bad';  el.textContent='⚠ '+badTxt; }
        else if (val>ok) { el.className='metric-badge warn'; el.textContent='⚡ '+warnTxt; }
        else              { el.className='metric-badge ok';   el.textContent='✓ '+okTxt; }
      }
      setBadge('m-ammonia-badge',  nh3, 2000, 2000, 'CRITICAL', 'WARNING — Moderate', 'Normal — LOW');
      setBadge('m-temp-badge',     tmp, 28,   28,   'TOO HOT',  'WARNING — Warm',     'Within range — '+parseFloat(tmp||0).toFixed(1)+'°C');
      setBadge('m-turbidity-badge',trb, 2000, 2000, 'CLOUDY',   'Slightly cloudy',    'Clear');

      const flwEl=document.getElementById('m-flow-badge');
      if (!esp32Connected||flw===null) { flwEl.className='metric-badge off'; flwEl.textContent='— No data'; }
      else if ((s.valve_state||'').toUpperCase()==='OPEN') { flwEl.className='metric-badge ok'; flwEl.textContent='✓ Valve open'; }
      else if (flw>0) { flwEl.className='metric-badge ok'; flwEl.textContent='✓ Flowing'; }
      else { flwEl.className='metric-badge warn'; flwEl.textContent='⚡ No flow'; }

      // Sensors page
      document.getElementById('s-ammonia-raw').textContent    = nh3!==null?nh3+' raw':'-- (no data)';
      document.getElementById('s-ammonia-status').textContent  = !esp32Connected?'ESP32 offline':nh3>2500?'CRITICAL':nh3>2000?'WARNING — Moderate':'Normal — LOW';
      document.getElementById('s-ammonia-status').style.color  = !esp32Connected?'var(--muted)':nh3>2500?'var(--danger)':nh3>2000?'var(--warn)':'var(--accent2)';
      document.getElementById('s-temp-val').textContent        = tmp!==null?parseFloat(tmp).toFixed(1)+' °C':'-- (no data)';
      document.getElementById('s-temp-status').textContent     = !esp32Connected?'ESP32 offline':tmp>30?'CRITICAL — Too hot':tmp>28?'WARNING — Warm':'Within range';
      document.getElementById('s-temp-status').style.color     = !esp32Connected?'var(--muted)':tmp>30?'var(--danger)':tmp>28?'var(--warn)':'var(--accent2)';
      document.getElementById('s-peltier-state').textContent   = !esp32Connected?'Offline':(s.peltier_state||'--');
      document.getElementById('s-turbidity-val').textContent   = trb!==null?trb+' NTU':'-- (no data)';
      document.getElementById('s-turbidity-status').textContent= !esp32Connected?'ESP32 offline':trb>2500?'CRITICAL':trb>2000?'Slightly cloudy':'Clear';
      document.getElementById('s-turbidity-status').style.color= !esp32Connected?'var(--muted)':trb>2500?'var(--danger)':trb>2000?'var(--warn)':'var(--accent2)';
      document.getElementById('s-uv-state').textContent        = !esp32Connected?'Offline':(s.uv_state||'--');
      document.getElementById('s-flow-val').textContent        = flw!==null?parseFloat(flw).toFixed(2)+' L/min':'-- (no data)';
      document.getElementById('s-total-val').textContent       = s.total_liters!==null?(parseFloat(s.total_liters||0).toFixed(3)+' L'):'--';
      document.getElementById('s-valve-state').textContent     = !esp32Connected?'Offline':(s.valve_state||'--');

      // Actuators
      const pumpOn=(s.pump_state||'').toUpperCase()==='ON';
      const uvOn=(s.uv_state||'').toUpperCase()==='ON';
      const valveOn=(s.valve_state||'').toUpperCase()==='OPEN';
      const peltOn=(s.peltier_state||'').toUpperCase()==='ON';

      function setActState(id,on,onTxt,offTxt) {
        const el=document.getElementById(id);
        el.textContent=esp32Connected?(on?'● '+onTxt:'● '+offTxt):'● Offline';
        el.className='actuator-state '+(esp32Connected&&on?'on':'off');
      }
      setActState('act-uv-state',    uvOn,   'ON',   'OFF');
      setActState('act-pump-state',  pumpOn, 'ON',   'OFF');
      setActState('act-valve-state', valveOn,'OPEN', 'CLOSED');
      setActState('act-peltier-state',peltOn,'ON',   'OFF');

      const lc=s.last_command;
      document.getElementById('act-last-cmd').textContent  =lc?(typeof lc==='string'?lc:(lc.action||'--').toUpperCase()):'—';
      document.getElementById('act-last-reply').textContent=s.last_reply||'—';
      document.getElementById('act-serial').textContent    =s.serial_port||'—';

    } catch(_) {}
  }

  // ── Charts ────────────────────────────────────────────────────────────────
  const chartBase = {
    type:'line',
    options:{
      responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{ legend:{ display:false } },
      scales:{
        x:{ display:false },
        y:{ grid:{ color:'rgba(0,0,0,0.05)' }, ticks:{ color:'#7a93b4', font:{ size:9, family:'Share Tech Mono' } } }
      },
      elements:{ point:{ radius:3, hoverRadius:5, borderWidth:2 }, line:{ tension:0.4, borderWidth:2 } }
    }
  };

  function makeChart(id,borderColor,bgColor) {
    const el=document.getElementById(id);
    if (!el) return null;
    return new Chart(el,{
      ...chartBase,
      data:{ labels:[], datasets:[{ data:[], borderColor, backgroundColor:bgColor, fill:true, spanGaps:false }] },
      options:{ ...chartBase.options }
    });
  }

  const charts={
    ammonia:   makeChart('chartAmmonia',  '#0070f3','rgba(0,112,243,0.07)'),
    temp:      makeChart('chartTemp',     '#00b37e','rgba(0,179,126,0.07)'),
    ammonia2:  makeChart('chartAmmonia2', '#0070f3','rgba(0,112,243,0.07)'),
    temp2:     makeChart('chartTemp2',    '#00b37e','rgba(0,179,126,0.07)'),
    turbidity: makeChart('chartTurbidity','#f59e0b','rgba(245,158,11,0.07)'),
    flow:      makeChart('chartFlow',     '#06b6d4','rgba(6,182,212,0.07)')
  };

  function updateChart(chart,labels,data) {
    if (!chart) return;
    chart.data.labels=labels;
    chart.data.datasets[0].data=data.map(v=>(v===null||v===undefined||!isFinite(v))?null:v);
    chart.update('none');
  }

  async function fetchHistory() {
    try {
      const res=await fetch(\`\${API_BASE}/api/water/history?limit=20\`);
      const body=await res.json();
      if (!body.ok||!body.data) return;
      const rows=[...body.data].reverse();
      const labels=rows.map(r=>new Date(r.timestamp).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}));
      updateChart(charts.ammonia,   labels, rows.map(r=>r.ammonia_raw));
      updateChart(charts.temp,      labels, rows.map(r=>r.temperature_c));
      updateChart(charts.ammonia2,  labels, rows.map(r=>r.ammonia_raw));
      updateChart(charts.temp2,     labels, rows.map(r=>r.temperature_c));
      updateChart(charts.turbidity, labels, rows.map(r=>r.turbidity_ntu));
      updateChart(charts.flow,      labels, rows.map(r=>r.flow_lpm));
    } catch(_) {}
  }

  // ── Alerts ────────────────────────────────────────────────────────────────
  async function fetchAlerts(full=false) {
    try {
      const res=await fetch(\`\${API_BASE}/api/water/alerts?limit=\${full?50:10}\`);
      const body=await res.json();
      if (!body.ok) return;
      function render(data,id) {
        const el=document.getElementById(id); if (!el) return;
        if (!data.length) { el.innerHTML='<div class="alert-empty">No alerts yet — all clear ✓</div>'; return; }
        el.innerHTML=data.map(a=>\`
          <div class="alert-item \${a.severity||'warning'}">
            <div class="alert-icon">\${a.severity==='critical'?'🔴':'🟡'}</div>
            <div>
              <div class="alert-title">\${(a.type||'').replace(/_/g,' ').toUpperCase()} — \${(a.severity||'').toUpperCase()}</div>
              <div class="alert-meta">Value: \${a.value} · Threshold: \${a.threshold} · \${new Date(a.timestamp).toLocaleTimeString()}</div>
            </div>
          </div>\`).join('');
      }
      render(body.data,'alertList');
      if (full) render(body.data,'alertListFull');
    } catch(_) {}
  }

  // ── Detection toggle ──────────────────────────────────────────────────────
  let detectionIsPaused=false;
  function syncDetectionUI(paused) {
    detectionIsPaused=paused;
    const btn=document.getElementById('detectionToggleBtn');
    const lbl=document.getElementById('detectionToggleLabel');
    const ico=document.getElementById('detectionToggleIcon');
    btn.className='detect-toggle'+(paused?' paused':'');
    ico.textContent=paused?'⏸':'⬤';
    lbl.textContent=paused?'Auto-detection: OFF':'Auto-detection: ON';
  }
  async function toggleDetection() {
    const btn=document.getElementById('detectionToggleBtn'); btn.disabled=true;
    try {
      const res=await fetch(\`\${API_BASE}/api/detection/toggle\`,{method:'POST'});
      const data=await res.json();
      if (data.ok) {
        syncDetectionUI(data.paused);
        const msg=data.paused?'⏸ Detection paused':'▶ Detection resumed';
        addLog(msg,data.paused?'warn':'ok'); showToast(msg,data.paused?'warning':'success',3500);
      }
    } catch(e) { showToast('Toggle failed','error',3000); }
    finally { btn.disabled=false; }
  }
  async function fetchDetectionState() {
    try { const res=await fetch(\`\${API_BASE}/api/detection/status\`); const data=await res.json(); syncDetectionUI(!!data.paused); } catch(_) {}
  }

  // ── Motor run ─────────────────────────────────────────────────────────────
  async function runMotorManual() {
    const steps=parseInt(document.getElementById('manualSteps').value)||200;
    const dir=document.getElementById('manualDir').value;
    const btn=document.getElementById('motorRunBtn');
    const st=document.getElementById('motorRunStatus');
    if (steps<1||steps>9999) { showToast('Steps must be 1–9999','error',3000); return; }
    btn.disabled=true; st.textContent='Running…'; st.style.color='var(--accent)';
    try {
      const res=await fetch(\`\${API_BASE}/api/motor/run\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({steps,direction:dir})});
      const data=await res.json();
      if (data.ok) { st.textContent=\`Done ✓ (\${steps} \${dir})\`; st.style.color='var(--accent2)'; addLog(\`⚙ Motor: \${steps} \${dir}\`,'ok'); showToast(\`⚙ Motor ran \${steps} \${dir}\`,'success',3000); }
      else throw new Error(data.error||'Error');
    } catch(e) { st.textContent='Error — '+e.message; st.style.color='var(--danger)'; showToast('Motor failed: '+e.message,'error',4000); }
    finally { btn.disabled=false; setTimeout(()=>{ st.textContent='Idle'; st.style.color='var(--muted)'; },5000); }
  }

  // ── Feed button ───────────────────────────────────────────────────────────
  document.getElementById('feedBtn').addEventListener('click',async()=>{
    const btn=document.getElementById('feedBtn'); btn.disabled=true; btn.textContent='Sending…';
    try { await fetch(\`\${API_BASE}/feed\`,{method:'POST'}); addLog('🍤 Manual feed triggered','ok'); showToast('🍤 Feed triggered!','success',3000); }
    catch(_) { addLog('Feed command failed','warn'); showToast('Feed command failed','error',3000); }
    finally { setTimeout(()=>{ btn.disabled=false; btn.textContent='🍤 Feed Now'; },2000); }
  });

  // ── Water control ─────────────────────────────────────────────────────────
  async function sendControl(action) {
    try {
      await fetch(\`\${API_BASE}/api/water/control\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
      addLog('⚙ Control: '+action,'ok'); showToast('⚙ Sent: '+action,'success',2500);
      setTimeout(pollWater,800);
    } catch(_) { showToast('Command failed','error',3000); }
  }

  // ── Save motor ────────────────────────────────────────────────────────────
  function saveMotorSettings() {
    const boundary=parseInt(document.getElementById('zoneBoundaryInput').value)||320;
    const ls=parseInt(document.getElementById('zoneLeftSteps').value)||200;
    const ld=document.getElementById('zoneLeftDir').value;
    const rs=parseInt(document.getElementById('zoneRightSteps').value)||200;
    const rd=document.getElementById('zoneRightDir').value;
    fetch(\`\${API_BASE}/api/config\`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({motor_zone_boundary:boundary,motor_zone_left_steps:ls,motor_zone_left_dir:ld,motor_zone_right_steps:rs,motor_zone_right_dir:rd})
    }).then(r=>r.json()).then(d=>{
      if(d.ok){ document.getElementById('motorStatus').textContent='Saved ✓'; document.getElementById('motorStatus').style.color='var(--accent2)'; zoneBoundaryPx=boundary; addLog('⚙ Motor settings saved','ok'); showToast('⚙ Saved','success',3000); setTimeout(()=>{document.getElementById('motorStatus').textContent='Ready';},3000); }
    }).catch(()=>{ document.getElementById('motorStatus').textContent='Error'; document.getElementById('motorStatus').style.color='var(--danger)'; });
  }

  // ── Save schedule ─────────────────────────────────────────────────────────
  function saveSchedule() {
    const sv=document.getElementById('startTime').value;
    const ev=document.getElementById('endTime').value;
    if (!sv||!ev) { document.getElementById('scheduleStatus').textContent='Invalid times'; return; }
    fetch(\`\${API_BASE}/api/config\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({activation_start:sv,activation_end:ev})})
    .then(r=>r.json()).then(d=>{ if(d.ok){ document.getElementById('scheduleStatus').textContent='Saved ✓'; document.getElementById('scheduleStatus').style.color='var(--accent2)'; addLog('Schedule: '+sv+' – '+ev,'ok'); showToast('Schedule saved','success',3000); setTimeout(()=>{document.getElementById('scheduleStatus').textContent='Ready';},3000); } })
    .catch(()=>{document.getElementById('scheduleStatus').textContent='Error';});
  }

  // ── FPS / Clock ───────────────────────────────────────────────────────────
  setInterval(()=>{ document.getElementById('fpsBadge').textContent=fpsCounter+' FPS'; fpsCounter=0; },1000);
  setInterval(()=>{ document.getElementById('camTime').textContent=new Date().toTimeString().slice(0,8); },1000);

  // ── Boot ──────────────────────────────────────────────────────────────────
  addLog('System initializing…','');
  const saved=localStorage.getItem('tunnel_url')||'';
  if (saved) document.getElementById('tunnelInput').value=saved;
  fetchDetectionState();
  fetchFrame();
  pollStatus();
  pollWater();
  fetchHistory();
  fetchAlerts();
  setInterval(pollStatus,  2000);
  setInterval(pollWater,   2500);
  setInterval(fetchHistory,15000);
  setInterval(fetchAlerts, 30000);
<\/script>
</body>
</html>`);
});

// ── /status ───────────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = readConfig();
    if (!fs.existsSync(statusFile)) {
        return res.json({
            crayfish: false, scanning: false, confidence: '', note: '',
            movement: 0, egg_color: false, snapshot_ts: 0, bbox: null, zone: '',
            zone_boundary: cfg.motor_zone_boundary || 320,
            detection_paused: detectionPaused
        });
    }
    try {
        const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        data.zone_boundary   = cfg.motor_zone_boundary || 320;
        data.detection_paused = detectionPaused;
        res.json(data);
    } catch (_) {
        res.json({ crayfish: false, scanning: false, detection_paused: detectionPaused });
    }
});

app.post('/api/detection/toggle', (req, res) => {
    detectionPaused = !detectionPaused;
    try {
        const cfg = readConfig();
        cfg.detection_paused = detectionPaused;
        writeConfig(cfg);
    } catch (_) {}
    res.json({ ok: true, paused: detectionPaused });
});

app.get('/api/detection/status', (req, res) => {
    res.json({ paused: detectionPaused });
});

app.post('/api/motor/run', (req, res) => {
    const steps     = Math.max(1, Math.min(parseInt(req.body.steps) || 200, 9999));
    const direction = (req.body.direction || 'CW').toString().toUpperCase();
    if (!['CW', 'CCW'].includes(direction)) {
        return res.status(400).json({ ok: false, error: 'direction must be CW or CCW' });
    }
    const motorCmdFile = '/dev/shm/crayfish_motor_cmd.json';
    try {
        fs.writeFileSync(motorCmdFile, JSON.stringify({ steps, direction, ts: Date.now() }));
        res.json({ ok: true, steps, direction });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/config', (req, res) => {
    const existing = readConfig();
    const merged = Object.assign({}, existing, req.body);
    if (req.body.activation_start !== undefined && !req.body.activation_start) return res.json({ ok: false, error: 'Missing start time' });
    if (req.body.activation_end   !== undefined && !req.body.activation_end)   return res.json({ ok: false, error: 'Missing end time' });
    writeConfig(merged);
    res.json({ ok: true });
});

app.get('/api/config', (req, res) => res.json(readConfig()));

app.get('/snapshot', (req, res) => {
    if (!fs.existsSync(imageFile)) return res.status(503).send('No frame yet');
    try {
        const frame = fs.readFileSync(imageFile);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.end(frame);
    } catch (_) { res.status(503).send('Frame busy'); }
});

app.get('/snapshot-captured', (req, res) => {
    if (!fs.existsSync(snapshotFile)) return res.status(404).send('No snapshot');
    try {
        const frame = fs.readFileSync(snapshotFile);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.end(frame);
    } catch (_) { res.status(503).send('Snapshot busy'); }
});

app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    streamClients.add(res);
    req.on('close', () => { streamClients.delete(res); });
});

app.post('/feed', (req, res) => {
    try {
        fs.writeFileSync(signalFile, 'FEED');
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.listen(port, () => {
    console.log(`Web server ready at http://localhost:${port}`);
});