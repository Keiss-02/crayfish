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
  circ_pump_state: String,
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
      circ_pump_state: status.circ_pump_state,
      uv_state:       status.uv_state,
      peltier_state:  status.peltier_state,
      valve_state:    status.valve_state,
      note:           status.note,
      connected:      status.connected,
      trigger:        trigger
    });

    lastSaved = {
      ammonia_raw:   status.ammonia_raw,
      temperature_c: status.temperature_c,
      turbidity_ntu: status.turbidity_ntu,
      flow_lpm:      status.flow_lpm,
      pump_state:    status.pump_state,
      uv_state:      status.uv_state,
      peltier_state: status.peltier_state,
      circ_pump_state: status.circ_pump_state,
      valve_state:   status.valve_state
    };

    console.log(`[MongoDB] Saved (${trigger})`);
  } catch (e) {
    console.error('[MongoDB] Save error:', e.message);
  }
}

async function checkAlerts(status) {
  const checks = [
    { condition: status.ammonia_raw > 5000,  type: 'high_ammonia',   severity: 'critical', value: status.ammonia_raw,   threshold: 2500 },
    { condition: status.ammonia_raw > 4500,  type: 'high_ammonia',   severity: 'warning',  value: status.ammonia_raw,   threshold: 2000 },
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
      break;
    }
  }
}

function hasSignificantChange(status) {
  if (lastSaved.ammonia_raw === null) return false;

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
    status.circ_pump_state !== lastSaved.circ_pump_state ||
    status.uv_state      !== lastSaved.uv_state      ||
    status.peltier_state !== lastSaved.peltier_state ||
    status.valve_state   !== lastSaved.valve_state
  );
}

async function logWaterReading(status) {
  const now = Date.now() / 1000;

  if (lastSaved.ammonia_raw === null) {
    await saveReading(status, 'interval');
    lastLoggedTs = now;
    return;
  }

  if (hasActuatorChange(status)) {
    await saveReading(status, 'actuator_change');
    lastLoggedTs = now;
    await checkAlerts(status);
    return;
  }

  if (hasSignificantChange(status)) {
    await saveReading(status, 'value_change');
    lastLoggedTs = now;
    await checkAlerts(status);
    return;
  }

  if ((now - lastLoggedTs) > 20) {
    await saveReading(status, 'interval');
    lastLoggedTs = now;
    await checkAlerts(status);
  }
}

// ── In-memory state ───────────────────────────────────────────────────────────
let detectionPaused = false;
let autoMode        = true;   // true = ESP32 sensors control actuators; false = manual
let lastLoggedTs    = 0;

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
    circ_pump_state: 'off',
    valve_state: 'unknown',
    last_command: null,
    last_reply: null,
    last_update: null,
    ts: Date.now() / 1000
  };
  const status = readJsonFile(waterStatusFile, fallback);
  status.auto_mode = autoMode;   // always inject current mode

  logWaterReading(status);

  res.json(status);
});

// ── Mode endpoints ────────────────────────────────────────────────────────────
app.get('/api/water/mode', (req, res) => {
  res.json({ ok: true, auto_mode: autoMode });
});

app.post('/api/water/mode', (req, res) => {
  if (typeof req.body.auto_mode === 'boolean') {
    autoMode = req.body.auto_mode;
    console.log(`[MODE] Switched to ${autoMode ? 'AUTOMATED' : 'MANUAL'}`);

    // When restoring auto mode, release all ESP32 overrides immediately
    if (autoMode) {
      const command = { action: 'reset_override', value: null, source: 'mode_switch', ts: Date.now() };
      writeJsonFile(waterCommandFile, command);
      console.log('[MODE] Sent RESET_OVERRIDE to ESP32');
    }
  }
  res.json({ ok: true, auto_mode: autoMode });
});

// ── History endpoint ──────────────────────────────────────────────────────────
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
  const value  = req.body && req.body.value !== undefined ? req.body.value : null;

  // Safety guard on the server: block non-reset actuator commands when in auto mode
  const isResetCmd = action.startsWith('reset');
  if (autoMode && !isResetCmd) {
    console.warn(`[CONTROL] Blocked '${action}' — system is in AUTOMATED mode`);
    return res.status(403).json({ ok: false, error: 'System is in Automated mode. Switch to Manual first.' });
  }

  const command = { action, value, source: 'dashboard', ts: Date.now() };
  if (!writeJsonFile(waterCommandFile, command)) {
    return res.status(500).json({ ok: false, error: 'Failed to queue water command' });
  }
  console.log(`[CONTROL] Queued: ${action}`);
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

app.post('/api/test/command', (req, res) => {
  const cmd = (req.body.cmd || '').toString().trim().toUpperCase();
  const allowed = [
    'UV_ON','UV_OFF','VALVE_ON','VALVE_OFF',
    'PUMP_ON','PUMP_OFF','PELTIER_ON','PELTIER_OFF',
    'MOVE_CW','MOVE_CCW','PING'
  ];
  if (!allowed.includes(cmd)) {
    return res.status(400).json({ ok: false, error: 'Unknown command' });
  }
  const command = { action: cmd, source: 'test_page', ts: Date.now() };
  writeJsonFile(waterCommandFile, command);
  console.log(`[TEST] Command queued: ${cmd}`);
  res.json({ ok: true, cmd });
});


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

    /* ── Mode pill in topbar ── */
    .mode-pill {
      display: flex; align-items: center; gap: 7px;
      padding: 6px 14px; border-radius: 999px;
      border: 1.5px solid rgba(0,179,126,0.4);
      background: rgba(0,179,126,0.07);
      font-size: 12px; font-weight: 600; color: var(--accent2);
      cursor: pointer; transition: all 0.2s; user-select: none;
    }
    .mode-pill:hover { background: rgba(0,179,126,0.14); }
    .mode-pill.manual {
      border-color: rgba(245,158,11,0.45);
      background: rgba(245,158,11,0.08);
      color: var(--warn);
    }
    .mode-pill.manual:hover { background: rgba(245,158,11,0.16); }

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

    /* ── Mode banner ── */
    .mode-banner {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; border-radius: 12px; border: 1.5px solid;
      transition: all 0.3s;
    }
    .mode-banner.auto {
      background: rgba(0,179,126,0.06);
      border-color: rgba(0,179,126,0.35);
    }
    .mode-banner.manual {
      background: rgba(245,158,11,0.07);
      border-color: rgba(245,158,11,0.4);
    }
    .mode-banner-left { display: flex; align-items: center; gap: 14px; }
    .mode-banner-icon { font-size: 28px; line-height: 1; }
    .mode-banner-title { font-size: 15px; font-weight: 700; color: var(--navy); }
    .mode-banner-desc  { font-size: 11px; color: var(--muted); margin-top: 3px; max-width: 480px; }
    .mode-switch-btn {
      padding: 10px 22px; border-radius: 8px; border: 1.5px solid;
      font-size: 12px; font-weight: 700; cursor: pointer;
      letter-spacing: 0.04em; transition: all 0.15s; white-space: nowrap;
    }
    .mode-switch-btn.to-manual {
      border-color: rgba(245,158,11,0.45);
      background: rgba(245,158,11,0.07);
      color: var(--warn);
    }
    .mode-switch-btn.to-manual:hover { background: rgba(245,158,11,0.15); border-color: var(--warn); }
    .mode-switch-btn.to-auto {
      border-color: rgba(0,179,126,0.45);
      background: rgba(0,179,126,0.07);
      color: var(--accent2);
    }
    .mode-switch-btn.to-auto:hover { background: rgba(0,179,126,0.15); border-color: var(--accent2); }

    /* ── Actuator cards ── */
    .actuator-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .actuator-card {
      background: var(--surface2); border: 1px solid var(--border);
      border-radius: 10px; padding: 16px;
      transition: box-shadow 0.15s, opacity 0.25s;
      position: relative;
    }
    .actuator-card:hover { box-shadow: var(--shadow); }

    /* Lock overlay badge when in auto mode */
    .actuator-grid.locked .actuator-card { opacity: 0.62; }
    .actuator-grid.locked .actuator-card::after {
      content: '🔒 AUTO';
      position: absolute; top: 8px; right: 10px;
      font-size: 9px; font-weight: 700; letter-spacing: 0.08em;
      color: var(--accent2);
      background: rgba(0,179,126,0.1);
      border: 1px solid rgba(0,179,126,0.3);
      border-radius: 999px; padding: 2px 8px;
    }

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
    .btn-on:disabled, .btn-off:disabled {
      opacity: 0.35; cursor: not-allowed; pointer-events: none;
    }

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
    <!-- Mode quick-pill -->
    <div class="mode-pill" id="topbarModePill" onclick="showSection('actuators')" title="Click to manage mode">
      <span id="topbarModeIcon">🤖</span>
      <span id="topbarModeLabel">Auto</span>
    </div>
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
      <button class="nav-item" onclick="showSection('schematic')" id="nav-schematic"><span class="ni">🔌</span>Schematic View</button>
    </div>
    <div class="sidebar-footer">
      Group 6 · BSIT-S-3A-T<br>TUP Taguig
    </div>
  </nav>

  <!-- Main -->
  <div class="main-content">

    <!-- ══ LIVE FEED ══ -->
    <div class="page-section active" id="section-livefeed">

      <div class="no-conn-banner" id="noConnBanner">
        ⚠️ ESP32 not connected — sensor readings unavailable. Check serial connection on Pi.
      </div>

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

      <div class="two-col">

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
            <div class="stat-row"><span class="stat-label">Warning threshold</span><span class="stat-value" style="color:var(--muted)">5000</span></div>
            <div class="stat-row"><span class="stat-label">Critical threshold</span><span class="stat-value" style="color:var(--muted)">5500</span></div>
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

      <!-- ── Mode banner ── -->
      <div class="mode-banner auto" id="modeBanner">
        <div class="mode-banner-left">
          <div class="mode-banner-icon" id="modeBannerIcon">🤖</div>
          <div>
            <div class="mode-banner-title" id="modeBannerTitle">Automated Mode</div>
            <div class="mode-banner-desc" id="modeBannerDesc">
              Actuators are fully controlled by ESP32 sensor readings.
              Manual buttons are locked — switch to Manual to override.
            </div>
          </div>
        </div>
        <button class="mode-switch-btn to-manual" id="modeSwitchBtn" onclick="toggleMode()">
          ⚡ Switch to Manual
        </button>
      </div>

      <div class="card">
        <div class="card-header">
          <span>⚙️ ACTUATOR CONTROL PANEL</span>
          <span id="modeBadgeHeader" style="font-size:10px;padding:3px 10px;border-radius:999px;background:rgba(0,179,126,0.1);color:var(--accent2);border:1px solid rgba(0,179,126,0.3);letter-spacing:0.06em;">🤖 AUTOMATED</span>
        </div>
        <div class="card-body">

          <div class="actuator-grid locked" id="actuatorGrid">
            <div class="actuator-card">
              <div class="actuator-icon">☀️</div>
              <div class="actuator-name">UV Sterilizer</div>
              <div class="actuator-state off" id="act-uv-state">● Offline / OFF</div>
              <div class="actuator-btns">
                <button class="btn-on  manual-btn" disabled onclick="sendControl('UV_ON')">ON</button>
                <button class="btn-off manual-btn" disabled onclick="sendControl('UV_OFF')">OFF</button>
              </div>
            </div>
            <div class="actuator-card">
              <div class="actuator-icon">💧</div>
              <div class="actuator-name">Water Pump</div>
              <div class="actuator-state off" id="act-pump-state">● Offline / OFF</div>
              <div class="actuator-btns">
                <button class="btn-on  manual-btn" disabled onclick="sendControl('PUMP_ON')">ON</button>
                <button class="btn-off manual-btn" disabled onclick="sendControl('PUMP_OFF')">OFF</button>
              </div>
            </div>
            <div class="actuator-card">
              <div class="actuator-icon">🚰</div>
              <div class="actuator-name">Solenoid Valve</div>
              <div class="actuator-state off" id="act-valve-state">● Offline / CLOSED</div>
              <div class="actuator-btns">
                <button class="btn-on  manual-btn" disabled onclick="sendControl('VALVE_ON')">OPEN</button>
                <button class="btn-off manual-btn" disabled onclick="sendControl('VALVE_OFF')">CLOSE</button>
              </div>
            </div>
            <div class="actuator-card">
              <div class="actuator-icon">❄️</div>
              <div class="actuator-name">Peltier Cooler</div>
              <div class="actuator-state off" id="act-peltier-state">● Offline / OFF</div>
              <div class="actuator-btns">
                <button class="btn-on  manual-btn" disabled onclick="sendControl('COOL_MAX')">ON MAX</button>
                <button class="btn-off manual-btn" disabled onclick="sendControl('COOL_OFF')">OFF</button>
              </div>
            </div>
            
          </div>

          <!-- Override controls — always available in Manual mode; resets available in both -->
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);margin-bottom:14px;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin-bottom:10px;">Override Release</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button onclick="sendControl('reset_override')" style="padding:8px 16px;border-radius:6px;border:1.5px solid rgba(229,62,90,0.4);background:rgba(229,62,90,0.07);color:var(--danger);font-size:12px;font-weight:700;cursor:pointer;">↺ Release All Overrides</button>
              <button onclick="sendControl('reset_pump')"     style="padding:8px 12px;border-radius:6px;border:1.5px solid var(--border2);background:var(--surface2);color:var(--text2);font-size:11px;font-weight:600;cursor:pointer;">↺ Pump</button>
              <button onclick="sendControl('reset_uv')"       style="padding:8px 12px;border-radius:6px;border:1.5px solid var(--border2);background:var(--surface2);color:var(--text2);font-size:11px;font-weight:600;cursor:pointer;">↺ UV</button>
              <button onclick="sendControl('reset_peltier')"  style="padding:8px 12px;border-radius:6px;border:1.5px solid var(--border2);background:var(--surface2);color:var(--text2);font-size:11px;font-weight:600;cursor:pointer;">↺ Peltier</button>
              <button onclick="sendControl('reset_valve')"    style="padding:8px 12px;border-radius:6px;border:1.5px solid var(--border2);background:var(--surface2);color:var(--text2);font-size:11px;font-weight:600;cursor:pointer;">↺ Valve</button>
            </div>
            <div style="font-size:11px;color:var(--muted);margin-top:8px;">
              ⚠ Release buttons are always available. In Automated mode, sensors immediately resume control after release.
            </div>
          </div>

          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin-bottom:10px;">Command Status</div>
            <div class="stat-row"><span class="stat-label">Active mode</span><span class="stat-value" id="act-mode-display" style="color:var(--accent2)">Automated</span></div>
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

    <!-- ══ SCHEMATIC VIEW ══ -->
    <div class="page-section" id="section-schematic">
      <style>
        .schem2-wrap {
          background: #f8f9fb;
          border: 1px solid var(--border);
          border-radius: 14px;
          overflow: hidden;
          position: relative;
          min-height: 680px;
        }
        .schem2-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 13px 18px; border-bottom: 1px solid var(--border);
          font-size: 12px; font-weight: 700; color: var(--navy);
          letter-spacing: 0.02em; text-transform: uppercase;
          background: var(--surface2);
        }
        #schematic-svg {
          display: block;
          width: 100%;
          height: auto;
        }
        .schem2-legend {
          display: flex; gap: 20px; flex-wrap: wrap; align-items: center;
          padding: 10px 18px; border-top: 1px solid var(--border);
          background: var(--surface2); font-size: 11px; color: var(--muted);
        }
        .schem2-legend span { display: flex; align-items: center; gap: 6px; }
        .schem2-legend .lw { width: 22px; height: 2px; border-radius: 1px; }
        .lw-blue  { background: #3b82f6; }
        .lw-green { background: #22c55e; }
        .lw-red   { background: #ef4444; }
        .lw-gray  { background: #94a3b8; }
        .lw-dash  { background: transparent; border-top: 2px dashed #94a3b8; }
        .schem-svg-wrapper { position: relative; display: block; }
        .act-overlay {
          display: flex; flex-direction: row;
          align-items: center; justify-content: space-between;
          gap: 6px; pointer-events: all;
          padding: 4px 8px;
          background: rgba(15,23,42,0.85);
          border: 1px solid rgba(255,255,255,0.08);
          border-bottom: none;
          border-radius: 6px 6px 0 0;
        }
        .act-overlay-btns { display: flex; gap: 4px; }
        .s-btn {
          padding: 4px 9px; border-radius: 5px; border: 1.5px solid;
          font-size: 10px; font-weight: 700; cursor: pointer;
          font-family: 'Share Tech Mono', monospace; letter-spacing: 0.04em;
          transition: all 0.15s; line-height: 1;
        }
        .s-btn-on  { border-color: rgba(34,197,94,0.5); background: rgba(34,197,94,0.12); color: #22c55e; }
        .s-btn-on:hover  { background: rgba(34,197,94,0.25); }
        .s-btn-off { border-color: rgba(239,68,68,0.45); background: rgba(239,68,68,0.09); color: #ef4444; }
        .s-btn-off:hover { background: rgba(239,68,68,0.2); }
        .s-btn:disabled { opacity: 0.3; cursor: not-allowed; pointer-events: none; }
        .s-state-badge {
          font-size: 9px; font-family: 'Share Tech Mono', monospace;
          padding: 1px 6px; border-radius: 999px; font-weight: 700;
          border: 1px solid rgba(255,255,255,0.1);
        }
      </style>

      <!-- ── Command Log ── -->
      <div style="
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        margin-bottom: 14px;
        overflow: hidden;
      ">
        <div style="
          display:flex; align-items:center; justify-content:space-between;
          padding: 10px 16px;
          background: var(--surface2);
          border-bottom: 1px solid var(--border);
          font-size: 11px; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.08em; color: var(--navy);
        ">
          <span>📟 COMMAND LOG</span>
          <button onclick="document.getElementById('schemCmdLog').innerHTML=''" style="
            padding:3px 10px; border-radius:5px; border:1px solid var(--border2);
            background:none; color:var(--muted); font-size:10px; cursor:pointer;
          ">Clear</button>
        </div>
        <div id="schemCmdLog" style="
          font-family: var(--mono); font-size: 11px; color: var(--muted);
          height: 90px; overflow-y: auto; padding: 8px 14px;
          line-height: 1.9; background: #0f172a;
        ">
          <span style="color:#334155;">— No commands yet —</span>
        </div>
      </div>

      <div class="schem2-wrap">
        <div class="schem2-header">
          <span>🔌 SYSTEM SCHEMATIC — Hardware Overview</span>
          <span id="schemModeBadge2" style="font-size:10px;padding:3px 10px;border-radius:999px;background:rgba(0,179,126,0.1);color:var(--accent2);border:1px solid rgba(0,179,126,0.3);">🤖 AUTOMATED</span>
        </div>

        <div class="schem-svg-wrapper" id="schemSvgWrapper">
        <svg id="schematic-svg" viewBox="0 0 1100 720" xmlns="http://www.w3.org/2000/svg" style="background:#f8f9fb;display:block;width:100%;">
          <defs>
            <marker id="arrowB2" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill="#3b82f6" opacity="0.7"/>
            </marker>
            <marker id="arrowG2" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill="#22c55e" opacity="0.7"/>
            </marker>
            <marker id="arrowR2" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill="#ef4444" opacity="0.6"/>
            </marker>
            <marker id="arrowGray" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill="#94a3b8" opacity="0.7"/>
            </marker>
          </defs>

          <!-- ═══════════════════════════════════════════ -->
          <!-- WIRES — drawn first so components sit on top -->
          <!-- ═══════════════════════════════════════════ -->

          <!-- Power rails (red dashed at top) -->
          <line x1="410" y1="32" x2="690" y2="32" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="6,3" opacity="0.5"/>
          <text x="545" y="26" text-anchor="middle" font-size="9" fill="#ef4444" opacity="0.7" font-family="monospace">12V POWER RAIL</text>

          <!-- GND rail (gray dashed at bottom) -->
          <line x1="410" y1="690" x2="690" y2="690" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="6,3" opacity="0.4"/>
          <text x="545" y="705" text-anchor="middle" font-size="9" fill="#94a3b8" opacity="0.6" font-family="monospace">GND</text>

          <!-- === SENSOR TO ESP32 WIRES (blue signal lines) === -->
          <!-- MQ-137 → ESP32 GPIO34 -->
          <path d="M 178 108 L 370 108 L 370 248" stroke="#3b82f6" stroke-width="1.5" fill="none" stroke-dasharray="4,3" opacity="0.6" marker-end="url(#arrowB2)"/>
          <text x="270" y="103" text-anchor="middle" font-size="8.5" fill="#3b82f6" opacity="0.8" font-family="monospace">GPIO34</text>

          <!-- DS18B20 → ESP32 GPIO15 -->
          <path d="M 178 198 L 350 198 L 350 252" stroke="#3b82f6" stroke-width="1.5" fill="none" stroke-dasharray="4,3" opacity="0.6" marker-end="url(#arrowB2)"/>
          <text x="258" y="193" text-anchor="middle" font-size="8.5" fill="#3b82f6" opacity="0.8" font-family="monospace">GPIO15</text>

          <!-- Turbidity → ESP32 GPIO35 -->
          <path d="M 178 298 L 355 298 L 355 255" stroke="#3b82f6" stroke-width="1.5" fill="none" stroke-dasharray="4,3" opacity="0.6" marker-end="url(#arrowB2)"/>
          <text x="258" y="293" text-anchor="middle" font-size="8.5" fill="#3b82f6" opacity="0.8" font-family="monospace">GPIO35</text>

          <!-- Flow Sensor → ESP32 GPIO25 -->
          <path d="M 178 398 L 340 398 L 340 262" stroke="#3b82f6" stroke-width="1.5" fill="none" stroke-dasharray="4,3" opacity="0.6" marker-end="url(#arrowB2)"/>
          <text x="248" y="393" text-anchor="middle" font-size="8.5" fill="#3b82f6" opacity="0.8" font-family="monospace">GPIO25</text>

          <!-- Pi Camera → RPi CSI ribbon (yellow dashed) -->
          <path d="M 178 548 L 410 548 L 410 510" stroke="#f59e0b" stroke-width="1.5" fill="none" stroke-dasharray="4,2" opacity="0.6" marker-end="url(#arrowR2)"/>
          <text x="290" y="543" text-anchor="middle" font-size="8.5" fill="#f59e0b" opacity="0.8" font-family="monospace">CSI</text>

          <!-- === ESP32 TO RELAY MODULE (green control lines) === -->
          <!-- ESP32 → Relay CH1 (UV) GPIO4 -->
          <path d="M 612 270 L 650 270 L 650 205" stroke="#22c55e" stroke-width="1.5" fill="none" stroke-dasharray="4,2" opacity="0.7" marker-end="url(#arrowG2)"/>
          <text x="640" y="243" text-anchor="middle" font-size="8" fill="#22c55e" opacity="0.8" font-family="monospace">GPIO4</text>

          <!-- ESP32 → Relay CH2 (Pump) GPIO26 -->
          <path d="M 612 285 L 655 285 L 655 210" stroke="#22c55e" stroke-width="1.5" fill="none" stroke-dasharray="4,2" opacity="0.7" marker-end="url(#arrowG2)"/>

          <!-- ESP32 → Relay CH3 (Valve) GPIO14 -->
          <path d="M 612 300 L 660 300 L 660 215" stroke="#22c55e" stroke-width="1.5" fill="none" stroke-dasharray="4,2" opacity="0.7" marker-end="url(#arrowG2)"/>

          <!-- ESP32 → Relay CH4 (Peltier) GPIO16 -->
          <path d="M 612 315 L 665 315 L 665 220" stroke="#22c55e" stroke-width="1.5" fill="none" stroke-dasharray="4,2" opacity="0.7" marker-end="url(#arrowG2)"/>

          <!-- === RELAY TO ACTUATORS (green power wires) === -->
          <!-- Relay → UV Sterilizer -->
          <path d="M 780 175 L 850 175 L 850 108 L 920 108" stroke="#22c55e" stroke-width="2" fill="none" opacity="0.7" marker-end="url(#arrowG2)"/>

          <!-- Relay → Water Pump -->
          <path d="M 780 190 L 855 190 L 855 215 L 920 215" stroke="#22c55e" stroke-width="2" fill="none" opacity="0.7" marker-end="url(#arrowG2)"/>

          <!-- Relay → Solenoid Valve -->
          <path d="M 780 205 L 860 205 L 860 330 L 920 330" stroke="#22c55e" stroke-width="2" fill="none" opacity="0.7" marker-end="url(#arrowG2)"/>

          <!-- Relay → Peltier -->
          <path d="M 780 220 L 865 220 L 865 445 L 920 445" stroke="#22c55e" stroke-width="2" fill="none" opacity="0.7" marker-end="url(#arrowG2)"/>

          <!-- === ESP32 to A4988 Stepper Driver === -->
          <path d="M 540 325 L 540 490 L 570 490" stroke="#f59e0b" stroke-width="1.5" fill="none" stroke-dasharray="4,2" opacity="0.6" marker-end="url(#arrowR2)"/>
          <text x="530" y="415" text-anchor="middle" font-size="8" fill="#f59e0b" opacity="0.8" font-family="monospace" transform="rotate(-90,530,415)">STEP/DIR</text>

          <!-- A4988 → Stepper Motor -->
          <path d="M 690 530 L 730 530 L 730 560 L 920 560" stroke="#f59e0b" stroke-width="2" fill="none" opacity="0.7" marker-end="url(#arrowR2)"/>
          <text x="820" y="548" text-anchor="middle" font-size="8.5" fill="#f59e0b" opacity="0.8" font-family="monospace">4-wire</text>

          <!-- === USB Serial ESP32 ↔ RPi === -->
          <path d="M 540 325 L 540 380" stroke="#3b82f6" stroke-width="2.5" fill="none" opacity="0.8" marker-end="url(#arrowB2)"/>
          <path d="M 530 380 L 530 325" stroke="#94a3b8" stroke-width="1" fill="none" opacity="0.4" marker-end="url(#arrowGray)"/>
          <rect x="505" y="340" width="50" height="18" rx="3" fill="#1e293b" opacity="0.85"/>
          <text x="530" y="352" text-anchor="middle" font-size="8" fill="#94a3b8" font-family="monospace">USB-C</text>

          <!-- Power from 12V rail to Relay module -->
          <line x1="690" y1="32" x2="730" y2="32" stroke="#ef4444" stroke-width="1.5" opacity="0.5"/>
          <line x1="730" y1="32" x2="730" y2="155" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.5" marker-end="url(#arrowR2)"/>

          <!-- Power from 12V rail to A4988 -->
          <line x1="630" y1="32" x2="630" y2="480" stroke="#ef4444" stroke-width="1" stroke-dasharray="3,4" opacity="0.3" marker-end="url(#arrowR2)"/>

          <!-- ═══════════════════════════════════════════ -->
          <!-- COMPONENTS -->
          <!-- ═══════════════════════════════════════════ -->

          <!-- ====== LEFT SIDE: SENSORS ====== -->

          <!-- Column header -->
          <text x="95" y="38" text-anchor="middle" font-size="10" font-weight="700" fill="#64748b" font-family="monospace" letter-spacing="1">SENSORS</text>
          <line x1="20" y1="44" x2="175" y2="44" stroke="#cbd5e1" stroke-width="0.75"/>

          <!-- MQ-137 Ammonia Sensor -->
          <g id="comp-mq137">
            <rect x="20" y="70" width="158" height="76" rx="6" fill="#0f172a" stroke="#3b82f6" stroke-width="1.5"/>
            <rect x="20" y="70" width="158" height="18" rx="6" fill="#1e40af"/>
            <rect x="20" y="82" width="158" height="6" rx="0" fill="#1e40af"/>
            <text x="99" y="83" text-anchor="middle" font-size="9.5" font-weight="700" fill="#bfdbfe" font-family="monospace">MQ-137</text>
            <!-- IC circles -->
            <circle cx="55" cy="116" r="14" fill="#1e3a5f" stroke="#3b82f6" stroke-width="1.5"/>
            <circle cx="55" cy="116" r="7" fill="#2563eb"/>
            <circle cx="55" cy="116" r="3" fill="#93c5fd"/>
            <!-- Pins -->
            <line x1="20" y1="100" x2="10" y2="100" stroke="#fbbf24" stroke-width="2.5"/>
            <line x1="20" y1="115" x2="10" y2="115" stroke="#ef4444" stroke-width="2.5"/>
            <line x1="20" y1="130" x2="10" y2="130" stroke="#1d4ed8" stroke-width="2.5"/>
            <text x="105" y="108" font-size="9" fill="#94a3b8" font-family="monospace">Ammonia</text>
            <text x="105" y="121" font-size="9" fill="#94a3b8" font-family="monospace">MQ-137</text>
            <text x="99" y="140" text-anchor="middle" font-size="12" font-weight="700" fill="#3b82f6" font-family="monospace" id="schem-nh3">-- raw</text>
          </g>

          <!-- DS18B20 Temp Sensor -->
          <g id="comp-ds18b20">
            <rect x="20" y="168" width="158" height="66" rx="6" fill="#0f172a" stroke="#22c55e" stroke-width="1.5"/>
            <rect x="20" y="168" width="158" height="16" rx="6" fill="#14532d"/>
            <rect x="20" y="178" width="158" height="6" rx="0" fill="#14532d"/>
            <text x="99" y="181" text-anchor="middle" font-size="9.5" font-weight="700" fill="#bbf7d0" font-family="monospace">DS18B20</text>
            <!-- Probe shape -->
            <rect x="38" y="192" width="10" height="28" rx="5" fill="#1a3260"/>
            <circle cx="43" cy="222" r="6" fill="#ef4444"/>
            <!-- Pins -->
            <line x1="20" y1="200" x2="10" y2="200" stroke="#fbbf24" stroke-width="2.5"/>
            <line x1="20" y1="213" x2="10" y2="213" stroke="#ef4444" stroke-width="2.5"/>
            <text x="105" y="203" font-size="9" fill="#94a3b8" font-family="monospace">Temperature</text>
            <text x="105" y="216" font-size="9" fill="#94a3b8" font-family="monospace">1-Wire</text>
            <text x="99" y="228" text-anchor="middle" font-size="12" font-weight="700" fill="#22c55e" font-family="monospace" id="schem-temp">-- °C</text>
          </g>

          <!-- Turbidity Sensor -->
          <g id="comp-turbidity">
            <rect x="20" y="262" width="158" height="72" rx="6" fill="#0f172a" stroke="#f59e0b" stroke-width="1.5"/>
            <rect x="20" y="262" width="158" height="16" rx="6" fill="#78350f"/>
            <rect x="20" y="272" width="158" height="6" rx="0" fill="#78350f"/>
            <text x="99" y="275" text-anchor="middle" font-size="9.5" font-weight="700" fill="#fde68a" font-family="monospace">TURBIDITY</text>
            <!-- Sensor body -->
            <rect x="30" y="286" width="36" height="34" rx="4" fill="#1c2a3d"/>
            <circle cx="40" cy="303" r="5" fill="#fbbf24"/>
            <circle cx="56" cy="303" r="5" fill="#3b82f6"/>
            <!-- Pins -->
            <line x1="20" y1="292" x2="10" y2="292" stroke="#fbbf24" stroke-width="2.5"/>
            <line x1="20" y1="305" x2="10" y2="305" stroke="#ef4444" stroke-width="2.5"/>
            <line x1="20" y1="318" x2="10" y2="318" stroke="#1d4ed8" stroke-width="2.5"/>
            <text x="105" y="297" font-size="9" fill="#94a3b8" font-family="monospace">NTU sensor</text>
            <text x="105" y="310" font-size="9" fill="#94a3b8" font-family="monospace">Analog out</text>
            <text x="99" y="326" text-anchor="middle" font-size="12" font-weight="700" fill="#f59e0b" font-family="monospace" id="schem-turb">-- NTU</text>
          </g>

          <!-- YF-S201 Flow Sensor -->
          <g id="comp-flow">
            <rect x="20" y="362" width="158" height="72" rx="6" fill="#0f172a" stroke="#06b6d4" stroke-width="1.5"/>
            <rect x="20" y="362" width="158" height="16" rx="6" fill="#164e63"/>
            <rect x="20" y="372" width="158" height="6" rx="0" fill="#164e63"/>
            <text x="99" y="375" text-anchor="middle" font-size="9.5" font-weight="700" fill="#a5f3fc" font-family="monospace">YF-S201</text>
            <!-- Flow body -->
            <rect x="26" y="386" width="44" height="36" rx="5" fill="#0e7490"/>
            <rect x="14" y="396" width="14" height="14" rx="2" fill="#0891b2"/>
            <rect x="66" y="396" width="14" height="14" rx="2" fill="#0891b2"/>
            <circle cx="48" cy="403" r="7" fill="#22d3ee"/>
            <!-- Pins -->
            <line x1="20" y1="392" x2="10" y2="392" stroke="#fbbf24" stroke-width="2.5"/>
            <line x1="20" y1="405" x2="10" y2="405" stroke="#ef4444" stroke-width="2.5"/>
            <line x1="20" y1="418" x2="10" y2="418" stroke="#22c55e" stroke-width="2.5"/>
            <text x="105" y="395" font-size="9" fill="#94a3b8" font-family="monospace">Flow rate</text>
            <text x="105" y="408" font-size="9" fill="#94a3b8" font-family="monospace">Hall effect</text>
            <text x="99" y="426" text-anchor="middle" font-size="12" font-weight="700" fill="#06b6d4" font-family="monospace" id="schem-flow">-- L/min</text>
          </g>

          <!-- Pi Camera -->
          <g id="comp-picam">
            <rect x="20" y="510" width="158" height="66" rx="6" fill="#0f172a" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="5,3"/>
            <rect x="20" y="510" width="158" height="16" rx="6" fill="#451a03"/>
            <rect x="20" y="520" width="158" height="6" rx="0" fill="#451a03"/>
            <text x="99" y="523" text-anchor="middle" font-size="9.5" font-weight="700" fill="#fde68a" font-family="monospace">PI CAMERA</text>
            <!-- Camera lens -->
            <circle cx="50" cy="548" r="12" fill="#1c1917"/>
            <circle cx="50" cy="548" r="8" fill="#1e3a5f"/>
            <circle cx="50" cy="548" r="4" fill="#334155"/>
            <circle cx="50" cy="548" r="1.5" fill="#e2e8f0"/>
            <text x="105" y="543" font-size="9" fill="#94a3b8" font-family="monospace">AI Detection</text>
            <text x="105" y="556" font-size="9" fill="#94a3b8" font-family="monospace">Roboflow/YOLO</text>
            <text x="99" y="568" text-anchor="middle" font-size="11" font-weight="700" fill="#f59e0b" font-family="monospace" id="schemCamBadge2">◌ IDLE</text>
          </g>

          <!-- ====== CENTER: CONTROL UNITS ====== -->

          <!-- Column header -->
          <text x="510" y="38" text-anchor="middle" font-size="10" font-weight="700" fill="#64748b" font-family="monospace" letter-spacing="1">CONTROL UNITS</text>
          <line x1="310" y1="44" x2="720" y2="44" stroke="#cbd5e1" stroke-width="0.75"/>

          <!-- ESP32 DevKit board -->
          <g id="comp-esp32">
            <!-- PCB body -->
            <rect x="390" y="190" width="220" height="150" rx="8" fill="#1a3a1a" stroke="#22c55e" stroke-width="2"/>
            <!-- Board edge detail -->
            <rect x="390" y="190" width="220" height="10" rx="4" fill="#143214"/>
            <!-- Chip -->
            <rect x="450" y="220" width="80" height="60" rx="4" fill="#111" stroke="#334155" stroke-width="1"/>
            <rect x="462" y="232" width="56" height="36" rx="2" fill="#1e293b"/>
            <text x="490" y="250" text-anchor="middle" font-size="8.5" font-weight="700" fill="#22c55e" font-family="monospace">ESP32</text>
            <text x="490" y="262" text-anchor="middle" font-size="7.5" fill="#64748b" font-family="monospace">240MHz</text>
            <!-- GPIO pin headers (left) -->
            <rect x="393" y="200" width="8" height="132" rx="2" fill="#374151"/>
            <line x1="397" y1="210" x2="397" y2="324" stroke="#fbbf24" stroke-width="0.5" stroke-dasharray="3,4" opacity="0.5"/>
            <!-- GPIO pin headers (right) -->
            <rect x="599" y="200" width="8" height="132" rx="2" fill="#374151"/>
            <!-- Antenna -->
            <rect x="580" y="193" width="28" height="8" rx="2" fill="#22c55e" opacity="0.7"/>
            <text x="594" y="200" text-anchor="middle" font-size="7" fill="#86efac" font-family="monospace">ANT</text>
            <!-- USB port indicator -->
            <rect x="490" y="335" width="20" height="8" rx="2" fill="#94a3b8"/>
            <text x="500" y="347" text-anchor="middle" font-size="7.5" fill="#64748b" font-family="monospace">USB</text>
            <!-- Status indicator -->
            <circle cx="410" cy="205" r="4" fill="#22c55e" id="schem-esp32-dot" opacity="0.4"/>
            <text x="424" y="209" font-size="8" fill="#64748b" font-family="monospace" id="schemEsp32Status2">Offline</text>
            <!-- Board label -->
            <text x="500" y="360" text-anchor="middle" font-size="9" font-weight="700" fill="#22c55e" font-family="monospace">ESP32 DevKit</text>
          </g>

          <!-- 4-Channel Relay Module -->
          <g id="comp-relay">
            <rect x="650" y="155" width="130" height="120" rx="6" fill="#1c2a3d" stroke="#3b82f6" stroke-width="2"/>
            <rect x="650" y="155" width="130" height="14" rx="4" fill="#1e3a5f"/>
            <text x="715" y="166" text-anchor="middle" font-size="9" font-weight="700" fill="#93c5fd" font-family="monospace">RELAY 4CH</text>
            <!-- 4 relay channels side by side -->
            <rect x="657" y="175" width="26" height="42" rx="3" fill="#0f172a" stroke="#3b82f6" stroke-width="1" id="relay-ch1-schem"/>
            <rect x="688" y="175" width="26" height="42" rx="3" fill="#0f172a" stroke="#3b82f6" stroke-width="1" id="relay-ch2-schem"/>
            <rect x="719" y="175" width="26" height="42" rx="3" fill="#0f172a" stroke="#3b82f6" stroke-width="1" id="relay-ch3-schem"/>
            <rect x="750" y="175" width="26" height="42" rx="3" fill="#0f172a" stroke="#3b82f6" stroke-width="1" id="relay-ch4-schem"/>
            <!-- Relay coil symbols -->
            <rect x="661" y="182" width="18" height="12" rx="1" fill="#1e3a5f"/>
            <rect x="692" y="182" width="18" height="12" rx="1" fill="#1e3a5f"/>
            <rect x="723" y="182" width="18" height="12" rx="1" fill="#1e3a5f"/>
            <rect x="754" y="182" width="18" height="12" rx="1" fill="#1e3a5f"/>
            <!-- LED indicators -->
            <circle cx="670" cy="205" r="3.5" fill="#374151" id="relay-led1"/>
            <circle cx="701" cy="205" r="3.5" fill="#374151" id="relay-led2"/>
            <circle cx="732" cy="205" r="3.5" fill="#374151" id="relay-led3"/>
            <circle cx="763" cy="205" r="3.5" fill="#374151" id="relay-led4"/>
            <!-- Channel labels -->
            <text x="670" y="215" text-anchor="middle" font-size="7" fill="#64748b" font-family="monospace">UV</text>
            <text x="701" y="215" text-anchor="middle" font-size="7" fill="#64748b" font-family="monospace">PMP</text>
            <text x="732" y="215" text-anchor="middle" font-size="7" fill="#64748b" font-family="monospace">VLV</text>
            <text x="763" y="215" text-anchor="middle" font-size="7" fill="#64748b" font-family="monospace">PLT</text>
            <!-- Screw terminals -->
            <rect x="657" y="222" width="26" height="10" rx="1" fill="#374151"/>
            <rect x="688" y="222" width="26" height="10" rx="1" fill="#374151"/>
            <rect x="719" y="222" width="26" height="10" rx="1" fill="#374151"/>
            <rect x="750" y="222" width="26" height="10" rx="1" fill="#374151"/>
            <!-- Screw dots -->
            <circle cx="667" cy="227" r="2" fill="#1c2a3d"/><circle cx="676" cy="227" r="2" fill="#1c2a3d"/>
            <circle cx="698" cy="227" r="2" fill="#1c2a3d"/><circle cx="707" cy="227" r="2" fill="#1c2a3d"/>
            <circle cx="729" cy="227" r="2" fill="#1c2a3d"/><circle cx="738" cy="227" r="2" fill="#1c2a3d"/>
            <circle cx="760" cy="227" r="2" fill="#1c2a3d"/><circle cx="769" cy="227" r="2" fill="#1c2a3d"/>
            <!-- GND/VCC pins -->
            <text x="715" y="265" text-anchor="middle" font-size="8" fill="#64748b" font-family="monospace">5V · GND · IN1-4</text>
          </g>

          <!-- Raspberry Pi 5 -->
          <g id="comp-raspi">
            <rect x="390" y="380" width="220" height="130" rx="8" fill="#3d0b0b" stroke="#f59e0b" stroke-width="2"/>
            <rect x="390" y="380" width="220" height="10" rx="4" fill="#2d0808"/>
            <!-- CPU chip -->
            <rect x="440" y="400" width="70" height="50" rx="3" fill="#111" stroke="#334155" stroke-width="1"/>
            <rect x="450" y="410" width="50" height="30" rx="2" fill="#1e293b"/>
            <text x="475" y="424" text-anchor="middle" font-size="8" font-weight="700" fill="#f59e0b" font-family="monospace">BCM2712</text>
            <text x="475" y="435" text-anchor="middle" font-size="7.5" fill="#64748b" font-family="monospace">RPi 5 4GB</text>
            <!-- GPIO header -->
            <rect x="393" y="388" width="8" height="110" rx="2" fill="#374151"/>
            <!-- USB ports -->
            <rect x="595" y="396" width="18" height="22" rx="2" fill="#334155"/>
            <rect x="595" y="424" width="18" height="22" rx="2" fill="#334155"/>
            <!-- HDMI -->
            <rect x="565" y="497" width="22" height="12" rx="2" fill="#1c2a3d"/>
            <!-- USB-C power -->
            <rect x="390" y="480" width="14" height="12" rx="2" fill="#94a3b8"/>
            <!-- Status LEDs -->
            <circle cx="410" cy="393" r="3.5" fill="#22c55e" opacity="0.7"/>
            <circle cx="422" cy="393" r="3.5" fill="#ef4444" opacity="0.5"/>
            <!-- Stack labels -->
            <text x="500" y="472" text-anchor="middle" font-size="8" fill="#f59e0b" font-family="monospace">Python · Node.js · MongoDB</text>
            <text x="500" y="500" text-anchor="middle" font-size="9" font-weight="700" fill="#f59e0b" font-family="monospace">Raspberry Pi 5</text>
          </g>

          <!-- A4988 Stepper Driver -->
          <g id="comp-a4988">
            <rect x="570" y="460" width="120" height="70" rx="5" fill="#1c1917" stroke="#f59e0b" stroke-width="1.5"/>
            <rect x="570" y="460" width="120" height="12" rx="4" fill="#292524"/>
            <text x="630" y="470" text-anchor="middle" font-size="8.5" font-weight="700" fill="#fde68a" font-family="monospace">A4988</text>
            <!-- IC body -->
            <rect x="590" y="478" width="60" height="30" rx="2" fill="#111" stroke="#44403c" stroke-width="1"/>
            <text x="620" y="497" text-anchor="middle" font-size="7.5" fill="#a8a29e" font-family="monospace">STEP DRIVER</text>
            <!-- Pins -->
            <rect x="574" y="474" width="6" height="50" fill="#374151" rx="1"/>
            <rect x="680" y="474" width="6" height="50" fill="#374151" rx="1"/>
            <text x="630" y="522" text-anchor="middle" font-size="7.5" fill="#64748b" font-family="monospace">1/8 microstepping</text>
          </g>

          <!-- ====== RIGHT SIDE: ACTUATORS ====== -->

          <!-- Column header -->
          <text x="1005" y="38" text-anchor="middle" font-size="10" font-weight="700" fill="#64748b" font-family="monospace" letter-spacing="1">ACTUATORS</text>
          <line x1="910" y1="44" x2="1090" y2="44" stroke="#cbd5e1" stroke-width="0.75"/>

          <!-- UV Sterilizer -->
          <g id="schem2-act-uv">
            <rect x="920" y="72" width="165" height="72" rx="6" fill="#0f0c1a" stroke="#a78bfa" stroke-width="1.5" id="act-border-uv"/>
            <rect x="920" y="72" width="165" height="14" rx="4" fill="#3b0764"/>
            <text x="1002" y="83" text-anchor="middle" font-size="9.5" font-weight="700" fill="#ddd6fe" font-family="monospace">UV STERILIZER</text>
            <!-- UV tube shape -->
            <rect x="932" y="93" width="90" height="14" rx="7" fill="#e2e8f0"/>
            <rect x="934" y="95" width="86" height="10" rx="5" fill="#c4b5fd" opacity="0.7"/>
            <rect x="920" y="96" width="14" height="8" rx="2" fill="#94a3b8"/>
            <rect x="1018" y="96" width="14" height="8" rx="2" fill="#94a3b8"/>
            <text x="1002" y="122" text-anchor="middle" font-size="8.5" fill="#a78bfa" font-family="monospace" id="schem2-uv-state">● OFF</text>
            <text x="1042" y="97" font-size="8" fill="#64748b" font-family="monospace">220V AC</text>
          </g>

          <!-- Submersible Pump -->
          <g id="schem2-act-pump">
            <rect x="920" y="182" width="165" height="72" rx="6" fill="#0a1628" stroke="#3b82f6" stroke-width="1.5" id="act-border-pump"/>
            <rect x="920" y="182" width="165" height="14" rx="4" fill="#1e3a5f"/>
            <text x="1002" y="193" text-anchor="middle" font-size="9.5" font-weight="700" fill="#bfdbfe" font-family="monospace">WATER PUMP</text>
            <!-- Pump body -->
            <circle cx="955" cy="218" r="14" fill="#1e40af"/>
            <circle cx="955" cy="218" r="8" fill="#2563eb"/>
            <circle cx="955" cy="218" r="3" fill="#93c5fd"/>
            <!-- Outlet -->
            <rect x="969" y="214" width="20" height="8" rx="2" fill="#1d4ed8"/>
            <text x="1020" y="212" font-size="8" fill="#64748b" font-family="monospace">12V DC</text>
            <text x="1002" y="238" text-anchor="middle" font-size="8.5" fill="#3b82f6" font-family="monospace" id="schem2-pump-state">● OFF</text>
          </g>

          <!-- Solenoid Valve -->
          <g id="schem2-act-valve">
            <rect x="920" y="298" width="165" height="72" rx="6" fill="#111827" stroke="#94a3b8" stroke-width="1.5" id="act-border-valve"/>
            <rect x="920" y="298" width="165" height="14" rx="4" fill="#1f2937"/>
            <text x="1002" y="309" text-anchor="middle" font-size="9.5" font-weight="700" fill="#e5e7eb" font-family="monospace">SOLENOID VALVE</text>
            <!-- Valve body -->
            <rect x="930" y="318" width="48" height="28" rx="3" fill="#374151"/>
            <rect x="920" y="325" width="14" height="14" rx="2" fill="#4b5563"/>
            <rect x="974" y="325" width="14" height="14" rx="2" fill="#4b5563"/>
            <circle cx="954" cy="316" r="6" fill="#f59e0b"/>
            <rect x="952" y="316" width="4" height="8" fill="#d97706"/>
            <text x="1020" y="328" font-size="8" fill="#64748b" font-family="monospace">12V DC</text>
            <text x="1002" y="354" text-anchor="middle" font-size="8.5" fill="#94a3b8" font-family="monospace" id="schem2-valve-state">● CLOSED</text>
          </g>

          <!-- Peltier Cooler -->
          <g id="schem2-act-peltier">
            <rect x="920" y="412" width="165" height="72" rx="6" fill="#0a1f2a" stroke="#06b6d4" stroke-width="1.5" id="act-border-peltier"/>
            <rect x="920" y="412" width="165" height="14" rx="4" fill="#0e4a5e"/>
            <text x="1002" y="423" text-anchor="middle" font-size="9.5" font-weight="700" fill="#a5f3fc" font-family="monospace">PELTIER TEC</text>
            <!-- TEC module -->
            <rect x="930" y="430" width="52" height="36" rx="2" fill="#0e7490"/>
            <rect x="930" y="430" width="52" height="6" rx="1" fill="#e2e8f0"/>
            <rect x="930" y="460" width="52" height="6" rx="1" fill="#1e3a5f"/>
            <rect x="934" y="436" width="8" height="24" rx="1" fill="#ef4444"/>
            <rect x="946" y="436" width="8" height="24" rx="1" fill="#3b82f6"/>
            <rect x="958" y="436" width="8" height="24" rx="1" fill="#ef4444"/>
            <text x="1020" y="444" font-size="8" fill="#64748b" font-family="monospace">12V DC</text>
            <text x="1002" y="468" text-anchor="middle" font-size="8.5" fill="#06b6d4" font-family="monospace" id="schem2-peltier-state">● OFF</text>
          </g>

          <!-- Stepper Motor -->
          <g id="schem2-act-motor">
            <rect x="920" y="527" width="165" height="72" rx="6" fill="#1c1a12" stroke="#f59e0b" stroke-width="1.5"/>
            <rect x="920" y="527" width="165" height="14" rx="4" fill="#2d2006"/>
            <text x="1002" y="538" text-anchor="middle" font-size="9.5" font-weight="700" fill="#fde68a" font-family="monospace">STEPPER MOTOR</text>
            <!-- Motor body -->
            <rect x="930" y="547" width="48" height="42" rx="4" fill="#1c2a3d"/>
            <circle cx="954" cy="568" r="12" fill="#374151"/>
            <circle cx="954" cy="568" r="5" fill="#94a3b8"/>
            <rect x="954" y="535" width="4" height="14" rx="2" fill="#94a3b8"/>
            <text x="1020" y="561" font-size="8" fill="#64748b" font-family="monospace">12V 2A</text>
            <text x="1002" y="578" text-anchor="middle" font-size="8.5" fill="#f59e0b" font-family="monospace" id="schem2-motor-state">● IDLE</text>
            <!-- 4 wires -->
            <line x1="920" y1="553" x2="908" y2="553" stroke="#f59e0b" stroke-width="2"/>
            <line x1="920" y1="560" x2="908" y2="560" stroke="#fbbf24" stroke-width="2"/>
            <line x1="920" y1="567" x2="908" y2="567" stroke="#ef4444" stroke-width="2"/>
            <line x1="920" y1="574" x2="908" y2="574" stroke="#3b82f6" stroke-width="2"/>
          </g>

          <!-- ====== JUNCTION DOTS (wire solder points) ====== -->
          <circle cx="370" cy="108" r="3.5" fill="#3b82f6" opacity="0.8"/>
          <circle cx="350" cy="198" r="3.5" fill="#3b82f6" opacity="0.8"/>
          <circle cx="355" cy="298" r="3.5" fill="#f59e0b" opacity="0.8"/>
          <circle cx="340" cy="398" r="3.5" fill="#06b6d4" opacity="0.8"/>
          <circle cx="540" cy="325" r="4" fill="#3b82f6" opacity="0.9"/>
          <circle cx="650" cy="270" r="3" fill="#22c55e" opacity="0.8"/>
          <circle cx="730" cy="32" r="3.5" fill="#ef4444" opacity="0.7"/>
          <circle cx="850" cy="108" r="3.5" fill="#22c55e" opacity="0.8"/>
          <circle cx="855" cy="215" r="3.5" fill="#22c55e" opacity="0.8"/>
          <circle cx="860" cy="330" r="3.5" fill="#22c55e" opacity="0.8"/>
          <circle cx="865" cy="445" r="3.5" fill="#22c55e" opacity="0.8"/>
          <circle cx="730" cy="530" r="3.5" fill="#f59e0b" opacity="0.8"/>

          <!-- ====== MODE LABEL ====== -->
          <rect x="420" y="620" width="260" height="28" rx="5" fill="#0f172a" stroke="#334155" stroke-width="1"/>
          <text x="550" y="638" text-anchor="middle" font-size="10" fill="#64748b" font-family="monospace" id="schemModeNote2">🤖 Automated — sensors control actuators</text>

        </svg>

        </div><!-- /schem-svg-wrapper -->

        <!-- ── Actuator control bars — sit OUTSIDE the SVG, above each actuator row ── -->
        <div id="schem-act-controls" style="
  position:absolute; top:0; right:0;
  width:15.5%; height:100%;
  pointer-events:none;
  box-sizing:border-box;
">
          <!-- UV: y=72/720 = 10% -->
  <div style="position:absolute; top:calc(10% + 10px); right:40px; width:90%; pointer-events:all;">
    <div class="act-overlay">
      <div class="act-overlay-btns">
        <button class="s-btn s-btn-on  schem-manual-btn" id="sob-uv-on"  onclick="sendControl('UV_ON')"  disabled>ON</button>
        <button class="s-btn s-btn-off schem-manual-btn" id="sob-uv-off" onclick="sendControl('UV_OFF')" disabled>OFF</button>
      </div>
      <span class="s-state-badge" id="sob-uv-badge" style="color:#a78bfa;background:rgba(167,139,250,0.1);border-color:rgba(167,139,250,0.25);">● OFF</span>
    </div>
  </div>

  <!-- PUMP: y=182/720 = 25.3% -->
  <div style="position:absolute; top:calc(25.3% - 3px); right:40px; width:90%; pointer-events:all;">
    <div class="act-overlay">
      <div class="act-overlay-btns">
        <button class="s-btn s-btn-on  schem-manual-btn" id="sob-pump-on"  onclick="sendControl('PUMP_ON')"  disabled>ON</button>
        <button class="s-btn s-btn-off schem-manual-btn" id="sob-pump-off" onclick="sendControl('PUMP_OFF')" disabled>OFF</button>
      </div>
      <span class="s-state-badge" id="sob-pump-badge" style="color:#3b82f6;background:rgba(59,130,246,0.1);border-color:rgba(59,130,246,0.25);">● OFF</span>
    </div>
  </div>

  <!-- VALVE: y=298/720 = 41.4% -->
  <div style="position:absolute; top:calc(41.4% - 15px); right:40px; width:90%; pointer-events:all;">
    <div class="act-overlay">
      <div class="act-overlay-btns">
        <button class="s-btn s-btn-on  schem-manual-btn" id="sob-valve-on"  onclick="sendControl('VALVE_ON')"  disabled>OPEN</button>
        <button class="s-btn s-btn-off schem-manual-btn" id="sob-valve-off" onclick="sendControl('VALVE_OFF')" disabled>CLOSE</button>
      </div>
      <span class="s-state-badge" id="sob-valve-badge" style="color:#94a3b8;background:rgba(148,163,184,0.1);border-color:rgba(148,163,184,0.25);">● CLOSED</span>
    </div>
  </div>

  <!-- PELTIER: y=412/720 = 57.2% -->
  <div style="position:absolute; top:calc(57.2% - 29px); right:40px; width:90%; pointer-events:all;">
    <div class="act-overlay">
      <div class="act-overlay-btns">
        <button class="s-btn s-btn-on  schem-manual-btn" id="sob-pelt-on"  onclick="sendControl('COOL_MAX')" disabled>ON</button>
        <button class="s-btn s-btn-off schem-manual-btn" id="sob-pelt-off" onclick="sendControl('COOL_OFF')" disabled>OFF</button>
      </div>
      <span class="s-state-badge" id="sob-pelt-badge" style="color:#06b6d4;background:rgba(6,182,212,0.1);border-color:rgba(6,182,212,0.25);">● OFF</span>
    </div>
  </div>

  <!-- MOTOR: y=527/720 = 73.2% -->
  <div style="position:absolute; top:calc(73.2% - 42px); right:40px; width:90%; pointer-events:all;">
    <div class="act-overlay">
      <div class="act-overlay-btns">
        <button class="s-btn s-btn-on" id="sob-motor-cw"  onclick="schemRunMotor2('CW')"  style="border-color:rgba(245,158,11,0.5);background:rgba(245,158,11,0.1);color:#f59e0b;">▶ CW</button>
        <button class="s-btn s-btn-off" id="sob-motor-ccw" onclick="schemRunMotor2('CCW')" style="border-color:rgba(245,158,11,0.5);background:rgba(245,158,11,0.08);color:#f59e0b;">◀ CCW</button>
      </div>
      <span class="s-state-badge" id="sob-motor-badge" style="color:#f59e0b;background:rgba(245,158,11,0.1);border-color:rgba(245,158,11,0.25);">● IDLE</span>
    </div>
  </div>
</div>

        <div class="schem2-legend">
          <span><div class="lw lw-blue"></div> Signal / Serial (ESP32)</span>
          <span><div class="lw lw-green"></div> Actuator control</span>
          <span><div class="lw lw-red"></div> 12V power</span>
          <span><div class="lw lw-gray"></div> Common GND</span>
          <span style="margin-left:auto;color:var(--muted);font-size:10px;">⚠ Switch to Manual in Actuators page to enable controls</span>
        </div>
      </div>

    </div><!-- /section-schematic -->

    <script>
    // Hook into existing pollWater to also update schematic v2
    const _origUpdateSchematic = typeof updateSchematic === 'function' ? updateSchematic : null;

    function updateSchematic2(waterStatus, detectionStatus) {
      if (!waterStatus) return;
      const s = waterStatus;
      const esp = !!s.connected;

      // ESP32 dot
      const dot2 = document.getElementById('schem-esp32-dot');
      const lbl2 = document.getElementById('schemEsp32Status2');
      if (dot2) dot2.setAttribute('opacity', esp ? '1' : '0.25');
      if (lbl2) { lbl2.textContent = esp ? 'Online' : 'Offline'; lbl2.setAttribute('fill', esp ? '#22c55e' : '#ef4444'); }

      // Sensor values
      const nh3El2 = document.getElementById('schem-nh3');
      const tmpEl2 = document.getElementById('schem-temp');
      const trbEl2 = document.getElementById('schem-turb');
      const flwEl2 = document.getElementById('schem-flow');
      if (nh3El2) nh3El2.textContent = s.ammonia_raw !== null ? s.ammonia_raw + ' raw' : '-- raw';
      if (tmpEl2) tmpEl2.textContent = s.temperature_c !== null ? parseFloat(s.temperature_c).toFixed(1) + ' °C' : '-- °C';
      if (trbEl2) trbEl2.textContent = s.turbidity_ntu !== null ? s.turbidity_ntu + ' NTU' : '-- NTU';
      if (flwEl2) flwEl2.textContent = s.flow_lpm !== null ? parseFloat(s.flow_lpm).toFixed(2) + ' L/min' : '-- L/min';

      // Camera badge
      const camB2 = document.getElementById('schemCamBadge2');
      if (camB2 && detectionStatus) {
        if (detectionStatus.scanning) { camB2.textContent = '⟳ SCANNING'; camB2.setAttribute('fill', '#3b82f6'); }
        else if (detectionStatus.detected) { camB2.textContent = '🦞 DETECTED'; camB2.setAttribute('fill', '#22c55e'); }
        else { camB2.textContent = '◌ IDLE'; camB2.setAttribute('fill', '#f59e0b'); }
      }

      // Actuator states
      const pumpOn2   = (s.pump_state||'').toUpperCase()==='ON';
      const uvOn2     = (s.uv_state||'').toUpperCase()==='ON';
      const valveOn2  = (s.valve_state||'').toUpperCase()==='OPEN';
      const peltOn2   = (s.peltier_state||'').toUpperCase()==='ON';

      function setSchem2Act(stateId, borderId, on, onTxt, offTxt, onColor, offColor, borderOnColor, borderOffColor) {
        const stEl = document.getElementById(stateId);
        const bEl  = document.getElementById(borderId);
        if (stEl) { stEl.textContent = esp ? (on ? '● '+onTxt : '● '+offTxt) : '● Offline'; stEl.setAttribute('fill', esp && on ? onColor : (esp ? offColor : '#ef4444')); }
        if (bEl)  { bEl.setAttribute('stroke', esp && on ? borderOnColor : borderOffColor); bEl.setAttribute('stroke-width', esp && on ? '2.5' : '1.5'); }
      }
      setSchem2Act('schem2-uv-state',     'act-border-uv',     uvOn2,   'ON','OFF',   '#a78bfa','#64748b','#a78bfa','#4c1d95');
      setSchem2Act('schem2-pump-state',   'act-border-pump',   pumpOn2, 'ON','OFF',   '#3b82f6','#64748b','#3b82f6','#1e3a5f');
      setSchem2Act('schem2-valve-state',  'act-border-valve',  valveOn2,'OPEN','CLOSED','#22c55e','#64748b','#22c55e','#374151');
      setSchem2Act('schem2-peltier-state','act-border-peltier',peltOn2, 'ON','OFF',   '#06b6d4','#64748b','#06b6d4','#0e4a5e');

      // Relay LEDs
      const ledStates = [uvOn2, pumpOn2, valveOn2, peltOn2];
      const ledColors = ['#a78bfa', '#3b82f6', '#22c55e', '#06b6d4'];
      [1,2,3,4].forEach((i) => {
        const led = document.getElementById('relay-led' + i);
        const ch  = document.getElementById('relay-ch' + i + '-schem');
        if (led) led.setAttribute('fill', esp && ledStates[i-1] ? ledColors[i-1] : '#374151');
        if (ch)  ch.setAttribute('stroke', esp && ledStates[i-1] ? ledColors[i-1] : '#3b82f6');
      });

      // Overlay button state badges
      function setSobBadge(badgeId, on, onTxt, offTxt, onColor, offColor) {
        const el = document.getElementById(badgeId);
        if (!el) return;
        el.textContent = esp ? (on ? '● '+onTxt : '● '+offTxt) : '● Offline';
        el.style.color = esp && on ? onColor : (esp ? offColor : '#ef4444');
      }
      setSobBadge('sob-uv-badge',    uvOn2,   'ON',    'OFF',    '#a78bfa', '#64748b');
      setSobBadge('sob-pump-badge',  pumpOn2, 'ON',    'OFF',    '#3b82f6', '#64748b');
      setSobBadge('sob-valve-badge', valveOn2,'OPEN',  'CLOSED', '#22c55e', '#64748b');
      setSobBadge('sob-pelt-badge',  peltOn2, 'ON',    'OFF',    '#06b6d4', '#64748b');

      // Enable/disable overlay buttons based on mode
      document.querySelectorAll('.schem-manual-btn').forEach(b => { b.disabled = currentAutoMode; });

      // Mode badge
      const mb2   = document.getElementById('schemModeBadge2');
      const note2 = document.getElementById('schemModeNote2');
      if (mb2) {
        mb2.textContent = currentAutoMode ? '🤖 AUTOMATED' : '🕹️ MANUAL';
        mb2.style.color = currentAutoMode ? 'var(--accent2)' : 'var(--warn)';
        mb2.style.background = currentAutoMode ? 'rgba(0,179,126,0.1)' : 'rgba(245,158,11,0.1)';
        mb2.style.borderColor = currentAutoMode ? 'rgba(0,179,126,0.3)' : 'rgba(245,158,11,0.3)';
      }
      if (note2) note2.textContent = currentAutoMode ? '🤖 Automated — sensors control actuators' : '🕹️ Manual — dashboard has full control';
    }

    async function schemRunMotor2(dir) {
      const badge = document.getElementById('sob-motor-badge');
      const cwBtn  = document.getElementById('sob-motor-cw');
      const ccwBtn = document.getElementById('sob-motor-ccw');
      if (cwBtn) cwBtn.disabled = true;
      if (ccwBtn) ccwBtn.disabled = true;
      if (badge) { badge.textContent = '● Running…'; badge.style.color = '#fbbf24'; }
      try {
        const res = await fetch(API_BASE + '/api/motor/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ steps: 200, direction: dir })
        });
        const data = await res.json();
        if (data.ok) {
          if (badge) { badge.textContent = '● Done ✓'; badge.style.color = '#22c55e'; }
          showToast('⚙ Motor: 200 steps ' + dir, 'success', 2500);
        }
      } catch(_) {
        if (badge) { badge.textContent = '● Error'; badge.style.color = '#ef4444'; }
      } finally {
        setTimeout(() => {
          if (cwBtn)  cwBtn.disabled  = false;
          if (ccwBtn) ccwBtn.disabled = false;
          if (badge)  { badge.textContent = '● IDLE'; badge.style.color = '#f59e0b'; }
        }, 2500);
      }
    }

    // Patch the existing pollWater to also call updateSchematic2
    const _origPollWater = pollWater;
    // Instead, override updateSchematic to also call v2
    const _origUpdateSchematicFn = window.updateSchematic;
    window.updateSchematic = function(waterStatus, detectionStatus) {
      if (_origUpdateSchematicFn) _origUpdateSchematicFn(waterStatus, detectionStatus);
      updateSchematic2(waterStatus, detectionStatus);
    };
    </script>

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
  const pageTitles = {
    livefeed:'Live Feed', sensors:'Water Sensors', actuators:'Actuators',
    schedule:'Feeding Schedule', motorzones:'Motor Zones', alerts:'Alerts', eventlog:'Event Log',
    schematic:'Schematic View'
  };
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

      // Sync mode state if server reports it
      if (typeof s.auto_mode === 'boolean') applyModeUI(s.auto_mode);

      const dot=document.getElementById('esp32Dot');
      const stEl=document.getElementById('esp32State');
      dot.className='conn-dot '+(esp32Connected?'online':'offline');
      stEl.textContent=esp32Connected?'Online':'Offline';
      stEl.style.color=esp32Connected?'var(--accent2)':'var(--danger)';

      const b1=document.getElementById('noConnBanner');
      const b2=document.getElementById('noConnBanner2');
      if(b1) b1.className='no-conn-banner'+(esp32Connected?'':' visible');
      if(b2) b2.className='no-conn-banner'+(esp32Connected?'':' visible');

      const nh3=s.ammonia_raw, tmp=s.temperature_c, trb=s.turbidity_ntu, flw=s.flow_lpm;

      document.getElementById('m-ammonia').textContent   = nh3!==null?nh3:'--';
      document.getElementById('m-temp').textContent      = tmp!==null?parseFloat(tmp).toFixed(1):'--';
      document.getElementById('m-turbidity').textContent = trb!==null?trb:'--';
      document.getElementById('m-flow').textContent      = flw!==null?parseFloat(flw).toFixed(2):'--';

      function setBadge(id, val, ok, warn, badTxt, warnTxt, okTxt, noDataTxt='— No data') {
        const el=document.getElementById(id);
        if (val===null||val===undefined||!esp32Connected) { el.className='metric-badge off'; el.textContent=noDataTxt; return; }
        if (val>warn)    { el.className='metric-badge bad';  el.textContent='⚠ '+badTxt; }
        else if (val>ok) { el.className='metric-badge warn'; el.textContent='⚡ '+warnTxt; }
        else              { el.className='metric-badge ok';   el.textContent='✓ '+okTxt; }
      }
      setBadge('m-ammonia-badge',  nh3, 5000, 5000, 'CRITICAL', 'WARNING — High', 'Normal — LOW');
      setBadge('m-temp-badge',     tmp, 28,   28,   'TOO HOT',  'WARNING — Warm',     'Within range — '+parseFloat(tmp||0).toFixed(1)+'°C');
      setBadge('m-turbidity-badge',trb, 2000, 2000, 'CLOUDY',   'Slightly cloudy',    'Clear');

      const flwEl=document.getElementById('m-flow-badge');
      if (!esp32Connected||flw===null) { flwEl.className='metric-badge off'; flwEl.textContent='— No data'; }
      else if ((s.valve_state||'').toUpperCase()==='OPEN') { flwEl.className='metric-badge ok'; flwEl.textContent='✓ Valve open'; }
      else if (flw>0) { flwEl.className='metric-badge ok'; flwEl.textContent='✓ Flowing'; }
      else { flwEl.className='metric-badge warn'; flwEl.textContent='⚡ No flow'; }

      document.getElementById('s-ammonia-raw').textContent    = nh3!==null?nh3+' raw':'-- (no data)';
      document.getElementById('s-ammonia-status').textContent  = !esp32Connected?'ESP32 offline':nh3>5500?'CRITICAL':nh3>5000?'WARNING — High':'Normal — LOW';
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
      updateSchematic(s, { scanning: isScanningState, detected: isDetected });
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

  // ── MODE MANAGEMENT ───────────────────────────────────────────────────────
  let currentAutoMode = true;

  function applyModeUI(isAuto) {
    if (currentAutoMode === isAuto) return; // no-op if unchanged
    currentAutoMode = isAuto;

    const banner    = document.getElementById('modeBanner');
    const icon      = document.getElementById('modeBannerIcon');
    const title     = document.getElementById('modeBannerTitle');
    const desc      = document.getElementById('modeBannerDesc');
    const btn       = document.getElementById('modeSwitchBtn');
    const badge     = document.getElementById('modeBadgeHeader');
    const grid      = document.getElementById('actuatorGrid');
    const modeDisp  = document.getElementById('act-mode-display');
    const topPill   = document.getElementById('topbarModePill');
    const topIcon   = document.getElementById('topbarModeIcon');
    const topLabel  = document.getElementById('topbarModeLabel');

    if (isAuto) {
      banner.className = 'mode-banner auto';
      icon.textContent  = '🤖';
      title.textContent = 'Automated Mode';
      desc.textContent  = 'Actuators are fully controlled by ESP32 sensor readings. Manual buttons are locked — switch to Manual to override.';
      btn.className     = 'mode-switch-btn to-manual';
      btn.textContent   = '⚡ Switch to Manual';
      badge.style.background  = 'rgba(0,179,126,0.1)';
      badge.style.color       = 'var(--accent2)';
      badge.style.borderColor = 'rgba(0,179,126,0.3)';
      badge.textContent       = '🤖 AUTOMATED';
      grid.classList.add('locked');
      if (modeDisp) { modeDisp.textContent = 'Automated'; modeDisp.style.color = 'var(--accent2)'; }
      topPill.className  = 'mode-pill';
      topIcon.textContent  = '🤖';
      topLabel.textContent = 'Auto';
    } else {
      banner.className = 'mode-banner manual';
      icon.textContent  = '🕹️';
      title.textContent = 'Manual Mode';
      desc.textContent  = 'You have full control over all actuators. ESP32 sensor-driven automation is suspended for overridden devices.';
      btn.className     = 'mode-switch-btn to-auto';
      btn.textContent   = '🤖 Restore Automation';
      badge.style.background  = 'rgba(245,158,11,0.1)';
      badge.style.color       = 'var(--warn)';
      badge.style.borderColor = 'rgba(245,158,11,0.35)';
      badge.textContent       = '🕹️ MANUAL';
      grid.classList.remove('locked');
      if (modeDisp) { modeDisp.textContent = 'Manual Override'; modeDisp.style.color = 'var(--warn)'; }
      topPill.className  = 'mode-pill manual';
      topIcon.textContent  = '🕹️';
      topLabel.textContent = 'Manual';
    }

    // Enable / disable manual-btn elements
    document.querySelectorAll('.manual-btn').forEach(btn => {
      btn.disabled = isAuto;
    });
  }

  async function toggleMode() {
    const btn = document.getElementById('modeSwitchBtn');
    btn.disabled = true;
    try {
      const res  = await fetch(\`\${API_BASE}/api/water/mode\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_mode: !currentAutoMode })
      });
      const data = await res.json();
      if (data.ok) {
        // Force re-apply even if same value
        const prev = currentAutoMode;
        currentAutoMode = !data.auto_mode; // flip so applyModeUI sees a change
        applyModeUI(data.auto_mode);
        const msg = data.auto_mode
          ? '🤖 Automated mode restored — ESP32 sensors back in control'
          : '🕹️ Manual mode active — you have full control';
        addLog(msg, data.auto_mode ? 'ok' : 'warn');
        showToast(msg, data.auto_mode ? 'success' : 'warning', 4000);
      }
    } catch (e) {
      showToast('Mode switch failed — check connection', 'error', 3500);
    } finally {
      btn.disabled = false;
    }
  }

  async function fetchMode() {
    try {
      const res  = await fetch(\`\${API_BASE}/api/water/mode\`);
      const data = await res.json();
      currentAutoMode = !data.auto_mode; // prime for applyModeUI diff check
      applyModeUI(!!data.auto_mode);
    } catch (_) {}
  }

  // ── Water control ─────────────────────────────────────────────────────────
  async function sendControl(action) {
    const isResetCmd = action.toLowerCase().startsWith('reset');

    // Block non-reset actuator commands if currently in auto mode
    if (currentAutoMode && !isResetCmd) {
      showToast('⚠️ Switch to Manual mode first', 'warning', 3500);
      // Briefly flash the banner to draw attention
      const banner = document.getElementById('modeBanner');
      banner.style.outline = '2px solid var(--warn)';
      setTimeout(() => { banner.style.outline = ''; }, 1200);
      return;
    }

    try {
      const res = await fetch(\`\${API_BASE}/api/water/control\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const data = await res.json();
      if (!data.ok) {
       showToast('Server blocked: ' + (data.error || action), 'error', 3500);
      const cmdLogEl2 = document.getElementById('schemCmdLog');
      if (cmdLogEl2) {
        const t = new Date().toTimeString().slice(0,8);
        const entry = document.createElement('div');
        entry.innerHTML = '<span style="color:#3b82f6;opacity:0.7">' + t + '</span>  <span style="color:#ef4444;">✕</span>  <span style="color:#fca5a5;">BLOCKED: ' + action + '</span>';
        if (cmdLogEl2.querySelector('span[style*="334155"]')) cmdLogEl2.innerHTML = '';
        cmdLogEl2.appendChild(entry);
        cmdLogEl2.scrollTop = cmdLogEl2.scrollHeight;
      }
      return;
      }
      addLog('⚙ Control: ' + action, 'ok');
      showToast('⚙ Sent: ' + action, 'success', 2500);
      // Also log to schematic command log
      const cmdLogEl = document.getElementById('schemCmdLog');
      if (cmdLogEl) {
        const t = new Date().toTimeString().slice(0,8);
        const entry = document.createElement('div');
        entry.innerHTML = '<span style="color:#3b82f6;opacity:0.7">' + t + '</span>  <span style="color:#22c55e;">⚙</span>  <span style="color:#e2e8f0;">' + action + '</span>';
        // Clear placeholder if present
        if (cmdLogEl.querySelector('span[style*="334155"]')) cmdLogEl.innerHTML = '';
        cmdLogEl.appendChild(entry);
        cmdLogEl.scrollTop = cmdLogEl.scrollHeight;
      }
      setTimeout(pollWater, 800);
    } catch (_) {
      showToast('Command failed — check connection', 'error', 3000);
    }
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

  // ── Schematic View sync ───────────────────────────────────────────────────
  function updateSchematic(waterStatus, detectionStatus) {
    if (!waterStatus) return;
    const s = waterStatus;
    const esp = !!s.connected;

    // ESP32 status badge
    const espBadge = document.getElementById('schemEsp32Status');
    if (espBadge) {
      espBadge.textContent = esp ? '● Online' : '● Offline';
      espBadge.style.background = esp ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.15)';
      espBadge.style.color = esp ? '#86efac' : '#fca5a5';
      espBadge.style.borderColor = esp ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)';
    }

    // Sensor values
    const nh3 = s.ammonia_raw, tmp = s.temperature_c, trb = s.turbidity_ntu, flw = s.flow_lpm;
    const nd = el => { if(el){el.textContent='No data'; el.className='sensor-node-status off';} };

    const nh3El = document.getElementById('schem-nh3');
    const nh3St = document.getElementById('schem-nh3-status');
    if (nh3El) nh3El.textContent = nh3 !== null ? nh3 + ' raw' : '-- raw';
    if (nh3St) {
      if (!esp || nh3 === null) { nh3St.textContent='No data'; nh3St.className='sensor-node-status off'; }
      else if (nh3 > 5500) { nh3St.textContent='⚠ CRITICAL'; nh3St.className='sensor-node-status bad'; }
      else if (nh3 > 5000) { nh3St.textContent='⚡ WARNING'; nh3St.className='sensor-node-status warn'; }
      else { nh3St.textContent='✓ Normal'; nh3St.className='sensor-node-status ok'; }
    }

    const tmpEl = document.getElementById('schem-temp');
    const tmpSt = document.getElementById('schem-temp-status');
    if (tmpEl) tmpEl.textContent = tmp !== null ? parseFloat(tmp).toFixed(1) + ' °C' : '-- °C';
    if (tmpSt) {
      if (!esp || tmp === null) { tmpSt.textContent='No data'; tmpSt.className='sensor-node-status off'; }
      else if (tmp > 30) { tmpSt.textContent='⚠ TOO HOT'; tmpSt.className='sensor-node-status bad'; }
      else if (tmp > 28) { tmpSt.textContent='⚡ WARM'; tmpSt.className='sensor-node-status warn'; }
      else { tmpSt.textContent='✓ Normal'; tmpSt.className='sensor-node-status ok'; }
    }

    const trbEl = document.getElementById('schem-turb');
    const trbSt = document.getElementById('schem-turb-status');
    if (trbEl) trbEl.textContent = trb !== null ? trb + ' NTU' : '-- NTU';
    if (trbSt) {
      if (!esp || trb === null) { trbSt.textContent='No data'; trbSt.className='sensor-node-status off'; }
      else if (trb > 2500) { trbSt.textContent='⚠ CLOUDY'; trbSt.className='sensor-node-status bad'; }
      else if (trb > 2000) { trbSt.textContent='⚡ Slightly cloudy'; trbSt.className='sensor-node-status warn'; }
      else { trbSt.textContent='✓ Clear'; trbSt.className='sensor-node-status ok'; }
    }

    const flwEl = document.getElementById('schem-flow');
    const flwSt = document.getElementById('schem-flow-status');
    if (flwEl) flwEl.textContent = flw !== null ? parseFloat(flw).toFixed(2) + ' L/min' : '-- L/min';
    if (flwSt) {
      if (!esp || flw === null) { flwSt.textContent='No data'; flwSt.className='sensor-node-status off'; }
      else if (flw > 0) { flwSt.textContent='✓ Flowing'; flwSt.className='sensor-node-status ok'; }
      else { flwSt.textContent='⚡ No flow'; flwSt.className='sensor-node-status warn'; }
    }

    // Camera / detection status
    const camBadge = document.getElementById('schemCamBadge');
    if (camBadge && detectionStatus) {
      if (detectionStatus.scanning) { camBadge.textContent='⟳ SCANNING'; camBadge.className='cam-status-badge scanning'; }
      else if (detectionStatus.detected) { camBadge.textContent='🦞 CRAYFISH DETECTED'; camBadge.className='cam-status-badge detected'; }
      else { camBadge.textContent='◌ No crayfish'; camBadge.className='cam-status-badge idle'; }
    }

    // Actuator states
    const pumpOn   = (s.pump_state||'').toUpperCase()==='ON';
    const uvOn     = (s.uv_state||'').toUpperCase()==='ON';
    const valveOn  = (s.valve_state||'').toUpperCase()==='OPEN';
    const peltOn   = (s.peltier_state||'').toUpperCase()==='ON';

    function setActNode(cardId, stateId, on, onTxt, offTxt) {
      const card  = document.getElementById(cardId);
      const state = document.getElementById(stateId);
      if (card) card.className = 'actuator-node' + (esp && on ? ' is-on' : '');
      if (state) {
        state.textContent = esp ? (on ? '● '+onTxt : '● '+offTxt) : '● Offline';
        state.className   = 'actuator-node-state ' + (esp && on ? 'on' : 'off');
      }
    }
    setActNode('schem-act-uv',     'schem-uv-state',     uvOn,   'ON',   'OFF');
    setActNode('schem-act-pump',   'schem-pump-state',   pumpOn, 'ON',   'OFF');
    setActNode('schem-act-valve',  'schem-valve-state',  valveOn,'OPEN', 'CLOSED');
    setActNode('schem-act-peltier','schem-peltier-state',peltOn, 'ON',   'OFF');

    // Relay channel highlights
    const rch = [
      { id:'relay-ch1', on: uvOn   },
      { id:'relay-ch2', on: pumpOn },
      { id:'relay-ch3', on: valveOn},
      { id:'relay-ch4', on: peltOn }
    ];
    rch.forEach(r => {
      const el = document.getElementById(r.id);
      if (el) el.className = 'relay-ch' + (esp && r.on ? ' active' : '');
    });

    // Mode badge + note
    const mb   = document.getElementById('schemModeBadge');
    const note = document.getElementById('schemModeNote');
    if (mb) {
      if (currentAutoMode) {
        mb.textContent='🤖 AUTOMATED'; mb.style.color='var(--accent2)';
        mb.style.background='rgba(0,179,126,0.1)'; mb.style.borderColor='rgba(0,179,126,0.3)';
      } else {
        mb.textContent='🕹️ MANUAL'; mb.style.color='var(--warn)';
        mb.style.background='rgba(245,158,11,0.1)'; mb.style.borderColor='rgba(245,158,11,0.3)';
      }
    }
    if (note) note.textContent = currentAutoMode
      ? '🤖 Automated — sensors control actuators'
      : '🕹️ Manual — dashboard has full control';

    // Enable/disable schem actuator buttons based on mode
    document.querySelectorAll('.schem-manual-btn').forEach(b => { b.disabled = currentAutoMode; });
  }

  // Schematic control (proxies to main sendControl)
  function schemControl(action) { sendControl(action); }

  async function schemRunMotor(dir) {
    const stEl = document.getElementById('schem-motor-state');
    if (stEl) { stEl.textContent='● Running…'; stEl.className='actuator-node-state warn'; }
    try {
      const res  = await fetch(\`\${API_BASE}/api/motor/run\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({steps:200,direction:dir})});
      const data = await res.json();
      if (data.ok) {
        if (stEl) { stEl.textContent='● Done ✓'; stEl.className='actuator-node-state on'; }
        showToast(\`⚙ Motor: 200 steps \${dir}\`,'success',2500);
        setTimeout(()=>{ if(stEl){stEl.textContent='● IDLE';stEl.className='actuator-node-state off';} },2500);
      }
    } catch(_) { if(stEl){stEl.textContent='● Error';stEl.className='actuator-node-state bad';} }
  }

  // ── FPS / Clock ───────────────────────────────────────────────────────────
  setInterval(()=>{ document.getElementById('fpsBadge').textContent=fpsCounter+' FPS'; fpsCounter=0; },1000);
  setInterval(()=>{ document.getElementById('camTime').textContent=new Date().toTimeString().slice(0,8); },1000);

  // ── Boot ──────────────────────────────────────────────────────────────────
  addLog('System initializing…','');
  const saved=localStorage.getItem('tunnel_url')||'';
  if (saved) document.getElementById('tunnelInput').value=saved;

  fetchDetectionState();
  fetchMode();           // load current auto/manual mode from server
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
        data.zone_boundary    = cfg.motor_zone_boundary || 320;
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